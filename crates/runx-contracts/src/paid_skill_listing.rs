//! Public, rail-neutral marketplace offer and listing contracts.
//!
//! Author terms describe commercial requirements for an ordinary skill runner.
//! Registry listings bind those terms to immutable package identity and an
//! authenticated seller. Protocol adapters, provider payloads, credentials,
//! headers, settlement, and SDKs remain outside this inert V1 boundary.

use std::collections::BTreeMap;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::paid_invocation::{
    CurrencyCode, MediatedReceiptClass, MediationEndpointUrl, MediationListingRef,
    OfferRevisionRef, PaidInvocationMediation, PortableAmountMinor, PrincipalReference,
    SettlementFamilies, SettlementFamily, Sha256Digest,
};
use crate::schema::{NonEmptyString, RunxSchema};

pub const PAID_SKILL_LISTING_SCHEMA: &str = "runx.marketplace.paid_skill_listing.v1";

/// Provider-neutral commercial terms authored for one ordinary skill runner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaidSkillOfferTerms {
    pub amount_minor: PortableAmountMinor,
    pub currency: CurrencyCode,
    pub accepted_settlement_families: SettlementFamilies,
    pub input_schema_digest: Sha256Digest,
    pub output_schema_digest: Sha256Digest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mediation: Option<PaidSkillMediationTerms>,
}

/// Seller-authored endpoint terms. Registry identity supplies `listing_ref`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaidSkillMediationTerms {
    pub endpoint_url: MediationEndpointUrl,
    pub vendor_amount_minor: PortableAmountMinor,
    pub platform_fee_minor: PortableAmountMinor,
    pub currency: CurrencyCode,
    pub settlement_family: SettlementFamily,
    pub expected_receipt_class: MediatedReceiptClass,
}

/// One immutable, registry-resolved runner offer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaidSkillRunnerOffer {
    pub offer_revision: OfferRevisionRef,
    pub amount_minor: PortableAmountMinor,
    pub currency: CurrencyCode,
    pub accepted_settlement_families: SettlementFamilies,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mediation: Option<PaidInvocationMediation>,
}

impl PaidSkillRunnerOffer {
    pub fn from_terms(
        offer_revision: OfferRevisionRef,
        listing_ref: MediationListingRef,
        terms: &PaidSkillOfferTerms,
    ) -> Option<Self> {
        let mediation = terms
            .mediation
            .as_ref()
            .map(|mediation| PaidInvocationMediation {
                listing_ref,
                endpoint_url: mediation.endpoint_url.clone(),
                vendor_amount_minor: mediation.vendor_amount_minor,
                platform_fee_minor: mediation.platform_fee_minor,
                currency: mediation.currency.clone(),
                settlement_family: mediation.settlement_family.clone(),
                expected_receipt_class: mediation.expected_receipt_class,
            });
        if let Some(mediation) = &mediation {
            let total = mediation
                .vendor_amount_minor
                .get()
                .checked_add(mediation.platform_fee_minor.get())?;
            if total != terms.amount_minor.get()
                || mediation.currency != terms.currency
                || !terms
                    .accepted_settlement_families
                    .as_slice()
                    .contains(&mediation.settlement_family)
            {
                return None;
            }
        }
        Some(Self {
            offer_revision,
            amount_minor: terms.amount_minor,
            currency: terms.currency.clone(),
            accepted_settlement_families: terms.accepted_settlement_families.clone(),
            mediation,
        })
    }
}

/// One to sixty-four runner offers keyed by unique runner identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct PaidSkillOffers(BTreeMap<String, PaidSkillRunnerOffer>);

impl PaidSkillOffers {
    pub fn new(value: BTreeMap<String, PaidSkillRunnerOffer>) -> Option<Self> {
        let valid_names = value.keys().all(|runner| !runner.is_empty());
        (valid_names && (1..=64).contains(&value.len())).then_some(Self(value))
    }

