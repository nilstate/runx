// rust-style-allow: large-file because local config, encrypted local key
// storage, managed-agent overlay, and profile resolution are one parity slice.
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runx_contracts::JsonValue;
use runx_contracts::schema::NonEmptyString;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::credentials::SecretString;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunxConfigFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<RunxAgentConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public: Option<RunxPublicConfig>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunxAgentConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_ref: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunxPublicConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_token_ref: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigKey {
    AgentProvider,
    AgentModel,
    AgentApiKey,
    PublicApiToken,
}

/// Canonical managed agent provider identifiers. The wire form on
/// `ManagedAgentConfig::provider` is an open `NonEmptyString`; this module is
/// for discoverability and shared default constants.
pub mod managed_agent_provider {
    /// OpenAI-compatible chat completion API.
    pub const OPENAI: &str = "openai";
    /// Anthropic Messages API.
    pub const ANTHROPIC: &str = "anthropic";
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedAgentConfig {
    /// Open provider identifier (e.g. `managed_agent_provider::OPENAI`). Any
    /// non-empty string is accepted; new providers do not need a code edit.
    pub provider: NonEmptyString,
    pub model: String,
    pub api_key: SecretString,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalProfileSource {
    ProfileState,
    SkillProfile,
    WorkspaceBindings,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedLocalProfile {
    pub profile_document: Option<String>,
    pub profile_source_path: Option<PathBuf>,
    pub source: LocalProfileSource,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("{path} is not valid JSON: {message}")]
    InvalidJson { path: PathBuf, message: String },
    #[error("{path} must contain a JSON object.")]
    NonObjectJson { path: PathBuf },
    #[error("unsupported runx config key {key}")]
    UnsupportedKey { key: String },
    #[error("runx local agent key corrupted or unreadable at {path}{suffix}")]
    LocalAgentKeyCorrupt { path: PathBuf, suffix: String },
    #[error("Skill profile state is not valid JSON: {path}")]
    InvalidProfileStateJson { path: PathBuf },
    #[error("Skill profile state must be an object: {path}")]
    NonObjectProfileState { path: PathBuf },
    #[error(
        "Binding manifest skill '{manifest_skill}' does not match skill '{skill_name}': {path}"
    )]
    ManifestSkillMismatch {
        manifest_skill: String,
        skill_name: String,
        path: PathBuf,
    },
    #[error(
        "Skill package '{skill_directory}' resolves to binding path {owner}/{binding_skill}, but SKILL.md declares '{skill_name}'."
    )]
    BindingLocatorMismatch {
        skill_directory: PathBuf,
        owner: String,
        binding_skill: String,
        skill_name: String,
    },
    #[error("config crypto failed: {0}")]
    Crypto(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

pub fn parse_config_key(key: &str) -> Result<ConfigKey, ConfigError> {
    match key {
        "agent.provider" => Ok(ConfigKey::AgentProvider),
        "agent.model" => Ok(ConfigKey::AgentModel),
        "agent.api_key" => Ok(ConfigKey::AgentApiKey),
        "public.api_token" => Ok(ConfigKey::PublicApiToken),
        _ => Err(ConfigError::UnsupportedKey {
            key: key.to_owned(),
        }),
    }
}

pub fn resolve_path_from_user_input(
    user_path: &str,
    env: &BTreeMap<String, String>,
    cwd: &Path,
    prefer_existing: bool,
) -> PathBuf {
    let path = Path::new(user_path);
    if path.is_absolute() {
        return path.to_path_buf();
    }
    if prefer_existing {
        for base in [
            env.get("RUNX_CWD").map(PathBuf::from),
            env.get("INIT_CWD").map(PathBuf::from),
            find_runx_workspace_root(cwd),
            Some(cwd.to_path_buf()),
        ]
        .into_iter()
        .flatten()
        {
            let candidate = base.join(path);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    resolve_runx_workspace_base(env, cwd).join(path)
}

pub fn resolve_runx_global_home_dir(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    env.get("RUNX_HOME").map_or_else(
        || home_dir().join(".runx"),
        |home| resolve_path_from_user_input(home, env, cwd, false),
    )
}

pub fn resolve_runx_home_dir(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    resolve_runx_global_home_dir(env, cwd)
}

pub fn load_runx_config_file(config_path: &Path) -> Result<RunxConfigFile, ConfigError> {
    let contents = match fs::read_to_string(config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RunxConfigFile::default());
        }
        Err(error) => return Err(ConfigError::Io(error)),
    };
    let value =
        serde_json::from_str::<JsonValue>(&contents).map_err(|error| ConfigError::InvalidJson {
            path: config_path.to_path_buf(),
            message: error.to_string(),
        })?;
    if !matches!(value, JsonValue::Object(_)) {
        return Err(ConfigError::NonObjectJson {
            path: config_path.to_path_buf(),
        });
    }
    serde_json::from_str(&contents).map_err(|error| ConfigError::InvalidJson {
        path: config_path.to_path_buf(),
        message: error.to_string(),
    })
}

pub fn write_runx_config_file(
    config_path: &Path,
    config: &RunxConfigFile,
) -> Result<(), ConfigError> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let contents =
        serde_json::to_string_pretty(config).map_err(|error| ConfigError::InvalidJson {
            path: config_path.to_path_buf(),
            message: error.to_string(),
        })?;
    write_private_file(config_path, format!("{contents}\n").as_bytes())
}

