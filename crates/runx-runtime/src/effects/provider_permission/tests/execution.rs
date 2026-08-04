use std::cell::RefCell;

use runx_contracts::AuthorityVerb;
use runx_core::state_machine::AuthorityAdmissionWitness;

use crate::http::{
    RuntimeHttpError, RuntimeHttpRequest as HttpRequest, RuntimeHttpResponse as HttpResponse,
    RuntimeHttpTransport as Transport,
};

use super::*;

#[test]
fn provider_tool_uses_only_its_current_step_admission() {
    let inputs = provider_inputs("messages.search");
    let env = BTreeMap::new();
    let credentials = crate::CredentialDelivery::none();
    let admission = |grant_id: &str| {
        EffectAdmission::new(
            PROVIDER_PERMISSION_EFFECT_FAMILY,
            AuthorityVerb::Read,
            AuthorityAdmissionWitness {
                verb: AuthorityVerb::Read,
                parent_term_id: format!("provider-permission:{grant_id}"),
                child_term_id: "provider-permission:provider.read:messages.search".to_owned(),
                idempotency_key: None,
                capability_ref: None,
            },
            ProviderPermissionAdmission {
                grant_id: grant_id.to_owned(),
                required_scopes: vec!["messages.search".to_owned()],
                granted_scopes: vec!["messages.search".to_owned()],
                provider_effect: Some(test_provider_resolved(grant_id, ProviderNativeAccess::Read)),
                attempt: Some(test_provider_attempt(grant_id, ProviderNativeAccess::Read)),
                recovery: None,
            },
        )
    };
    let first = admission("grant_first");
    let second = admission("grant_second");
    let request = |admission| EffectToolRequest {
        tool_ref: PROVIDER_READ_TOOL,
        observed_at: "2026-07-20T00:00:00Z",
        inputs: &inputs,
        env: &env,
        skill_directory: Path::new("."),
        credential_delivery: &credentials,
        admission: Some(admission),
    };

    assert_eq!(
        admit_provider_tool_invocation(&request(&first), ProviderNativeAccess::Read)
            .expect("first")
            .grant_id,
        "grant_first"
    );
    assert_eq!(
        admit_provider_tool_invocation(&request(&second), ProviderNativeAccess::Read)
            .expect("second")
            .grant_id,
        "grant_second"
    );
}

#[test]
fn hosted_grant_selection_is_unique_scope_bound_and_explicit() {
    let grants = vec![
        hosted_grant("grant_a", "slack", &["channel.post"], "active"),
        hosted_grant(
            "grant_b",
            "slack",
            &["channel.post", "thread.reply"],
            "active",
        ),
        hosted_grant("revoked", "slack", &["channel.post"], "revoked"),
    ];
    let scopes = vec!["channel.post".to_owned()];

    assert!(select_hosted_provider_grant(&grants, "slack", &scopes, None).is_err());
    assert_eq!(
        select_hosted_provider_grant(&grants, "slack", &scopes, Some("grant_b"))
            .expect("explicit grant")
            .grant_id,
        "grant_b"
    );
    assert!(
        select_hosted_provider_grant(&grants, "slack", &["channel.delete".to_owned()], None,)
            .is_err()
    );
}

#[test]
fn hosted_authentication_is_cached_per_environment() {
    struct StubTransport(RefCell<Vec<HttpRequest>>);
    impl Transport for StubTransport {
        fn send(&self, request: HttpRequest) -> Result<HttpResponse, RuntimeHttpError> {
            self.0.borrow_mut().push(request);
            Ok(HttpResponse::new(
                200,
                r#"{"status":"success","principal":{"principal_id":"operator:test"}}"#,
            ))
        }
    }

    let workspace = tempfile::tempdir().expect("workspace");
    let env = BTreeMap::from([(
        crate::HOSTED_API_TOKEN_ENV.to_owned(),
        "rxk_test".to_owned(),
    )]);
    let resolved =
        HostedApiEnvironment::resolve(Some("https://api.runx.test"), None, &env, workspace.path())
            .expect("environment");
    let transport = StubTransport(RefCell::new(Vec::new()));
    let effect = ProviderPermissionEffect::default();
    effect
        .authenticated_environment(&resolved, &transport)
        .expect("first authentication");
    effect
        .authenticated_environment(&resolved, &transport)
        .expect("cached authentication");
    assert_eq!(transport.0.borrow().len(), 1);
}

