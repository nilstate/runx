use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use runx_runtime::{
    ConfigError, ConfigKey, LocalProfileSource, ManagedAgentConfig, RunxAgentConfig,
    RunxConfigFile, SecretString, load_local_agent_api_key, load_local_public_api_token,
    load_managed_agent_config, load_runx_config_file, lookup_runx_config_value,
    managed_agent_provider, mask_runx_config_file, resolve_local_skill_profile,
    resolve_runx_global_home_dir, update_runx_config_value, write_runx_config_file,
};
use tempfile::tempdir;

#[test]
fn config_home_path_anchors_relative_runx_home_to_workspace_base()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let workspace = temp.path().join("workspace");
    let run_dir = temp.path().join("run");
    let cwd = workspace.join("packages/demo");
    fs::create_dir_all(workspace.join("home"))?;
    fs::create_dir_all(&cwd)?;
    fs::write(
        workspace.join("pnpm-workspace.yaml"),
        "packages:\n  - packages/*\n",
    )?;

    let env = env_map([
        ("RUNX_CWD", run_dir.to_str().unwrap_or_default()),
        ("INIT_CWD", run_dir.to_str().unwrap_or_default()),
        ("RUNX_HOME", "home"),
    ]);

    assert_eq!(
        resolve_runx_global_home_dir(&env, &cwd),
        run_dir.join("home")
    );
    Ok(())
}

#[test]
fn config_round_trips_encrypted_local_agent_api_keys() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let config_dir = temp.path();
    let config = update_runx_config_value(
        RunxConfigFile::default(),
        ConfigKey::AgentApiKey,
        "sk-test-secret",
        config_dir,
    )?;
    let key_ref = config
        .agent
        .as_ref()
        .and_then(|agent| agent.api_key_ref.as_ref())
        .ok_or("missing key ref")?;

    assert!(key_ref.starts_with("local_agent_key_"));
    assert_eq!(
        load_local_agent_api_key(config_dir, key_ref)?,
        "sk-test-secret"
    );
    assert_eq!(
        lookup_runx_config_value(&config, ConfigKey::AgentApiKey),
        Some("[encrypted]".to_owned())
    );
    assert_eq!(
        mask_runx_config_file(&config)
            .agent
            .and_then(|agent| agent.api_key_ref),
        Some("[encrypted]".to_owned())
    );
    let config_json = serde_json::to_string(&config)?;
    assert!(!config_json.contains("sk-test-secret"));
    assert!(config_dir.join("keys/local-config-secret").exists());
    assert!(
        config_dir
            .join("keys")
            .join(format!("{key_ref}.json"))
            .exists()
    );
    assert_private_file(&config_dir.join("keys/local-config-secret"))?;
    assert_private_file(&config_dir.join("keys").join(format!("{key_ref}.json")))?;
    Ok(())
}

#[test]
fn config_round_trips_encrypted_public_api_token() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let config_dir = temp.path();
    let config = update_runx_config_value(
        RunxConfigFile::default(),
        ConfigKey::PublicApiToken,
        "rxk_test_secret",
        config_dir,
    )?;
    let token_ref = config
        .public
        .as_ref()
        .and_then(|public| public.api_token_ref.as_ref())
        .ok_or("missing public API token ref")?;

    assert!(token_ref.starts_with("local_public_api_token_"));
    assert_eq!(
        load_local_public_api_token(config_dir, token_ref)?,
        "rxk_test_secret"
    );
    assert_eq!(
        lookup_runx_config_value(&config, ConfigKey::PublicApiToken),
        Some("[encrypted]".to_owned())
    );
    assert_eq!(
        mask_runx_config_file(&config)
            .public
            .and_then(|public| public.api_token_ref),
        Some("[encrypted]".to_owned())
    );
    let config_json = serde_json::to_string(&config)?;
    assert!(!config_json.contains("rxk_test_secret"));
    assert!(
        config_dir
            .join("keys")
            .join(format!("{token_ref}.json"))
            .exists()
    );
    Ok(())
}

