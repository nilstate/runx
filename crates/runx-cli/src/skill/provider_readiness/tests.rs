use std::collections::BTreeMap;

use super::{
    connect_start_command, inspect_explicit_provider_grant, less_ready_status,
    provider_readiness_sources,
};

#[test]
fn explicit_provider_grant_readiness_is_scope_bound() {
    let ready = inspect_explicit_provider_grant(
        "grant_google",
        &["properties.read".to_owned(), "reports.read".to_owned()],
        &["properties.read".to_owned()],
    );
    assert_eq!(ready.status, "ready");

    let missing = inspect_explicit_provider_grant(
        "grant_google",
        &["properties.read".to_owned()],
        &["reports.read".to_owned()],
    );
    assert_eq!(missing.status, "needs_provider_grant");
}

#[test]
fn readiness_keeps_the_most_actionable_blocker() {
    assert_eq!(
        less_ready_status("provider_readiness_unknown", "needs_provider_grant"),
        "needs_provider_grant"
    );
    assert_eq!(
        less_ready_status("needs_provider_grant", "ready"),
        "needs_provider_grant"
    );
}

#[test]
fn connect_setup_command_preserves_exact_provider_scopes() {
    assert_eq!(
        connect_start_command(
            "google-search-console",
            &["sites.read".to_owned(), "url.inspect".to_owned()]
        ),
        "runx connect start google-search-console --scope sites.read --scope url.inspect"
    );
    assert_eq!(
        connect_start_command(
            "future-provider",
            &[
                "urn:vendor:scope?mode=read&format=full".to_owned(),
                "custom.operation:v3".to_owned(),
            ],
        ),
        "runx connect start future-provider --scope 'urn:vendor:scope?mode=read&format=full' --scope custom.operation:v3"
    );
}

#[test]
fn explicit_provider_scope_transport_preserves_opaque_values()
-> Result<(), Box<dyn std::error::Error>> {
    let scopes = vec![
        "https://provider.example/auth/custom.scope?mode=read,write".to_owned(),
        "opaque capability with spaces".to_owned(),
    ];
    let encoded_scopes = runx_runtime::encode_provider_scopes_env(&scopes)?;
    let env = BTreeMap::from([
        (
            runx_runtime::PROVIDER_PERMISSION_GRANT_ID_ENV.to_owned(),
            "grant_future".to_owned(),
        ),
        (
            runx_runtime::PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
            encoded_scopes,
        ),
        (
            runx_runtime::PROVIDER_PERMISSION_PRINCIPAL_REF_ENV.to_owned(),
            "runx:principal:operator:test".to_owned(),
        ),
    ]);

    let sources = provider_readiness_sources(&env, std::path::Path::new("."));

    assert_eq!(sources.explicit_scopes, Some(scopes));
    assert!(sources.explicit_principal);
    assert!(sources.hosted_grants.is_none());
    Ok(())
}

#[test]
fn incomplete_explicit_provider_evidence_never_reports_locally_ready()
-> Result<(), Box<dyn std::error::Error>> {
    let scopes = vec!["future.scope,with delimiter".to_owned()];
    let encoded_scopes = runx_runtime::encode_provider_scopes_env(&scopes)?;
    let env = BTreeMap::from([
        (
            runx_runtime::PROVIDER_PERMISSION_GRANT_ID_ENV.to_owned(),
            "grant_future".to_owned(),
        ),
        (
            runx_runtime::PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
            encoded_scopes,
        ),
    ]);

    let sources = provider_readiness_sources(&env, std::path::Path::new("."));

    assert_eq!(sources.explicit_scopes, Some(scopes));
    assert!(!sources.explicit_principal);
    assert!(sources.hosted_grants.is_some());
    Ok(())
}