pub fn update_runx_config_value(
    mut config: RunxConfigFile,
    key: ConfigKey,
    value: &str,
    config_dir: &Path,
) -> Result<RunxConfigFile, ConfigError> {
    match key {
        ConfigKey::AgentProvider => {
            let mut agent = config.agent.unwrap_or_default();
            agent.provider = Some(value.to_owned());
            config.agent = Some(agent);
        }
        ConfigKey::AgentModel => {
            let mut agent = config.agent.unwrap_or_default();
            agent.model = Some(value.to_owned());
            config.agent = Some(agent);
        }
        ConfigKey::AgentApiKey => {
            let mut agent = config.agent.unwrap_or_default();
            agent.api_key_ref = Some(store_local_agent_api_key(config_dir, value)?);
            config.agent = Some(agent);
        }
        ConfigKey::PublicApiToken => {
            let mut public = config.public.unwrap_or_default();
            public.api_token_ref = Some(store_local_public_api_token(config_dir, value)?);
            config.public = Some(public);
        }
    }
    Ok(config)
}

pub fn lookup_runx_config_value(config: &RunxConfigFile, key: ConfigKey) -> Option<String> {
    match key {
        ConfigKey::AgentProvider => config.agent.as_ref()?.provider.clone(),
        ConfigKey::AgentModel => config.agent.as_ref()?.model.clone(),
        ConfigKey::AgentApiKey => config
            .agent
            .as_ref()?
            .api_key_ref
            .as_ref()
            .map(|_| "[encrypted]".to_owned()),
        ConfigKey::PublicApiToken => config
            .public
            .as_ref()?
            .api_token_ref
            .as_ref()
            .map(|_| "[encrypted]".to_owned()),
    }
}

pub fn mask_runx_config_file(config: &RunxConfigFile) -> RunxConfigFile {
    let mut masked = config.clone();
    if let Some(agent) = masked.agent.as_mut()
        && agent.api_key_ref.is_some()
    {
        agent.api_key_ref = Some("[encrypted]".to_owned());
    }
    if let Some(public) = masked.public.as_mut()
        && public.api_token_ref.is_some()
    {
        public.api_token_ref = Some("[encrypted]".to_owned());
    }
    masked
}

pub fn load_local_agent_api_key(config_dir: &Path, key_ref: &str) -> Result<String, ConfigError> {
    load_local_config_secret_value(config_dir, key_ref)
}

pub fn load_local_public_api_token(
    config_dir: &Path,
    token_ref: &str,
) -> Result<String, ConfigError> {
    load_local_config_secret_value(config_dir, token_ref)
}