#[test]
fn config_loads_and_writes_supported_keys_only() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let config_path = temp.path().join("config.json");
    let config = RunxConfigFile {
        agent: Some(RunxAgentConfig {
            provider: Some("openai".to_owned()),
            model: Some("gpt-test".to_owned()),
            api_key_ref: None,
        }),
        public: None,
    };
    write_runx_config_file(&config_path, &config)?;
    assert_private_file(&config_path)?;

    assert_eq!(load_runx_config_file(&config_path)?, config);
    assert_eq!(
        lookup_runx_config_value(&config, ConfigKey::AgentProvider),
        Some("openai".to_owned())
    );
    assert!(matches!(
        runx_runtime::parse_config_key("agent.unknown"),
        Err(ConfigError::UnsupportedKey { .. })
    ));
    Ok(())
}

#[test]
fn config_loads_missing_and_rejects_malformed_or_non_object_json()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let missing_path = temp.path().join("missing.json");
    assert_eq!(
        load_runx_config_file(&missing_path)?,
        RunxConfigFile::default()
    );

    let malformed_path = temp.path().join("malformed.json");
    fs::write(&malformed_path, "{not-json")?;
    assert!(matches!(
        load_runx_config_file(&malformed_path),
        Err(ConfigError::InvalidJson { .. })
    ));

    let non_object_path = temp.path().join("array.json");
    fs::write(&non_object_path, "[]")?;
    assert!(matches!(
        load_runx_config_file(&non_object_path),
        Err(ConfigError::NonObjectJson { .. })
    ));
    Ok(())
}

#[test]
fn config_reports_corrupt_local_agent_key_with_stable_prefix()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let keys_dir = temp.path().join("keys");
    fs::create_dir_all(&keys_dir)?;
    fs::write(keys_dir.join("local-config-secret"), "test-secret")?;
    fs::write(keys_dir.join("local_agent_key_corrupt.json"), "{not-json")?;

    let error = match load_local_agent_api_key(temp.path(), "local_agent_key_corrupt") {
        Ok(_) => return Err("corrupt key should fail".into()),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("runx local agent key corrupted or unreadable at")
    );
    assert!(error.to_string().contains("local_agent_key_corrupt.json"));
    Ok(())
}

#[test]
fn config_loads_managed_agent_env_precedence_and_local_key_fallback()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let explicit_env = env_map([
        ("RUNX_HOME", temp.path().to_str().unwrap_or_default()),
        ("RUNX_AGENT_PROVIDER", "openai"),
        ("RUNX_AGENT_MODEL", "gpt-test"),
        ("RUNX_AGENT_API_KEY", "sk-explicit"),
    ]);
    assert_eq!(
        load_managed_agent_config(&explicit_env, temp.path())?,
        Some(ManagedAgentConfig {
            provider: managed_agent_provider::OPENAI.into(),
            model: "gpt-test".to_owned(),
            api_key: SecretString::new("sk-explicit"),
        })
    );

    let local_config = update_runx_config_value(
        RunxConfigFile {
            agent: Some(RunxAgentConfig {
                provider: Some("anthropic".to_owned()),
                model: Some("claude-test".to_owned()),
                api_key_ref: None,
            }),
            public: None,
        },
        ConfigKey::AgentApiKey,
        "local-secret",
        temp.path(),
    )?;
    write_runx_config_file(&temp.path().join("config.json"), &local_config)?;
    let local_env = env_map([("RUNX_HOME", temp.path().to_str().unwrap_or_default())]);
    assert_eq!(
        load_managed_agent_config(&local_env, temp.path())?,
        Some(ManagedAgentConfig {
            provider: managed_agent_provider::ANTHROPIC.into(),
            model: "claude-test".to_owned(),
            api_key: SecretString::new("local-secret"),
        })
    );

    let provider_env = env_map([
        ("RUNX_HOME", temp.path().to_str().unwrap_or_default()),
        ("RUNX_AGENT_PROVIDER", "anthropic"),
        ("RUNX_AGENT_MODEL", "claude-env"),
        ("ANTHROPIC_API_KEY", "anthropic-env-secret"),
    ]);
    let provider_config = load_managed_agent_config(&provider_env, temp.path())?;
    let debug = format!("{provider_config:?}");
    assert!(provider_config.is_some());
    assert!(!debug.contains("anthropic-env-secret"));
    assert!(debug.contains("[redacted-credential]"));
    Ok(())
}

