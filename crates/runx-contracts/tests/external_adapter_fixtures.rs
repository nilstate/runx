use serde::Deserialize;

use runx_contracts::{
    ExternalAdapterCancellationFrame, ExternalAdapterCredentialRequest,
    ExternalAdapterHostResolutionFrame, ExternalAdapterInvocation, ExternalAdapterManifest,
    ExternalAdapterResponse,
};

use crate::fixture_support::roundtrip;

const FIXTURES: &[&str] = &[
    include_str!("../../../fixtures/contracts/external-adapter/cancellation-frame.json"),
    include_str!("../../../fixtures/contracts/external-adapter/credential-request.json"),
    include_str!("../../../fixtures/contracts/external-adapter/host-resolution-frame.json"),
    include_str!("../../../fixtures/contracts/external-adapter/invocation.json"),
    include_str!("../../../fixtures/contracts/external-adapter/manifest.json"),
    include_str!("../../../fixtures/contracts/external-adapter/response.json"),
];

#[derive(Debug, Deserialize)]
struct Fixture {
    fixture_kind: FixtureKind,
    expected: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum FixtureKind {
    #[serde(rename = "external_adapter_cancellation")]
    Cancellation,
    #[serde(rename = "external_adapter_credential_request")]
    CredentialRequest,
    #[serde(rename = "external_adapter_host_resolution")]
    HostResolution,
    #[serde(rename = "external_adapter_invocation")]
    Invocation,
    #[serde(rename = "external_adapter_manifest")]
    Manifest,
    #[serde(rename = "external_adapter_response")]
    Response,
}

#[test]
fn external_adapter_fixtures_match_typescript_wire_shapes() -> Result<(), serde_json::Error> {
    for fixture_json in FIXTURES {
        let fixture: Fixture = serde_json::from_str(fixture_json)?;
        assert_roundtrip(fixture)?;
    }
    Ok(())
}

#[test]
fn external_adapter_response_rejects_legacy_runtime_local_sealed_status()
-> Result<(), serde_json::Error> {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/external-adapter/response.json"
    ))?;
    let mut response = fixture.expected;
    response["status"] = serde_json::Value::String("sealed".to_owned());

    let result = serde_json::from_value::<ExternalAdapterResponse>(response);

    assert!(result.is_err());
    Ok(())
}

fn assert_roundtrip(fixture: Fixture) -> Result<(), serde_json::Error> {
    match fixture.fixture_kind {
        FixtureKind::Cancellation => {
            roundtrip::<ExternalAdapterCancellationFrame>(fixture.expected)
        }
        FixtureKind::CredentialRequest => {
            roundtrip::<ExternalAdapterCredentialRequest>(fixture.expected)
        }
        FixtureKind::HostResolution => {
            roundtrip::<ExternalAdapterHostResolutionFrame>(fixture.expected)
        }
        FixtureKind::Invocation => roundtrip::<ExternalAdapterInvocation>(fixture.expected),
        FixtureKind::Manifest => roundtrip::<ExternalAdapterManifest>(fixture.expected),
        FixtureKind::Response => roundtrip::<ExternalAdapterResponse>(fixture.expected),
    }
}
