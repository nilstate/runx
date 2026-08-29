mod assertions;
pub mod fixtures;
mod http_responses;
mod json_assertions;
#[cfg(feature = "catalog")]
mod provider_responses;
pub mod runner;

use std::collections::BTreeMap;

use runx_parser::SkillRunnerManifest;

const AMBIENT_HARNESS_AUTHORITY_ENV: &[&str] = &[
    "RUNX_AGENT_API_KEY",
    "RUNX_HOSTED_CREDENTIAL_HANDLES_JSON",
    "RUNX_PUBLIC_API_ALLOW_PRIVATE_NETWORK",
    "RUNX_PUBLIC_API_BASE_URL",
    "RUNX_PUBLIC_API_TOKEN",
];

/// Remove ambient authority and credential custody from a harness process.
/// A case may add an explicit fake binding back through its own `env`, but a
/// developer's live account state must never become implicit test input.
pub(crate) fn isolate_harness_environment<'a>(
    env: &mut BTreeMap<String, String>,
    manifests: impl IntoIterator<Item = &'a SkillRunnerManifest>,
) {
    env.retain(|name, _| !name.starts_with("RUNX_PROVIDER_PERMISSION_"));
    env.insert(
        crate::effects::PROVIDER_PERMISSION_TRANSPORT_ENV.to_owned(),
        "hosted".to_owned(),
    );
    for name in AMBIENT_HARNESS_AUTHORITY_ENV {
        env.remove(*name);
    }
    for manifest in manifests {
        for requirement in manifest.credentials.values() {
            for delivery_env in requirement.deliveries.values() {
                env.remove(delivery_env);
            }
        }
    }
}

pub use assertions::HarnessReplayReceipt;
#[cfg(feature = "cli-tool")]
pub(crate) use assertions::{assert_receipt_expectation, status_name};
pub use fixtures::{
    HarnessExpectedStatus, HarnessFixture, HarnessFixtureCase, HarnessFixtureError,
    HarnessFixtureKind, HarnessFixtureStepOracle, HarnessSetup, ReceiptExpectation, list_cases,
    load_harness_fixture,
};
pub(crate) use http_responses::effects_with_harness_http;
#[cfg(feature = "cli-tool")]
pub(crate) use json_assertions::assert_json_expectation;
#[cfg(feature = "catalog")]
pub(crate) use provider_responses::{
    HARNESS_PROVIDER_BASE_URL, HARNESS_PROVIDER_TOKEN, effects_with_harness_provider_responses,
};
pub use runner::{
    HarnessReplayError, HarnessReplayOutput, run_harness_fixture, run_harness_fixture_with_adapter,
};

#[cfg(test)]
mod environment_tests {
    use std::collections::BTreeMap;

    use runx_parser::{parse_runner_manifest_yaml, validate_runner_manifest};

    use super::isolate_harness_environment;

    #[test]
    fn harness_environment_removes_ambient_authority_and_declared_credentials()
    -> Result<(), Box<dyn std::error::Error>> {
        let raw = parse_runner_manifest_yaml(
            r#"
credentials:
  account:
    provider: example
    audience: https://example.invalid
    auth:
      bearer:
        delivery: { env: EXAMPLE_TOKEN }
runners:
  read:
    default: true
    type: javascript
    module: read.mjs
    inputs: {}
"#,
        )?;
        let manifest = validate_runner_manifest(raw)?;
        let mut env = BTreeMap::from([
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("EXAMPLE_TOKEN".to_owned(), "live-secret".to_owned()),
            (
                "RUNX_PROVIDER_PERMISSION_GRANT_ID".to_owned(),
                "live-grant".to_owned(),
            ),
            (
                "RUNX_PUBLIC_API_TOKEN".to_owned(),
                "live-cloud-token".to_owned(),
            ),
            ("RUNX_AGENT_API_KEY".to_owned(), "live-agent-key".to_owned()),
        ]);

        isolate_harness_environment(&mut env, [&manifest]);

        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert!(!env.contains_key("EXAMPLE_TOKEN"));
        assert!(!env.contains_key("RUNX_PROVIDER_PERMISSION_GRANT_ID"));
        assert_eq!(
            env.get("RUNX_PROVIDER_PERMISSION_TRANSPORT")
                .map(String::as_str),
            Some("hosted")
        );
        assert!(!env.contains_key("RUNX_PUBLIC_API_TOKEN"));
        assert!(!env.contains_key("RUNX_AGENT_API_KEY"));
        Ok(())
    }
}