#[test]
fn readback_projection_is_bounded_and_identity_checked() {
    let readback = JsonObject::from([
        ("provider".to_owned(), JsonValue::String("vault".to_owned())),
        (
            "result".to_owned(),
            JsonValue::Object(JsonObject::from([
                (
                    "handle_ref".to_owned(),
                    JsonValue::String("handle://deployment/db".to_owned()),
                ),
                (
                    "expires_at".to_owned(),
                    JsonValue::String("2026-07-20T03:00:00Z".to_owned()),
                ),
                ("secret".to_owned(), JsonValue::String("drop-me".to_owned())),
            ])),
        ),
    ]);
    let output = project_provider_tool_readback(
        PROVIDER_MUTATE_TOOL,
        readback,
        ProviderReadbackContract {
            expected_provider: "vault".to_owned(),
            grant_id: "grant_vault".to_owned(),
            access: ProviderNativeAccess::Mutate,
            principal_id: "operator:test",
            expected_result: None,
            result_fields: Some(vec!["handle_ref".to_owned(), "expires_at".to_owned()]),
            finality: test_provider_finality("grant_vault", ProviderNativeAccess::Mutate),
        },
    )
    .expect("projection");
    let result = output
        .as_object()
        .and_then(|output| output.get("provider_operation"))
        .and_then(JsonValue::as_object)
        .and_then(|operation| operation.get("result"))
        .and_then(JsonValue::as_object)
        .expect("result");
    assert_eq!(result.len(), 2);
    assert!(!result.contains_key("secret"));

    let mismatch = project_provider_tool_readback(
        PROVIDER_READ_TOOL,
        JsonObject::from([
            (
                "provider".to_owned(),
                JsonValue::String("github".to_owned()),
            ),
            (
                "result".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "repository".to_owned(),
                    JsonValue::String("runxhq/other".to_owned()),
                )])),
            ),
        ]),
        ProviderReadbackContract {
            expected_provider: "github".to_owned(),
            grant_id: "grant_github".to_owned(),
            access: ProviderNativeAccess::Read,
            principal_id: "operator:test",
            expected_result: Some(JsonObject::from([(
                "repository".to_owned(),
                JsonValue::String("runxhq/runx".to_owned()),
            )])),
            result_fields: None,
            finality: test_provider_finality("grant_github", ProviderNativeAccess::Read),
        },
    );
    assert!(mismatch.is_err());
}

#[test]
fn mutation_idempotency_is_runtime_derived_and_cannot_be_shadowed() {
    let attempt = test_provider_attempt("grant_github", ProviderNativeAccess::Mutate);
    let mut payload = JsonObject::new();
    inject_provider_idempotency(
        PROVIDER_MUTATE_TOOL,
        ProviderNativeAccess::Mutate,
        &attempt,
        &mut payload,
    )
    .expect("idempotency injection");
    assert_eq!(
        payload.get("idempotency_key").and_then(JsonValue::as_str),
        Some(attempt.idempotency_key())
    );

    let mut shadowed = JsonObject::from([(
        "idempotency_key".to_owned(),
        JsonValue::String("caller-copy".to_owned()),
    )]);
    assert!(
        inject_provider_idempotency(
            PROVIDER_MUTATE_TOOL,
            ProviderNativeAccess::Mutate,
            &attempt,
            &mut shadowed,
        )
        .is_err()
    );
}