    pub fn as_map(&self) -> &BTreeMap<String, PaidSkillRunnerOffer> {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PaidSkillOffers {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = BTreeMap::<String, PaidSkillRunnerOffer>::deserialize(deserializer)?;
        Self::new(value).ok_or_else(|| {
            de::Error::custom("paid skill offers must contain 1..=64 non-empty runner names")
        })
    }
}

impl RunxSchema for PaidSkillOffers {
    fn json_schema() -> Value {
        json!({
            "type": "object",
            "additionalProperties": PaidSkillRunnerOffer::json_schema(),
            "propertyNames": { "minLength": 1 },
            "minProperties": 1,
            "maxProperties": 64,
        })
    }
}

/// Immutable marketplace identity and commercial terms for paid runners in one
/// published skill version. Seller identity is resolved by the authenticated
/// registry boundary and is never accepted from `X.yaml`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.marketplace.paid_skill_listing.v1")]
pub struct PaidSkillListing {
    pub skill_id: NonEmptyString,
    pub version: NonEmptyString,
    pub skill_digest: Sha256Digest,
    pub profile_digest: Sha256Digest,
    pub package_digest: Sha256Digest,
    pub vendor_ref: PrincipalReference,
    pub offers: PaidSkillOffers,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paid_skill_listing_accepts_multiple_rails_without_rail_shapes()
    -> Result<(), serde_json::Error> {
        let listing: PaidSkillListing = serde_json::from_value(json!({
            "skill_id": "acme/transcribe",
            "version": "1.0.0",
            "skill_digest": format!("sha256:{}", "a".repeat(64)),
            "profile_digest": format!("sha256:{}", "b".repeat(64)),
            "package_digest": format!("sha256:{}", "c".repeat(64)),
            "vendor_ref": {"type": "principal", "uri": "runx:principal:acme"},
            "offers": {"transcribe": {
                "offer_revision": {
                    "offer_id": "acme/transcribe#transcribe",
                    "revision": "1.0.0",
                    "revision_digest": format!("sha256:{}", "b".repeat(64)),
                    "input_schema_digest": format!("sha256:{}", "d".repeat(64)),
                    "output_schema_digest": format!("sha256:{}", "e".repeat(64))
                },
                "amount_minor": 125,
                "currency": "USD",
                "accepted_settlement_families": ["rail-a", "rail-b"]
            }}
        }))?;
        assert_eq!(
            listing.offers.as_map()["transcribe"].amount_minor.get(),
            125
        );

        let schema = PaidSkillListing::json_schema().to_string();
        assert!(!schema.contains("PAYMENT-REQUIRED"));
        assert!(!schema.contains("facilitator"));
        Ok(())
    }

    #[test]
    fn paid_skill_listing_rejects_empty_runner_identity() {
        let offer = json!({
            "offer_revision": {
                "offer_id": "acme/transcribe#transcribe",
                "revision": "1.0.0",
                "revision_digest": format!("sha256:{}", "b".repeat(64)),
                "input_schema_digest": format!("sha256:{}", "d".repeat(64)),
                "output_schema_digest": format!("sha256:{}", "e".repeat(64))
            },
            "amount_minor": 125,
            "currency": "USD",
            "accepted_settlement_families": ["rail-a"]
        });
        let result = serde_json::from_value::<PaidSkillListing>(json!({
            "skill_id": "acme/transcribe",
            "version": "1.0.0",
            "skill_digest": format!("sha256:{}", "a".repeat(64)),
            "profile_digest": format!("sha256:{}", "b".repeat(64)),
            "package_digest": format!("sha256:{}", "c".repeat(64)),
            "vendor_ref": {"type": "principal", "uri": "runx:principal:acme"},
            "offers": {"": offer}
        }));
        assert!(result.is_err());
    }

    #[test]
    fn mediated_offer_binds_listing_and_rejects_commercial_drift()
    -> Result<(), Box<dyn std::error::Error>> {
        let terms: PaidSkillOfferTerms = serde_json::from_value(json!({
            "amount_minor": 125,
            "currency": "USD",
            "accepted_settlement_families": ["x402"],
            "input_schema_digest": format!("sha256:{}", "d".repeat(64)),
            "output_schema_digest": format!("sha256:{}", "e".repeat(64)),
            "mediation": {
                "endpoint_url": "https://vendor.example/v1/invocations",
                "vendor_amount_minor": 100,
                "platform_fee_minor": 25,
                "currency": "USD",
                "settlement_family": "x402",
                "expected_receipt_class": "executed"
            }
        }))?;
        let revision: OfferRevisionRef = serde_json::from_value(json!({
            "offer_id": "acme/transcribe#transcribe",
            "revision": "1.0.0",
            "revision_digest": format!("sha256:{}", "b".repeat(64)),
            "input_schema_digest": format!("sha256:{}", "d".repeat(64)),
            "output_schema_digest": format!("sha256:{}", "e".repeat(64))
        }))?;
        let listing_ref = MediationListingRef::new("runx:listing:acme/transcribe@1.0.0#transcribe")
            .ok_or("invalid test listing ref")?;
        let offer = PaidSkillRunnerOffer::from_terms(revision.clone(), listing_ref, &terms)
            .ok_or("valid mediation was refused")?;
        assert_eq!(
            offer
                .mediation
                .as_ref()
                .map(|value| value.listing_ref.as_str()),
            Some("runx:listing:acme/transcribe@1.0.0#transcribe"),
        );

        let mut wrong_total = terms.clone();
        wrong_total.amount_minor = PortableAmountMinor::new(126).ok_or("invalid test amount")?;
        assert!(
            PaidSkillRunnerOffer::from_terms(
                revision.clone(),
                MediationListingRef::new("runx:listing:acme/transcribe@1.0.0#transcribe")
                    .ok_or("invalid test listing ref")?,
                &wrong_total,
            )
            .is_none()
        );

        let mut wrong_rail = terms;
        wrong_rail.accepted_settlement_families = serde_json::from_value(json!(["other-rail"]))?;
        assert!(
            PaidSkillRunnerOffer::from_terms(
                revision,
                MediationListingRef::new("runx:listing:acme/transcribe@1.0.0#transcribe")
                    .ok_or("invalid test listing ref")?,
                &wrong_rail,
            )
            .is_none()
        );
        Ok(())
    }
}
