use std::collections::BTreeMap;

use super::document::EffectFamilyState;
use super::keys::run_spend_ledger_key;
use super::{
    EffectFinalityIntent, EffectPeriodSpendLedgerEntry, EffectPeriodSpendReservation,
    EffectRunSpendLedgerEntry, EffectRunSpendLedgerItem, EffectRunSpendReservation,
    EffectRunSpendStatus, EffectStateError,
};
pub(super) fn reserve_run_spend(
    state: &mut EffectFamilyState,
    family: &'static str,
    intent: &EffectFinalityIntent,
    reservation: Option<&EffectRunSpendReservation>,
) -> Result<(), EffectStateError> {
    let Some(reservation) = reservation else {
        return Ok(());
    };
    let ledger_key = run_spend_ledger_key(family, reservation, &intent.currency);
    let entry_key = intent.idempotency_key.index_key();
    let ledger = run_spend_ledger(state, &ledger_key, reservation, intent);
    validate_run_spend_ledger(ledger, reservation, &intent.currency, &ledger_key)?;
    reserve_run_spend_entry(ledger, &entry_key, intent, &ledger_key)
}

pub(super) fn reserve_period_spend(
    state: &mut EffectFamilyState,
    family: &'static str,
    intent: &EffectFinalityIntent,
    reservation: Option<&EffectPeriodSpendReservation>,
) -> Result<(), EffectStateError> {
    let Some(reservation) = reservation else {
        return Ok(());
    };
    let ledger_key = period_spend_ledger_key(family, reservation, &intent.currency);
    let entry_key = intent.idempotency_key.index_key();
    let ledger = period_spend_ledger(state, &ledger_key, reservation, intent);
    validate_period_spend_ledger(ledger, reservation, &intent.currency, &ledger_key)?;
    if !reserve_period_spend_entry(ledger, &entry_key, intent, &ledger_key)? {
        return Ok(());
    }
    prune_period_spend_ledgers(state, family, reservation, &intent.currency);
    Ok(())
}

fn run_spend_ledger<'a>(
    state: &'a mut EffectFamilyState,
    ledger_key: &str,
    reservation: &EffectRunSpendReservation,
    intent: &EffectFinalityIntent,
) -> &'a mut EffectRunSpendLedgerEntry {
    state
        .run_spend_ledger
        .entry(ledger_key.to_owned())
        .or_insert_with(|| EffectRunSpendLedgerEntry {
            run_id: reservation.run_id.clone(),
            authority_ref: reservation.authority_ref.clone(),
            currency: intent.currency.clone(),
            max_per_run_units: reservation.max_per_run_units,
            reserved_minor: 0,
            sealed_minor: 0,
            entries: BTreeMap::new(),
        })
}

fn validate_run_spend_ledger(
    ledger: &EffectRunSpendLedgerEntry,
    reservation: &EffectRunSpendReservation,
    currency: &str,
    ledger_key: &str,
) -> Result<(), EffectStateError> {
    if ledger.run_id == reservation.run_id
        && ledger.authority_ref == reservation.authority_ref
        && ledger.currency == currency
        && ledger.max_per_run_units == reservation.max_per_run_units
    {
        return Ok(());
    }
    Err(EffectStateError::RunSpendLedgerConflict {
        ledger_key: ledger_key.to_owned(),
    })
}

fn reserve_run_spend_entry(
    ledger: &mut EffectRunSpendLedgerEntry,
    entry_key: &str,
    intent: &EffectFinalityIntent,
    ledger_key: &str,
) -> Result<(), EffectStateError> {
    match ledger_entry_matches(&ledger.entries, entry_key, intent) {
        Some(true) => return Ok(()),
        Some(false) => {
            return Err(EffectStateError::RunSpendLedgerConflict {
                ledger_key: ledger_key.to_owned(),
            });
        }
        None => {}
    }
    let attempted_minor = ledger.reserved_minor.saturating_add(intent.amount_minor);
    if attempted_minor > ledger.max_per_run_units {
        return Err(EffectStateError::RunSpendCapExceeded {
            run_id: ledger.run_id.clone(),
            authority_ref: ledger.authority_ref.clone(),
            currency: ledger.currency.clone(),
            attempted_minor,
            max_per_run_units: ledger.max_per_run_units,
        });
    }
    ledger.reserved_minor = attempted_minor;
    insert_reserved_entry(&mut ledger.entries, entry_key, intent);
    Ok(())
}

fn period_spend_ledger<'a>(
    state: &'a mut EffectFamilyState,
    ledger_key: &str,
    reservation: &EffectPeriodSpendReservation,
    intent: &EffectFinalityIntent,
) -> &'a mut EffectPeriodSpendLedgerEntry {
    state
        .period_spend_ledger
        .entry(ledger_key.to_owned())
        .or_insert_with(|| EffectPeriodSpendLedgerEntry {
            authority_ref: reservation.authority_ref.clone(),
            currency: intent.currency.clone(),
            max_per_period_units: reservation.max_per_period_units,
            period: reservation.period.clone(),
            window_start: reservation.window_start.clone(),
            reserved_minor: 0,
            sealed_minor: 0,
            entries: BTreeMap::new(),
        })
}

