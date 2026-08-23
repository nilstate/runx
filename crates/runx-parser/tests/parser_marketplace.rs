use runx_parser::{SkillRunnerManifest, parse_runner_manifest_yaml, validate_runner_manifest};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn validate(yaml: &str) -> Result<SkillRunnerManifest, String> {
    let raw = parse_runner_manifest_yaml(yaml).map_err(|error| error.to_string())?;
    validate_runner_manifest(raw).map_err(|error| error.to_string())
}

fn manifest(marketplace: &str) -> String {
    format!(
        r#"
skill: transcribe
{marketplace}
runners:
  preview:
    type: cli-tool
    command: preview
  transcribe:
    default: true
    type: cli-tool
    command: transcribe
"#
    )
}

#[test]
fn marketplace_paid_and_free_runners_share_one_manifest() -> Result<(), String> {
    let parsed = validate(&manifest(&format!(
        r#"marketplace:
  offers:
    transcribe:
      amount_minor: 125
      currency: USD
      accepted_settlement_families: [x402, stripe-spt]
      input_schema_digest: {DIGEST_A}
      output_schema_digest: {DIGEST_B}"#
    )))?;
    let offers = &parsed
        .marketplace
        .ok_or_else(|| "missing marketplace".to_owned())?
        .offers;
    assert_eq!(offers.len(), 1);
    let offer = offers
        .get("transcribe")
        .ok_or_else(|| "missing paid runner".to_owned())?;
    assert_eq!(offer.amount_minor.get(), 125);
    assert_eq!(offer.currency.as_str(), "USD");
    assert_eq!(
        offer
            .accepted_settlement_families
            .as_slice()
            .iter()
            .map(|family| family.as_str())
            .collect::<Vec<_>>(),
        ["x402", "stripe-spt"]
    );
    assert!(!offers.contains_key("preview"));
    Ok(())
}

#[test]
fn missing_marketplace_keeps_all_runners_free() -> Result<(), String> {
    let parsed = validate(&manifest(""))?;
    assert!(parsed.marketplace.is_none());
    Ok(())
}

#[test]
fn marketplace_rejects_undeclared_runner_and_unknown_rail_fields() {
    let undeclared = validate(&manifest(&format!(
        r#"marketplace:
  offers:
    missing:
      amount_minor: 125
      currency: USD
      accepted_settlement_families: [x402]
      input_schema_digest: {DIGEST_A}
      output_schema_digest: {DIGEST_B}"#
    )))
    .expect_err("undeclared offer unexpectedly passed");
    assert!(undeclared.contains("references an undeclared runner"));

    let provider_shape = validate(&manifest(&format!(
        r#"marketplace:
  offers:
    transcribe:
      amount_minor: 125
      currency: USD
      accepted_settlement_families: [stripe-spt]
      input_schema_digest: {DIGEST_A}
      output_schema_digest: {DIGEST_B}
      stripe_price_id: price_private"#
    )))
    .expect_err("provider field unexpectedly passed");
    assert!(provider_shape.contains("unknown field `stripe_price_id`"));
}

#[test]
fn marketplace_rejects_ambiguous_terms() {
    for (field, value, expected) in [
        ("amount_minor", "0", "amount_minor"),
        ("currency", "usd", "currency"),
        (
            "accepted_settlement_families",
            "[x402, x402]",
            "settlement families",
        ),
    ] {
        let marketplace = format!(
            r#"marketplace:
  offers:
    transcribe:
      amount_minor: 125
      currency: USD
      accepted_settlement_families: [x402]
      input_schema_digest: {DIGEST_A}
      output_schema_digest: {DIGEST_B}"#
        )
        .replace(
            &format!(
                "{field}: {}",
                match field {
                    "amount_minor" => "125",
                    "currency" => "USD",
                    _ => "[x402]",
                }
            ),
            &format!("{field}: {value}"),
        );
        let error =
            validate(&manifest(&marketplace)).expect_err("invalid offer unexpectedly passed");
        assert!(error.contains(expected), "{error}");
    }
}
