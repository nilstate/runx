use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[test]
fn doctor_empty_workspace_json_matches_fixture() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = doctor_fixture("empty-success")?;
    let output = runx_command()
        .args(["doctor", "--json"])
        .env("RUNX_CWD", fixture.join("workspace"))
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout)?,
        expected_report(&fixture)?
    );
    Ok(())
}

#[test]
fn doctor_failure_json_exits_one_and_matches_fixture() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = doctor_fixture("removed-tool-yaml")?;
    let workspace = fixture.join("workspace");
    let output = runx_command()
        .args(["doctor", workspace.to_str().unwrap_or_default(), "--json"])
        .output()?;

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8(output.stderr)?, "");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout)?,
        expected_report(&fixture)?
    );
    Ok(())
}

#[test]
fn doctor_authority_json_reports_missing_env_names() -> Result<(), Box<dyn std::error::Error>> {
    let output = authority_doctor_command()
        .args(["doctor", "authority", "--json"])
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(report["status"], "success");
    assert_eq!(report["summary"]["warnings"], 4);
    let rendered = serde_json::to_string(&report)?;
    for env_name in AUTHORITY_ENV_NAMES {
        if *env_name == "RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON" {
            continue;
        }
        assert!(
            rendered.contains(env_name),
            "authority doctor should name missing env var {env_name}"
        );
    }
    assert!(rendered.contains("Cross-run spend caps"));
    assert!(rendered.contains("payment idempotency"));
    Ok(())
}

#[test]
fn doctor_authority_json_redacts_secret_values_and_reports_state_path()
-> Result<(), Box<dyn std::error::Error>> {
    let output = authority_doctor_command()
        .args(["doctor", "authority", "--json"])
        .env("RUNX_RECEIPT_SIGN_KID", "kid_prod")
        .env("RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64", "super-secret-seed")
        .env("RUNX_RECEIPT_SIGN_ISSUER_TYPE", "hosted")
        .env("RUNX_RECEIPT_VERIFY_KID", "kid_prod")
        .env(
            "RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64",
            "public-key-material",
        )
        .env(
            "RUNX_EFFECT_STATE_PATH",
            "/Users/kam/private/effect-state.json",
        )
        .env("RUNX_PROVIDER_PERMISSION_GRANT_ID", "grant_prod")
        .env(
            "RUNX_PROVIDER_PERMISSION_GRANTED_SCOPES",
            "repo.read repo.write",
        )
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(report["summary"]["infos"], 4);
    let rendered = serde_json::to_string(&report)?;
    assert!(rendered.contains("kid_prod"));
    assert!(!rendered.contains("super-secret-seed"));
    assert!(rendered.contains("/Users/kam/private/effect-state.json"));
    assert!(!rendered.contains("repo.read"));
    assert!(!rendered.contains("grant_prod"));
    Ok(())
}

#[test]
fn doctor_authority_json_reports_unsupported_hosted_effect_state_backend()
-> Result<(), Box<dyn std::error::Error>> {
    let output = authority_doctor_command()
        .args(["doctor", "authority", "--json"])
        .env(
            "RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON",
            r#"{"kind":"hosted_transactional","tenant_id":"tenant_1","store_ref":"runx:hosted-effect-state"}"#,
        )
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(report["summary"]["errors"], 1);
    assert!(report["diagnostics"].as_array().is_some_and(|diagnostics| {
        diagnostics.iter().any(|diagnostic| {
            diagnostic["id"] == "runx.authority.effect_state"
                && diagnostic["severity"] == "error"
                && diagnostic["message"].as_str().is_some_and(|message| {
                    message.contains("without a complete hosted effect-state transport")
                })
        })
    }));
    let rendered = serde_json::to_string(&report)?;
    assert!(rendered.contains("RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON"));
    assert!(!rendered.contains("tenant_1"));
    Ok(())
}

