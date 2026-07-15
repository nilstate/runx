use serde::Deserialize;

use runx_contracts::{
    ThreadOutboxProviderFetch, ThreadOutboxProviderManifest, ThreadOutboxProviderObservation,
    ThreadOutboxProviderPush,
};

use crate::fixture_support::roundtrip;

const FIXTURES: &[&str] = &[
    include_str!("../../../fixtures/contracts/thread-outbox-provider/fetch.json"),
    include_str!("../../../fixtures/contracts/thread-outbox-provider/manifest.json"),
    include_str!("../../../fixtures/contracts/thread-outbox-provider/observation.json"),
    include_str!("../../../fixtures/contracts/thread-outbox-provider/push.json"),
];

#[derive(Debug, Deserialize)]
struct Fixture {
    fixture_kind: FixtureKind,
    expected: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum FixtureKind {
    #[serde(rename = "thread_outbox_provider_fetch")]
    Fetch,
    #[serde(rename = "thread_outbox_provider_manifest")]
    Manifest,
    #[serde(rename = "thread_outbox_provider_observation")]
    Observation,
    #[serde(rename = "thread_outbox_provider_push")]
    Push,
}

#[test]
fn thread_outbox_provider_fixtures_match_wire_shapes() -> Result<(), serde_json::Error> {
    for fixture_json in FIXTURES {
        let fixture: Fixture = serde_json::from_str(fixture_json)?;
        assert_roundtrip(fixture)?;
    }
    Ok(())
}

#[test]
fn thread_outbox_provider_public_frames_reject_raw_secret_material() -> Result<(), serde_json::Error>
{
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/thread-outbox-provider/observation.json"
    ))?;
    let mut observation = fixture.expected;
    observation["access_token"] = serde_json::Value::String("super-secret-token".to_owned());

    let result = serde_json::from_value::<ThreadOutboxProviderObservation>(observation);

    assert!(result.is_err());
    Ok(())
}

#[test]
fn thread_outbox_provider_push_requires_thread_locator() -> Result<(), Box<dyn std::error::Error>> {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/thread-outbox-provider/push.json"
    ))?;
    let mut push = fixture.expected;
    remove_object_field(&mut push, "thread_locator")?;

    let result = serde_json::from_value::<ThreadOutboxProviderPush>(push);

    assert!(result.is_err());
    Ok(())
}

#[test]
fn thread_outbox_provider_fetch_requires_target() -> Result<(), Box<dyn std::error::Error>> {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/thread-outbox-provider/fetch.json"
    ))?;
    let mut fetch = fixture.expected;
    remove_object_field(&mut fetch, "target")?;

    let result = serde_json::from_value::<ThreadOutboxProviderFetch>(fetch);

    assert!(result.is_err());
    Ok(())
}

#[test]
fn thread_outbox_provider_manifest_rejects_http_transport_until_defined()
-> Result<(), serde_json::Error> {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/thread-outbox-provider/manifest.json"
    ))?;
    let mut manifest = fixture.expected;
    manifest["transport"] = serde_json::json!({
        "kind": "http",
        "endpoint": "https://example.test/thread-provider"
    });

    let result = serde_json::from_value::<ThreadOutboxProviderManifest>(manifest);

    assert!(result.is_err());
    Ok(())
}

fn assert_roundtrip(fixture: Fixture) -> Result<(), serde_json::Error> {
    match fixture.fixture_kind {
        FixtureKind::Fetch => roundtrip::<ThreadOutboxProviderFetch>(fixture.expected),
        FixtureKind::Manifest => roundtrip::<ThreadOutboxProviderManifest>(fixture.expected),
        FixtureKind::Observation => roundtrip::<ThreadOutboxProviderObservation>(fixture.expected),
        FixtureKind::Push => roundtrip::<ThreadOutboxProviderPush>(fixture.expected),
    }
}

fn remove_object_field(
    value: &mut serde_json::Value,
    key: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(object) = value.as_object_mut() else {
        return Err(format!("fixture expected object before removing `{key}`").into());
    };
    object.remove(key);
    Ok(())
}