fn load_local_config_secret_value(config_dir: &Path, key_ref: &str) -> Result<String, ConfigError> {
    let key_path = config_dir.join("keys").join(format!("{key_ref}.json"));
    let payload = load_key_payload(&key_path)?;
    if payload.alg != "aes-256-gcm" {
        return Err(config_key_read_error(&key_path, None));
    }
    let secret = load_or_create_local_config_secret(&config_dir.join("keys"))?;
    let key = Sha256::digest(secret.as_bytes());
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|error| ConfigError::Crypto(error.to_string()))?;
    let nonce_bytes = decode_key_part(&key_path, &payload.iv)?;
    let ciphertext = decode_key_part(&key_path, &payload.ciphertext)?;
    let auth_tag = decode_key_part(&key_path, &payload.auth_tag)?;
    let mut sealed = ciphertext;
    sealed.extend(auth_tag);
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), sealed.as_ref())
        .map_err(|error| config_key_read_error(&key_path, Some(error.to_string())))?;
    String::from_utf8(plaintext)
        .map_err(|error| config_key_read_error(&key_path, Some(error.to_string())))
}

pub fn load_managed_agent_config(
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Option<ManagedAgentConfig>, ConfigError> {
    let config_dir = resolve_runx_home_dir(env, cwd);
    let config = load_runx_config_file(&config_dir.join("config.json"))?;
    let provider = env
        .get("RUNX_AGENT_PROVIDER")
        .or_else(|| {
            config
                .agent
                .as_ref()
                .and_then(|agent| agent.provider.as_ref())
        })
        .and_then(|value| normalize_managed_agent_provider(value));
    let Some(provider) = provider else {
        return Ok(None);
    };
    let model = env
        .get("RUNX_AGENT_MODEL")
        .or_else(|| config.agent.as_ref().and_then(|agent| agent.model.as_ref()))
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
    if model.is_empty() {
        return Ok(None);
    }
    let provider_env_var = managed_agent_provider_env_var(&provider);
    let provider_key = env.get(&provider_env_var);
    let mut api_key = env
        .get("RUNX_AGENT_API_KEY")
        .or(provider_key)
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
    if api_key.is_empty()
        && let Some(key_ref) = config
            .agent
            .as_ref()
            .and_then(|agent| agent.api_key_ref.as_ref())
            .filter(|value| !value.is_empty())
    {
        api_key = load_local_agent_api_key(&config_dir, key_ref)?
            .trim()
            .to_owned();
    }
    if api_key.is_empty() {
        return Ok(None);
    }
    Ok(Some(ManagedAgentConfig {
        provider,
        model,
        api_key: SecretString::new(api_key),
    }))
}

pub fn resolve_local_skill_profile(
    skill_path: &Path,
    skill_name: &str,
) -> Result<ResolvedLocalProfile, ConfigError> {
    let metadata = fs::metadata(skill_path)?;
    let skill_directory = if metadata.is_dir() {
        skill_path.to_path_buf()
    } else {
        skill_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    };
    if let Some(profile) = read_skill_profile(&skill_directory, skill_name)? {
        return Ok(profile);
    }
    if let Some(profile) = read_profile_state(&skill_directory, skill_name)? {
        return Ok(profile);
    }
    for binding_root in collect_binding_roots(&skill_directory) {
        if let Some(profile) = read_workspace_profile(&skill_directory, &binding_root, skill_name)?
        {
            return Ok(profile);
        }
    }
    Ok(ResolvedLocalProfile {
        profile_document: None,
        profile_source_path: None,
        source: LocalProfileSource::None,
    })
}

#[derive(Deserialize)]
struct LocalConfigSecretPayload {
    alg: String,
    iv: String,
    ciphertext: String,
    auth_tag: String,
}

#[derive(Serialize)]
struct StoredLocalConfigSecretPayload<'a> {
    #[serde(rename = "ref")]
    key_ref: &'a str,
    alg: &'static str,
    iv: String,
    ciphertext: String,
    auth_tag: String,
}

