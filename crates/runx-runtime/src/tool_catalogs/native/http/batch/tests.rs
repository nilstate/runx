#![allow(clippy::expect_used)]

use std::collections::BTreeMap;

use super::super::HttpBatchInput;
use super::{RequestAuth, admitted_hosts};
#[cfg(feature = "catalog")]
use crate::RuntimeEffectRegistry;
use crate::credentials::CredentialDelivery;
use crate::receipts::paths::RUNX_CWD_ENV;
use crate::tool_catalogs::native::NativeInvocation;

fn inputs(host: &str) -> HttpBatchInput {
    HttpBatchInput {
        requests: Vec::new(),
        allowed_hosts: vec![host.to_owned()],
        auth: None,
        stop_on_error: true,
    }
}

fn delivery() -> Result<CredentialDelivery, Box<dyn std::error::Error>> {
    Ok(CredentialDelivery::from_local_descriptor(
        "example",
        "bearer",
        "EXAMPLE_TOKEN",
        "local:example:test",
        vec!["example:read".to_owned()],
        "credential-sentinel",
    )?
    .bind_audience(Some("https://api.example.com"))?)
}

#[test]
fn native_http_credential_binding_cannot_be_widened_by_caller_hosts()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = inputs("attacker.example");
    let delivery = delivery()?;
    #[cfg(feature = "catalog")]
    let effects = RuntimeEffectRegistry::default();
    let invocation = NativeInvocation {
        inputs: &inputs,
        observed_at: "2026-01-01T00:00:00Z",
        data_source_binding: None,
        env: &env,
        skill_directory: workspace.path(),
        credential_delivery: &delivery,
        local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
        #[cfg(feature = "catalog")]
        effects: &effects,
    };

    let error = admitted_hosts(
        &invocation,
        &RequestAuth::Bearer {
            secret_env: "EXAMPLE_TOKEN".to_owned(),
        },
    )
    .expect_err("caller-selected host must not widen credential binding");
    assert!(
        error
            .to_string()
            .contains("outside the resolved credential audience")
    );
    Ok(())
}

#[test]
fn native_http_credential_binding_requires_a_resolved_audience()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = inputs("api.example.com");
    let delivery = CredentialDelivery::from_local_descriptor(
        "example",
        "bearer",
        "EXAMPLE_TOKEN",
        "local:example:test",
        vec!["example:read".to_owned()],
        "credential-sentinel",
    )?;
    #[cfg(feature = "catalog")]
    let effects = RuntimeEffectRegistry::default();
    let invocation = NativeInvocation {
        inputs: &inputs,
        observed_at: "2026-01-01T00:00:00Z",
        data_source_binding: None,
        env: &env,
        skill_directory: workspace.path(),
        credential_delivery: &delivery,
        local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
        #[cfg(feature = "catalog")]
        effects: &effects,
    };

    let error = admitted_hosts(
        &invocation,
        &RequestAuth::Bearer {
            secret_env: "EXAMPLE_TOKEN".to_owned(),
        },
    )
    .expect_err("authenticated HTTP without a credential audience must fail closed");
    assert!(
        error
            .to_string()
            .contains("requires a resolved credential audience")
    );
    Ok(())
}

#[test]
fn native_http_credential_binding_accepts_an_exact_bound_host()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = inputs("api.example.com");
    let delivery = delivery()?;
    #[cfg(feature = "catalog")]
    let effects = RuntimeEffectRegistry::default();
    let invocation = NativeInvocation {
        inputs: &inputs,
        observed_at: "2026-01-01T00:00:00Z",
        data_source_binding: None,
        env: &env,
        skill_directory: workspace.path(),
        credential_delivery: &delivery,
        local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
        #[cfg(feature = "catalog")]
        effects: &effects,
    };

    let hosts = admitted_hosts(
        &invocation,
        &RequestAuth::Bearer {
            secret_env: "EXAMPLE_TOKEN".to_owned(),
        },
    )?;
    assert!(hosts.contains("api.example.com"));
    Ok(())
}