#[test]
fn doctor_authority_json_accepts_complete_hosted_effect_state_backend()
-> Result<(), Box<dyn std::error::Error>> {
    let output = authority_doctor_command()
        .args(["doctor", "authority", "--json"])
        .env(
            "RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON",
            r#"{"kind":"hosted_transactional","tenant_id":"tenant_1","store_ref":"runx:hosted-effect-state","endpoint_url":"http://127.0.0.1:12345/effect-state","bearer_token":"secret-token","allowed_families":["payment"]}"#,
        )
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(report["summary"]["errors"], 0);
    assert!(report["diagnostics"].as_array().is_some_and(|diagnostics| {
        diagnostics.iter().any(|diagnostic| {
            diagnostic["id"] == "runx.authority.effect_state"
                && diagnostic["severity"] == "info"
                && diagnostic["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("hosted transactional transport"))
        })
    }));
    let rendered = serde_json::to_string(&report)?;
    assert!(rendered.contains("RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON"));
    assert!(!rendered.contains("secret-token"));
    Ok(())
}

#[test]
fn doctor_registry_json_reports_readiness_without_key_material()
-> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("doctor-registry");
    let output = registry_doctor_command()
        .args(["doctor", "registry", "--json"])
        .env("RUNX_HOME", root.to_str().unwrap_or_default())
        .env("RUNX_REGISTRY_URL", "https://registry.runx.test/api")
        .env("RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID", "operator-key-1")
        .env(
            "RUNX_REGISTRY_MANIFEST_TRUST_KEY_BASE64",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )
        .env("RUNX_REGISTRY_MANIFEST_TRUST_OWNER", "acme")
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(report["status"], "success");
    assert_eq!(report["summary"]["warnings"], 0);
    let rendered = serde_json::to_string(&report)?;
    assert!(rendered.contains("https://registry.runx.test/api"));
    assert!(rendered.contains("official-skills"));
    assert!(rendered.contains("registry-skills"));
    assert!(rendered.contains("operator-key-1"));
    assert!(rendered.contains("acme/*"));
    assert!(rendered.contains("RUNX_INSTALLATION_ID"));
    assert!(!rendered.contains("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
    assert!(!diagnostic_has_repair(
        &report,
        "runx.registry.installation_id"
    ));
    Ok(())
}

#[test]
fn doctor_registry_json_reports_trust_policy_scope_without_key_material()
-> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("doctor-registry-trust-policy");
    let output = registry_doctor_command()
        .args(["doctor", "registry", "--json"])
        .env("RUNX_HOME", root.to_str().unwrap_or_default())
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    let rendered = serde_json::to_string(&report)?;
    assert!(rendered.contains("trust_policy"));
    assert!(rendered.contains("official_runx"));
    assert!(rendered.contains("runx/*"));
    assert!(rendered.contains("can_grant_first_party"));
    assert!(!rendered.contains("RUNX_REGISTRY_MANIFEST_PUBLIC_KEY"));
    Ok(())
}

#[test]
fn doctor_registry_json_warns_on_partial_trust_key_config() -> Result<(), Box<dyn std::error::Error>>
{
    let root = temp_root("doctor-registry-partial");
    let output = registry_doctor_command()
        .args(["doctor", "registry", "--json"])
        .env("RUNX_HOME", root.to_str().unwrap_or_default())
        .env(
            "RUNX_REGISTRY_MANIFEST_TRUST_KEY_BASE64",
            "raw-public-key-material",
        )
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(report["status"], "success");
    assert_eq!(report["summary"]["warnings"], 1);
    let rendered = serde_json::to_string(&report)?;
    assert!(rendered.contains("partial_operator_key_config"));
    assert!(rendered.contains("RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID"));
    assert!(rendered.contains("RUNX_REGISTRY_MANIFEST_TRUST_OWNER"));
    assert!(!rendered.contains("raw-public-key-material"));
    assert!(diagnostic_has_repair(&report, "runx.registry.trust_keys"));
    Ok(())
}

fn diagnostic_has_repair(report: &serde_json::Value, id: &str) -> bool {
    report["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|diagnostic| {
            diagnostic["id"] == id
                && diagnostic["repairs"]
                    .as_array()
                    .is_some_and(|repairs| !repairs.is_empty())
        })
}

fn runx_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_runx"));
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    command.env("NO_COLOR", "1");
    command.env("RUNX_HOME", temp_root("runx-doctor-home"));
    command
}

fn authority_doctor_command() -> Command {
    let mut command = runx_command();
    for env_name in AUTHORITY_ENV_NAMES {
        command.env_remove(env_name);
    }
    command
}

fn registry_doctor_command() -> Command {
    let mut command = runx_command();
    for env_name in REGISTRY_ENV_NAMES {
        command.env_remove(env_name);
    }
    command
}

const AUTHORITY_ENV_NAMES: &[&str] = &[
    "RUNX_RECEIPT_SIGN_KID",
    "RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64",
    "RUNX_RECEIPT_SIGN_ISSUER_TYPE",
    "RUNX_RECEIPT_VERIFY_KID",
    "RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64",
    "RUNX_EFFECT_STATE_PATH",
    "RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON",
    "RUNX_PROVIDER_PERMISSION_GRANT_ID",
    "RUNX_PROVIDER_PERMISSION_GRANTED_SCOPES",
];

const REGISTRY_ENV_NAMES: &[&str] = &[
    "RUNX_HOME",
    "RUNX_REGISTRY_URL",
    "RUNX_REGISTRY_DIR",
    "RUNX_OFFICIAL_SKILLS_DIR",
    "RUNX_INSTALLATION_ID",
    "RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID",
    "RUNX_REGISTRY_MANIFEST_TRUST_KEY_BASE64",
    "RUNX_REGISTRY_MANIFEST_TRUST_OWNER",
];

fn temp_root(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    std::env::temp_dir().join(format!("{name}-{}-{nanos}", std::process::id()))
}

fn expected_report(fixture: &Path) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let expected_json = fs::read_to_string(fixture.join("expected.json"))?;
    Ok(serde_json::from_str(&expected_json)?)
}

fn doctor_fixture(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(repo_root()?.join("fixtures").join("doctor").join(name))
}

fn repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?)
}
