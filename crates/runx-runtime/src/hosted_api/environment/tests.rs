#![allow(clippy::expect_used)]

use super::*;

#[test]
fn debug_output_never_exposes_hosted_api_tokens() {
    let resolved = HostedApiEnvironment {
        base_url: "https://api.runx.test".to_owned(),
        token: Some("rxk_super_secret".to_owned()),
        expected_principal_id: Some("operator:test".to_owned()),
        stored_credential_environment_mismatch: false,
    };
    let authenticated = AuthenticatedHostedApiEnvironment {
        base_url: "https://api.runx.test".to_owned(),
        token: "rxk_super_secret".to_owned(),
        principal_id: "operator:test".to_owned(),
    };

    assert!(!format!("{resolved:?}").contains("rxk_super_secret"));
    assert!(!format!("{authenticated:?}").contains("rxk_super_secret"));
}

#[test]
fn hosted_api_base_url_requires_https_outside_loopback() {
    let env = BTreeMap::from([(
        HOSTED_API_BASE_URL_ENV.to_owned(),
        "http://api.runx.test".to_owned(),
    )]);

    let error = HostedApiEnvironment::resolve(None, None, &env, Path::new("."))
        .expect_err("public HTTP must fail closed");

    assert!(
        error
            .to_string()
            .contains("HTTP is allowed only for loopback")
    );
}

#[test]
fn hosted_api_base_url_allows_loopback_http_for_explicit_local_development() {
    let env = BTreeMap::new();

    let environment = HostedApiEnvironment::resolve(
        Some("http://127.0.0.1:4317/"),
        Some("rxk_local"),
        &env,
        Path::new("."),
    )
    .expect("loopback environment");

    assert_eq!(environment.base_url(), "http://127.0.0.1:4317");
}

#[test]
fn hosted_api_base_url_rejects_embedded_credentials_and_query_state() {
    let env = BTreeMap::new();

    for base_url in [
        "/",
        "https://user:secret@api.runx.test",
        "https://api.runx.test?tenant=other",
        "https://api.runx.test#fragment",
    ] {
        assert!(
            HostedApiEnvironment::resolve(Some(base_url), None, &env, Path::new(".")).is_err(),
            "{base_url} must fail closed",
        );
    }
}