fn resolve_runx_workspace_base(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    env.get("RUNX_CWD")
        .map(PathBuf::from)
        .or_else(|| find_runx_workspace_root(cwd))
        .or_else(|| env.get("INIT_CWD").map(PathBuf::from))
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn find_runx_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join("pnpm-workspace.yaml").exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn store_local_agent_api_key(config_dir: &Path, api_key: &str) -> Result<String, ConfigError> {
    store_local_config_secret_value(config_dir, api_key, "local_agent_key")
}

fn store_local_public_api_token(config_dir: &Path, api_token: &str) -> Result<String, ConfigError> {
    store_local_config_secret_value(config_dir, api_token, "local_public_api_token")
}

fn store_local_config_secret_value(
    config_dir: &Path,
    value: &str,
    ref_prefix: &str,
) -> Result<String, ConfigError> {
    let key_dir = config_dir.join("keys");
    fs::create_dir_all(&key_dir)?;
    let secret = load_or_create_local_config_secret(&key_dir)?;
    let key = Sha256::digest(secret.as_bytes());
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|error| ConfigError::Crypto(error.to_string()))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut sealed = cipher
        .encrypt(&nonce, value.as_bytes())
        .map_err(|error| ConfigError::Crypto(error.to_string()))?;
    let auth_tag = sealed.split_off(sealed.len().saturating_sub(16));
    let key_ref = format!(
        "{ref_prefix}_{}",
        hex_prefix(
            &Sha256::digest([nonce.as_slice(), sealed.as_slice()].concat()),
            24
        )
    );
    let payload = StoredLocalConfigSecretPayload {
        key_ref: &key_ref,
        alg: "aes-256-gcm",
        iv: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(sealed),
        auth_tag: URL_SAFE_NO_PAD.encode(auth_tag),
    };
    let contents = serde_json::to_string_pretty(&payload)
        .map_err(|error| ConfigError::Crypto(error.to_string()))?;
    write_private_file(
        &key_dir.join(format!("{key_ref}.json")),
        format!("{contents}\n").as_bytes(),
    )?;
    Ok(key_ref)
}

fn load_or_create_local_config_secret(key_dir: &Path) -> Result<String, ConfigError> {
    fs::create_dir_all(key_dir)?;
    let key_path = key_dir.join("local-config-secret");
    match fs::read_to_string(&key_path) {
        Ok(secret) => Ok(secret),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut secret_bytes = [0_u8; 32];
            OsRng.fill_bytes(&mut secret_bytes);
            let secret = URL_SAFE_NO_PAD.encode(secret_bytes);
            match write_private_file_new(&key_path, secret.as_bytes()) {
                Ok(()) => Ok(secret),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    Ok(fs::read_to_string(&key_path)?)
                }
                Err(error) => Err(ConfigError::Io(error)),
            }
        }
        Err(error) => Err(ConfigError::Io(error)),
    }
}

fn load_key_payload(key_path: &Path) -> Result<LocalConfigSecretPayload, ConfigError> {
    let contents = fs::read_to_string(key_path)
        .map_err(|error| config_key_read_error(key_path, Some(error.to_string())))?;
    serde_json::from_str(&contents)
        .map_err(|error| config_key_read_error(key_path, Some(error.to_string())))
}

fn decode_key_part(key_path: &Path, value: &str) -> Result<Vec<u8>, ConfigError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|error| config_key_read_error(key_path, Some(error.to_string())))
}

fn config_key_read_error(path: &Path, cause: Option<String>) -> ConfigError {
    ConfigError::LocalAgentKeyCorrupt {
        path: path.to_path_buf(),
        suffix: cause.map_or_else(String::new, |message| format!(": {message}")),
    }
}

fn normalize_managed_agent_provider(value: &str) -> Option<NonEmptyString> {
    NonEmptyString::new(value.trim().to_lowercase())
}

/// Derive the env var name that carries the API key for a given managed agent
/// provider. Follows the `<UPPERCASED>_API_KEY` convention (e.g. `OPENAI_API_KEY`,
/// `ANTHROPIC_API_KEY`), so new providers work without a code edit. Callers can
/// always override via `RUNX_AGENT_API_KEY`.
fn managed_agent_provider_env_var(provider: &NonEmptyString) -> String {
    format!("{}_API_KEY", provider.as_ref().to_uppercase())
}

fn read_skill_profile(
    skill_directory: &Path,
    skill_name: &str,
) -> Result<Option<ResolvedLocalProfile>, ConfigError> {
    let path = skill_directory.join("X.yaml");
    let Some(document) = read_optional_file(&path)? else {
        return Ok(None);
    };
    validate_manifest_skill(&path, &document, skill_name)?;
    Ok(Some(ResolvedLocalProfile {
        profile_document: Some(document),
        profile_source_path: Some(path),
        source: LocalProfileSource::SkillProfile,
    }))
}

