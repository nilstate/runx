use runx_contracts::JsonValue;
use runx_core::policy::{
    AdmissionDecision, AuthorityKind, LocalAdmissionGrant, LocalAdmissionGrantStatus,
    LocalAdmissionOptions, LocalAdmissionSkill, LocalAdmissionSource, admit_local_skill,
};
use serde_json::json;

#[test]
fn converted_targeted_grant_admits_exact_requirement() -> Result<(), Box<dyn std::error::Error>> {
    let skill = credential_grant_skill(json!({
        "provider": "github",
        "scopes": ["repo:read"],
        "scope_family": "github_repo",
        "authority_kind": "read_only",
        "target_repo": "runxhq/runx",
        "target_locator": "github:repo:runxhq/runx"
    }))?;
    let decision = admit_local_skill(
        &skill,
        &LocalAdmissionOptions {
            connected_grants: Some(vec![local_grant(LocalAdmissionGrantStatus::Active)]),
            connected_auth_checked_at: Some("2026-05-22T00:00:00Z".to_owned()),
            ..LocalAdmissionOptions::default()
        },
    );

    assert!(matches!(decision, AdmissionDecision::Allow { .. }));
    Ok(())
}

#[test]
fn converted_targeted_grant_does_not_admit_untargeted_requirement()
-> Result<(), Box<dyn std::error::Error>> {
    let skill = credential_grant_skill(json!({
        "provider": "github",
        "scopes": ["repo:read"]
    }))?;
    let decision = admit_local_skill(
        &skill,
        &LocalAdmissionOptions {
            connected_grants: Some(vec![local_grant(LocalAdmissionGrantStatus::Active)]),
            connected_auth_checked_at: Some("2026-05-22T00:00:00Z".to_owned()),
            ..LocalAdmissionOptions::default()
        },
    );

    assert!(matches!(decision, AdmissionDecision::Deny { .. }));
    Ok(())
}

#[test]
fn converted_revoked_grant_denies() -> Result<(), Box<dyn std::error::Error>> {
    let skill = credential_grant_skill(json!({
        "provider": "github",
        "scopes": ["repo:read"],
        "scope_family": "github_repo",
        "authority_kind": "read_only",
        "target_repo": "runxhq/runx",
        "target_locator": "github:repo:runxhq/runx"
    }))?;
    let decision = admit_local_skill(
        &skill,
        &LocalAdmissionOptions {
            connected_grants: Some(vec![local_grant(LocalAdmissionGrantStatus::Revoked)]),
            connected_auth_checked_at: Some("2026-05-22T00:00:00Z".to_owned()),
            ..LocalAdmissionOptions::default()
        },
    );

    assert!(matches!(decision, AdmissionDecision::Deny { .. }));
    Ok(())
}

fn local_grant(status: LocalAdmissionGrantStatus) -> LocalAdmissionGrant {
    LocalAdmissionGrant {
        grant_id: "grant_fixture".to_owned(),
        provider: "github".to_owned(),
        scopes: vec!["repo:read".to_owned()],
        status: Some(status),
        not_before: Some("2026-05-21T00:00:00Z".to_owned()),
        expires_at: Some("2026-05-23T00:00:00Z".to_owned()),
        scope_family: Some("github_repo".to_owned()),
        authority_kind: Some(AuthorityKind::ReadOnly),
        target_repo: Some("runxhq/runx".to_owned()),
        target_locator: Some("github:repo:runxhq/runx".to_owned()),
    }
}

fn credential_grant_skill(
    auth: serde_json::Value,
) -> Result<LocalAdmissionSkill, serde_json::Error> {
    Ok(LocalAdmissionSkill {
        name: "credential-grant-review".to_owned(),
        source: LocalAdmissionSource {
            source_type: "cli-tool".to_owned(),
            command: Some("true".to_owned()),
            args: None,
            timeout_seconds: None,
        },
        auth: Some(serde_json::from_value::<JsonValue>(auth)?),
        runtime: None,
    })
}
