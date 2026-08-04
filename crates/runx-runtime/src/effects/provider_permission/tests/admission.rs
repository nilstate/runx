use runx_contracts::AuthorityVerb;

use super::*;

#[test]
fn provider_capabilities_bind_idempotency_and_approval_to_mutation_only() {
    let effect = ProviderPermissionEffect::default();
    let read = effect
        .capabilities()
        .iter()
        .find(|tool| tool.definition().id == PROVIDER_READ_TOOL)
        .expect("provider.read");
    let mutate = effect
        .capabilities()
        .iter()
        .find(|tool| tool.definition().id == PROVIDER_MUTATE_TOOL)
        .expect("provider.mutate");

    assert!(
        !read
            .catalog_inputs()
            .expect("read inputs")
            .contains_key("idempotency_key")
    );
    assert!(mutate.catalog_inputs().expect("mutate inputs")["idempotency_key"].required);
    assert_eq!(read.definition().approval, crate::CapabilityApproval::None);
    assert_eq!(
        mutate.definition().approval,
        crate::CapabilityApproval::Effect
    );
}

#[test]
fn admitted_verbs_bind_grant_and_scope_evidence() {
    for (verb, expected) in [
        ("read", AuthorityVerb::Read),
        ("revoke", AuthorityVerb::Revoke),
    ] {
        let effect = ProviderPermissionEffect::default();
        let step = test_step("provider", &["repo.read"], verb);
        let inputs = JsonObject::new();
        let env = provider_env("github-mcp-read", "repo.read");
        let admission = effect
            .admit(effect_request(&step, &inputs, &env))
            .expect("admission")
            .expect("owned provider effect");

        assert_eq!(admission.verb(), expected);
        assert_eq!(
            effect.authority_grant_refs(&admission).expect("grant refs")[0].reference_type,
            ReferenceType::Grant
        );
        assert_eq!(
            effect.authority_scope_refs(&admission).expect("scope refs")[0].reference_type,
            ReferenceType::ScopeAdmission
        );
    }
}

#[test]
fn authority_term_identity_cannot_collide_across_opaque_scope_lists() {
    let effect = ProviderPermissionEffect::default();
    let inputs = JsonObject::new();
    let scopes = ["a+b".to_owned(), "a".to_owned(), "b".to_owned()];
    let env = BTreeMap::from([
        (
            PROVIDER_PERMISSION_GRANT_ID_ENV.to_owned(),
            "github-mcp-read".to_owned(),
        ),
        (
            PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
            encode_provider_scopes_env(&scopes).expect("scope transport"),
        ),
    ]);
    let admission = |required: &[&str]| {
        let step = test_step("provider", required, "read");
        effect
            .admit(effect_request(&step, &inputs, &env))
            .expect("admission")
            .expect("owned provider effect")
            .witness()
            .child_term_id
            .clone()
    };

    assert_ne!(admission(&["a+b"]), admission(&["a", "b"]));
}

#[test]
fn admission_rejects_missing_scope_grant_and_self_attestation() {
    let effect = ProviderPermissionEffect::default();
    let inputs = JsonObject::new();

    let missing_scope = test_step("write", &["repo.write"], "write");
    let scope_env = provider_env("github-mcp-read", "repo.read");
    assert!(matches!(
        effect.admit(effect_request(&missing_scope, &inputs, &scope_env)),
        Err(RuntimeEffectError::Denied { ref message, .. }) if message.contains("repo.write")
    ));

    let missing_grant = BTreeMap::from([(
        PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
        encode_provider_scopes_env(&["repo.read".to_owned()]).expect("scope transport"),
    )]);
    let read = test_step("read", &["repo.read"], "read");
    assert!(matches!(
        effect.admit(effect_request(&read, &inputs, &missing_grant)),
        Err(RuntimeEffectError::Denied { ref message, .. }) if message.contains(PROVIDER_PERMISSION_GRANT_ID_ENV)
    ));

    let mut self_attested = test_step("read", &["repo.read"], "read");
    policy_mut(&mut self_attested).insert(
        "granted_scopes".to_owned(),
        JsonValue::Array(vec![JsonValue::String("repo.read".to_owned())]),
    );
    assert!(matches!(
        effect.admit(effect_request(&self_attested, &inputs, &scope_env)),
        Err(RuntimeEffectError::Denied { ref message, .. }) if message.contains("self-attested")
    ));
}

#[test]
fn malformed_policy_fails_closed() {
    let effect = ProviderPermissionEffect::default();
    let inputs = JsonObject::new();
    let env = provider_env("github-mcp-read", "repo.read");

    let mut missing_verb = test_step("read", &["repo.read"], "read");
    policy_mut(&mut missing_verb).remove("verb");
    assert_policy_error(
        effect
            .admit(effect_request(&missing_verb, &inputs, &env))
            .expect_err("missing verb"),
        "verb is required",
    );

    let unknown_verb = test_step("read", &["repo.read"], "publish");
    assert_policy_error(
        effect
            .admit(effect_request(&unknown_verb, &inputs, &env))
            .expect_err("unknown verb"),
        "not supported",
    );

    let mut malformed_scope = test_step("read", &["repo.read"], "read");
    policy_mut(&mut malformed_scope).insert(
        "required_scopes".to_owned(),
        JsonValue::Array(vec![JsonValue::Bool(false)]),
    );
    assert_policy_error(
        effect
            .admit(effect_request(&malformed_scope, &inputs, &env))
            .expect_err("malformed scope"),
        "required_scopes[0] must be a string",
    );
}

#[test]
fn native_provider_tools_require_matching_access_policy_and_explicit_identity() {
    let effect = ProviderPermissionEffect::default();
    let inputs = provider_inputs("channel.post");
    let env = provider_env("github-mcp-read", "channel.post");

    let mut missing_policy = native_step(PROVIDER_READ_TOOL, &["channel.post"], "read");
    missing_policy.policy = None;
    assert!(
        effect
            .admit(effect_request(&missing_policy, &inputs, &env))
            .is_err()
    );

    let read_with_write = native_step(PROVIDER_READ_TOOL, &["channel.post"], "write");
    assert!(matches!(
        effect.admit(effect_request(&read_with_write, &inputs, &env)),
        Err(RuntimeEffectError::Denied { .. })
    ));

    let mutate_with_read = native_step(PROVIDER_MUTATE_TOOL, &["channel.post"], "read");
    assert!(matches!(
        effect.admit(effect_request(&mutate_with_read, &inputs, &env)),
        Err(RuntimeEffectError::Denied { .. })
    ));

    let step = native_step(PROVIDER_MUTATE_TOOL, &["channel.post"], "write");
    let admission = effect
        .admit(effect_request(&step, &inputs, &env))
        .expect("native admission")
        .expect("owned provider effect");
    assert_eq!(
        admission
            .context::<ProviderPermissionAdmission>()
            .map(|context| context.grant_id.as_str()),
        Some("github-mcp-read")
    );
}