fn read_profile_state(
    skill_directory: &Path,
    skill_name: &str,
) -> Result<Option<ResolvedLocalProfile>, ConfigError> {
    let path = skill_directory.join(".runx").join("profile.json");
    let Some(document) = read_optional_file(&path)? else {
        return Ok(None);
    };
    let value = serde_json::from_str::<JsonValue>(&document)
        .map_err(|_| ConfigError::InvalidProfileStateJson { path: path.clone() })?;
    let JsonValue::Object(object) = value else {
        return Err(ConfigError::NonObjectProfileState { path });
    };
    let Some(JsonValue::Object(profile)) = object.get("profile") else {
        return Ok(None);
    };
    let Some(profile_document) = profile
        .get("document")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    validate_manifest_skill(&path, profile_document, skill_name)?;
    Ok(Some(ResolvedLocalProfile {
        profile_document: Some(profile_document.to_owned()),
        profile_source_path: Some(path),
        source: LocalProfileSource::ProfileState,
    }))
}

fn collect_binding_roots(start: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut current = start.to_path_buf();
    loop {
        let candidate = current.join("bindings");
        if candidate.exists() && !roots.contains(&candidate) {
            roots.push(candidate);
        }
        if !current.pop() {
            break;
        }
    }
    roots
}

fn read_workspace_profile(
    skill_directory: &Path,
    binding_root: &Path,
    skill_name: &str,
) -> Result<Option<ResolvedLocalProfile>, ConfigError> {
    let Some((owner, binding_skill)) = resolve_binding_locator(skill_directory, binding_root)
    else {
        return Ok(None);
    };
    if binding_skill != skill_name {
        return Err(ConfigError::BindingLocatorMismatch {
            skill_directory: skill_directory.to_path_buf(),
            owner,
            binding_skill,
            skill_name: skill_name.to_owned(),
        });
    }
    let path = binding_root
        .join(&owner)
        .join(&binding_skill)
        .join("X.yaml");
    let Some(document) = read_optional_file(&path)? else {
        return Ok(None);
    };
    validate_manifest_skill(&path, &document, skill_name)?;
    Ok(Some(ResolvedLocalProfile {
        profile_document: Some(document),
        profile_source_path: Some(path),
        source: LocalProfileSource::WorkspaceBindings,
    }))
}

fn resolve_binding_locator(
    skill_directory: &Path,
    binding_root: &Path,
) -> Option<(String, String)> {
    let binding_container = binding_root.parent()?;
    let relative = skill_directory.strip_prefix(binding_container).ok()?;
    let segments = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let skill_segments = (segments.first()? == "skills").then_some(&segments[1..])?;
    match skill_segments {
        [skill] => Some(("runx".to_owned(), skill.clone())),
        [owner, skill] => Some((owner.clone(), skill.clone())),
        _ => None,
    }
}

fn validate_manifest_skill(
    path: &Path,
    manifest_text: &str,
    skill_name: &str,
) -> Result<(), ConfigError> {
    let value = serde_norway::from_str::<JsonValue>(manifest_text).map_err(|error| {
        ConfigError::InvalidJson {
            path: path.to_path_buf(),
            message: error.to_string(),
        }
    })?;
    let manifest_skill = match &value {
        JsonValue::Object(object) => object.get("skill").and_then(JsonValue::as_str),
        _ => None,
    };
    if let Some(manifest_skill) = manifest_skill
        && manifest_skill != skill_name
    {
        return Err(ConfigError::ManifestSkillMismatch {
            manifest_skill: manifest_skill.to_owned(),
            skill_name: skill_name.to_owned(),
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn read_optional_file(path: &Path) -> Result<Option<String>, ConfigError> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ConfigError::Io(error)),
    }
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    set_private_permissions(path)?;
    Ok(())
}

fn write_private_file_new(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(path)?;
    file.write_all(contents)
}

fn set_private_permissions(path: &Path) -> Result<(), ConfigError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn hex_prefix(bytes: &[u8], len: usize) -> String {
    let mut value = String::new();
    for byte in bytes {
        value.push_str(&format!("{byte:02x}"));
    }
    value.chars().take(len).collect()
}
