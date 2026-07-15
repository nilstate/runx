use std::fs;
use std::path::PathBuf;

use runx_contracts::EffectFinalityPhase;
use runx_pay::refunds::{
    RefundAdmissionCase, RefundAdmissionDecision, RefundAdmissionInput, RefundRefusalCode,
    RefundRequest, RefundableCharge, admit_refund, verify_refund_admission_case,
};

#[test]
fn refund_admission_fixtures_match_rust_contract() -> Result<(), Box<dyn std::error::Error>> {
    for fixture_path in refund_fixture_paths()? {
        let fixture: RefundAdmissionCase =
            serde_json::from_str(&fs::read_to_string(&fixture_path)?)?;
        verify_refund_admission_case(&fixture)
            .map_err(|error| format!("{}: {error}", fixture_path.display()))?;
    }
    Ok(())
}

#[test]
fn refund_refuses_non_sealed_charge() {
    let decision = admit_refund(&RefundAdmissionInput {
        charge: refundable_charge(EffectFinalityPhase::InFlight),
        refund: RefundRequest {
            amount_minor: 125,
            requested_counterparty: None,
        },
    });

    assert!(matches!(
        decision,
        RefundAdmissionDecision::Refused { ref code, .. }
            if *code == RefundRefusalCode::ChargeNotSealed
    ));
}

#[test]
fn refund_reversal_targets_recorded_payer() {
    let charge = refundable_charge(EffectFinalityPhase::Sealed);
    let decision = admit_refund(&RefundAdmissionInput {
        refund: RefundRequest {
            amount_minor: 100,
            requested_counterparty: None,
        },
        charge: charge.clone(),
    });

    match decision {
        RefundAdmissionDecision::Admitted { reversal } => {
            assert_eq!(reversal.counterparty, charge.payer_ref);
            assert_eq!(reversal.original_proof_ref, charge.proof_ref);
        }
        other => assert!(
            matches!(other, RefundAdmissionDecision::Admitted { .. }),
            "sealed charge refund should be admitted"
        ),
    }
}

#[test]
fn reversed_wins_refund_race() {
    let decision = admit_refund(&RefundAdmissionInput {
        charge: refundable_charge(EffectFinalityPhase::Reversed),
        refund: RefundRequest {
            amount_minor: 100,
            requested_counterparty: None,
        },
    });

    assert!(matches!(
        decision,
        RefundAdmissionDecision::Refused { ref code, .. }
            if *code == RefundRefusalCode::ChargeReversed
    ));
}

fn refund_fixture_paths() -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/effect-finality/refund-admission")
        .canonicalize()?;
    let mut paths = fs::read_dir(fixture_dir)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    Ok(paths)
}

fn refundable_charge(phase: EffectFinalityPhase) -> RefundableCharge {
    RefundableCharge {
        money_movement_id: "money-movement-test".to_owned(),
        rail: "mpp-tempo".to_owned(),
        phase,
        amount_minor: 125,
        currency: "USD".to_owned(),
        payer_ref: "did:pkh:eip155:42431:0x1111111111111111111111111111111111111111".to_owned(),
        proof_ref:
            "mpp-tempo:tx:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_owned(),
    }
}