fn validate_period_spend_ledger(
    ledger: &EffectPeriodSpendLedgerEntry,
    reservation: &EffectPeriodSpendReservation,
    currency: &str,
    ledger_key: &str,
) -> Result<(), EffectStateError> {
    if ledger.authority_ref == reservation.authority_ref
        && ledger.currency == currency
        && ledger.max_per_period_units == reservation.max_per_period_units
        && ledger.period == reservation.period
        && ledger.window_start == reservation.window_start
    {
        return Ok(());
    }
    Err(EffectStateError::PeriodSpendLedgerConflict {
        ledger_key: ledger_key.to_owned(),
    })
}

fn reserve_period_spend_entry(
    ledger: &mut EffectPeriodSpendLedgerEntry,
    entry_key: &str,
    intent: &EffectFinalityIntent,
    ledger_key: &str,
) -> Result<bool, EffectStateError> {
    match ledger_entry_matches(&ledger.entries, entry_key, intent) {
        Some(true) => return Ok(false),
        Some(false) => {
            return Err(EffectStateError::PeriodSpendLedgerConflict {
                ledger_key: ledger_key.to_owned(),
            });
        }
        None => {}
    }
    let attempted_minor = ledger.reserved_minor.saturating_add(intent.amount_minor);
    if attempted_minor > ledger.max_per_period_units {
        return Err(EffectStateError::PeriodSpendCapExceeded {
            period: ledger.period.clone(),
            window_start: ledger.window_start.clone(),
            authority_ref: ledger.authority_ref.clone(),
            currency: ledger.currency.clone(),
            attempted_minor,
            max_per_period_units: ledger.max_per_period_units,
        });
    }
    ledger.reserved_minor = attempted_minor;
    insert_reserved_entry(&mut ledger.entries, entry_key, intent);
    Ok(true)
}

fn ledger_entry_matches(
    entries: &BTreeMap<String, EffectRunSpendLedgerItem>,
    entry_key: &str,
    intent: &EffectFinalityIntent,
) -> Option<bool> {
    entries
        .get(entry_key)
        .map(|existing| existing.amount_minor == intent.amount_minor)
}

fn insert_reserved_entry(
    entries: &mut BTreeMap<String, EffectRunSpendLedgerItem>,
    entry_key: &str,
    intent: &EffectFinalityIntent,
) {
    entries.insert(
        entry_key.to_owned(),
        EffectRunSpendLedgerItem {
            idempotency_key: intent.idempotency_key.clone(),
            amount_minor: intent.amount_minor,
            status: EffectRunSpendStatus::Reserved,
            receipt_ref: None,
        },
    );
}

fn prune_period_spend_ledgers(
    state: &mut EffectFamilyState,
    family: &'static str,
    reservation: &EffectPeriodSpendReservation,
    currency: &str,
) {
    let Some(retention_floor) =
        previous_period_window_start(&reservation.period, &reservation.window_start)
    else {
        return;
    };
    let prefix = format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        family, reservation.authority_ref, currency, reservation.period
    );
    state
        .period_spend_ledger
        .retain(|key, ledger| !key.starts_with(&prefix) || ledger.window_start >= retention_floor);
}

fn previous_period_window_start(period: &str, window_start: &str) -> Option<String> {
    let (year, month, day) = parse_civil_date(window_start)?;
    match period {
        "daily" => Some(civil_date_string(days_from_civil(year, month, day) - 1)),
        "weekly" => Some(civil_date_string(days_from_civil(year, month, day) - 7)),
        "monthly" => {
            if month == 1 {
                Some(format!("{:04}-12-01", year - 1))
            } else {
                Some(format!("{year:04}-{:02}-01", month - 1))
            }
        }
        _ => None,
    }
}

fn parse_civil_date(value: &str) -> Option<(i64, u32, u32)> {
    let mut parts = value.split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

pub(super) fn period_spend_ledger_key(
    family: &'static str,
    reservation: &EffectPeriodSpendReservation,
    currency: &str,
) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        family, reservation.authority_ref, currency, reservation.period, reservation.window_start
    )
}

/// Compute the UTC calendar window a spend falls into for a declared period.
/// Periods are deliberately a closed vocabulary; an unrecognized period fails
/// closed instead of being treated as an unenforced annotation.
pub fn period_window_start(period: &str, unix_seconds: u64) -> Result<String, EffectStateError> {
    let days = (unix_seconds / 86_400) as i64;
    match period {
        "daily" => Ok(civil_date_string(days)),
        "weekly" => {
            // 1970-01-01 was a Thursday; weeks are Monday-aligned.
            let days_from_monday = (days + 3).rem_euclid(7);
            Ok(civil_date_string(days - days_from_monday))
        }
        "monthly" => {
            let (year, month, _day) = civil_from_days(days);
            Ok(format!("{year:04}-{month:02}-01"))
        }
        other => Err(EffectStateError::UnsupportedSpendPeriod {
            period: other.to_owned(),
        }),
    }
}

fn civil_date_string(days: i64) -> String {
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

// Days-from-epoch to proleptic Gregorian civil date (Howard Hinnant's
// `civil_from_days` algorithm), so the window math needs no time crate.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = i64::from(month);
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
