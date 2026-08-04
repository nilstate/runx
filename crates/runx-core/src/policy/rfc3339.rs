//! Dependency-free RFC 3339 moment parsing for grant lifetime comparison.
//!
//! Grant admission compares `checked_at`, `expires_at`, and `not_before` without
//! pulling a calendar dependency, so the parser returns a `(days, seconds, nanos)`
//! triple that orders correctly under `PartialOrd`.

/// Parse an RFC 3339 timestamp into a `(days_from_civil, seconds_of_day, nanos)`
/// triple, normalising the UTC offset. Returns `None` for any malformed input.
pub fn parse_rfc3339_moment(value: &str) -> Option<(i64, i64, u32)> {
    let (date, time_and_offset) = value.split_once('T')?;
    let (year, month, day) = parse_date(date)?;
    let (time, offset_seconds) = parse_time_and_offset(time_and_offset)?;
    let (hour, minute, second, nanos) = parse_time(time)?;
    let day_seconds = i64::from(hour)
        .checked_mul(3_600)?
        .checked_add(i64::from(minute).checked_mul(60)?)?
        .checked_add(i64::from(second))?
        .checked_sub(i64::from(offset_seconds))?;
    let days = days_from_civil(year, month, day)?.checked_add(day_seconds.div_euclid(86_400))?;
    Some((days, day_seconds.rem_euclid(86_400), nanos))
}

fn parse_date(value: &str) -> Option<(i32, u32, u32)> {
    let mut parts = value.split('-');
    let year = parts.next()?;
    let month = parts.next()?;
    let day = parts.next()?;
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return None;
    }
    let year = parse_i32(year)?;
    let month = parse_u32(month)?;
    let day = parse_u32(day)?;
    if parts.next().is_some()
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
    {
        return None;
    }
    Some((year, month, day))
}

fn parse_time_and_offset(value: &str) -> Option<(&str, i32)> {
    if let Some(time) = value.strip_suffix('Z') {
        return Some((time, 0));
    }
    let offset_index = value
        .char_indices()
        .skip(1)
        .find_map(|(index, character)| matches!(character, '+' | '-').then_some(index))?;
    let time = &value[..offset_index];
    let offset = &value[offset_index..];
    let sign = if offset.starts_with('+') { 1 } else { -1 };
    let mut parts = offset[1..].split(':');
    let hours = parts.next()?;
    let minutes = parts.next()?;
    if hours.len() != 2 || minutes.len() != 2 {
        return None;
    }
    let hours = parse_i32(hours)?;
    let minutes = parse_i32(minutes)?;
    if parts.next().is_some() || !(0..=23).contains(&hours) || !(0..=59).contains(&minutes) {
        return None;
    }
    Some((time, sign * ((hours * 3_600) + (minutes * 60))))
}

fn parse_time(value: &str) -> Option<(u32, u32, u32, u32)> {
    let mut parts = value.split(':');
    let hour = parts.next()?;
    let minute = parts.next()?;
    let seconds = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let (second_text, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    if hour.len() != 2 || minute.len() != 2 || second_text.len() != 2 {
        return None;
    }
    let hour = parse_u32(hour)?;
    let minute = parse_u32(minute)?;
    let second = parse_u32(second_text)?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some((hour, minute, second, parse_nanos(fraction)?))
}

fn parse_nanos(value: &str) -> Option<u32> {
    if value.is_empty() {
        return Some(0);
    }
    if value.len() > 9 || !value.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let mut nanos = parse_u32(value)?;
    for _ in value.len()..9 {
        nanos = nanos.checked_mul(10)?;
    }
    Some(nanos)
}

fn parse_i32(value: &str) -> Option<i32> {
    if value.is_empty() || !value.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn parse_u32(value: &str) -> Option<u32> {
    if value.is_empty() || !value.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    let year = i64::from(year) - i64::from((month <= 2) as i32);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day = i64::from(day);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era.checked_mul(146_097)?
        .checked_add(day_of_era)?
        .checked_sub(719_468)
}

#[cfg(test)]
mod tests {
    use super::parse_rfc3339_moment;

    #[test]
    fn utc_offset_normalizes_to_same_moment() {
        let utc = parse_rfc3339_moment("2026-05-22T12:00:00Z");
        let plus_two = parse_rfc3339_moment("2026-05-22T14:00:00+02:00");
        assert!(utc.is_some());
        assert_eq!(utc, plus_two);
    }

    #[test]
    fn ordering_follows_chronology() {
        let earlier = parse_rfc3339_moment("2026-05-22T11:59:59Z");
        let later = parse_rfc3339_moment("2026-05-22T12:00:00Z");
        assert!(earlier < later);
    }

    #[test]
    fn malformed_inputs_fail_closed() {
        assert!(parse_rfc3339_moment("2026-13-01T00:00:00Z").is_none());
        assert!(parse_rfc3339_moment("2026-05-22 12:00:00Z").is_none());
        assert!(parse_rfc3339_moment("not-a-timestamp").is_none());
    }
}