#[test]
fn config_matches_blank_env_overlay_edges() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let local_config = update_runx_config_value(
        RunxConfigFile {
            agent: Some(RunxAgentConfig {
                provider: Some("anthropic".to_owned()),
                model: Some("claude-file".to_owned()),
                api_key_ref: None,
            }),
            public: None,
        },
        ConfigKey::AgentApiKey,
        "local-secret",
        temp.path(),
    )?;
    write_runx_config_file(&temp.path().join("config.json"), &local_config)?;
    let runx_home = temp.path().to_str().unwrap_or_default();

    let blank_provider = env_map([
        ("RUNX_HOME", runx_home),
        ("RUNX_AGENT_PROVIDER", ""),
        ("RUNX_AGENT_MODEL", "claude-env"),
        ("RUNX_AGENT_API_KEY", "sk-explicit"),
    ]);
    assert_eq!(
        load_managed_agent_config(&blank_provider, temp.path())?,
        None
    );

    let blank_model = env_map([
        ("RUNX_HOME", runx_home),
        ("RUNX_AGENT_PROVIDER", "anthropic"),
        ("RUNX_AGENT_MODEL", ""),
        ("RUNX_AGENT_API_KEY", "sk-explicit"),
    ]);
    assert_eq!(load_managed_agent_config(&blank_model, temp.path())?, None);

    let blank_generic_key = env_map([
        ("RUNX_HOME", runx_home),
        ("RUNX_AGENT_PROVIDER", "anthropic"),
        ("RUNX_AGENT_MODEL", "claude-env"),
        ("RUNX_AGENT_API_KEY", ""),
        ("ANTHROPIC_API_KEY", "provider-secret"),
    ]);
    assert_eq!(
        load_managed_agent_config(&blank_generic_key, temp.path())?.map(|config| config.api_key),
        Some(SecretString::new("local-secret"))
    );
    Ok(())
}

#[test]
fn config_resolves_local_skill_profiles_in_source_order() -> Result<(), Box<dyn std::error::Error>>
{
    let temp = tempdir()?;
    let skill_dir = temp.path().join("skills/runx/demo");
    fs::create_dir_all(&skill_dir)?;
    fs::write(skill_dir.join("SKILL.md"), "---\nname: demo\n---\n")?;

    let binding_dir = temp.path().join("bindings/runx/demo");
    fs::create_dir_all(&binding_dir)?;
    fs::write(
        binding_dir.join("X.yaml"),
        "skill: demo\nversion: '0.1.0'\n",
    )?;
    let resolved = resolve_local_skill_profile(&skill_dir, "demo")?;
    assert_eq!(resolved.source, LocalProfileSource::WorkspaceBindings);

    fs::create_dir_all(skill_dir.join(".runx"))?;
    fs::write(
        skill_dir.join(".runx/profile.json"),
        serde_json::json!({ "profile": { "document": "skill: demo\nversion: state\n" } })
            .to_string(),
    )?;
    let resolved = resolve_local_skill_profile(&skill_dir, "demo")?;
    assert_eq!(resolved.source, LocalProfileSource::ProfileState);

    fs::write(
        skill_dir.join("X.yaml"),
        "skill: demo\nversion: checked-in\n",
    )?;
    let resolved = resolve_local_skill_profile(&skill_dir, "demo")?;
    assert_eq!(resolved.source, LocalProfileSource::SkillProfile);
    assert!(
        resolved
            .profile_document
            .as_deref()
            .unwrap_or_default()
            .contains("checked-in")
    );
    Ok(())
}

#[test]
fn config_rejects_profile_skill_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let skill_dir = temp.path().join("skills/demo");
    fs::create_dir_all(&skill_dir)?;
    fs::write(skill_dir.join("X.yaml"), "skill: other\nversion: '0.1.0'\n")?;

    let error = match resolve_local_skill_profile(&skill_dir, "demo") {
        Ok(_) => return Err("mismatch should fail".into()),
        Err(error) => error,
    };
    assert!(matches!(error, ConfigError::ManifestSkillMismatch { .. }));
    Ok(())
}

fn env_map<const N: usize>(entries: [(&str, &str); N]) -> BTreeMap<String, String> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

#[cfg(unix)]
fn assert_private_file(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::PermissionsExt;

    let mode = fs::metadata(path)?.permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "{} mode was {mode:o}", path.display());
    Ok(())
}

#[cfg(not(unix))]
fn assert_private_file(_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}
