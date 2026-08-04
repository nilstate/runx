// Module rationale: local config, encrypted local key
// storage, managed-agent overlay, and profile resolution are one parity slice.
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, Generate, KeyInit, Nonce};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<RunxCredentialsConfig>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunxCredentialsConfig {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub profiles: BTreeMap<String, RunxCredentialProfile>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub defaults: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunxCredentialProfile {
    pub provider: String,
    pub auth_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
    pub secret_ref: String,
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
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_token_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<String>,
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
        let workspace = resolve_runx_workspace_base(env, cwd);
        for base in [workspace, admitted_cwd(cwd)] {
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
        || home_dir(env, cwd).join(".runx"),
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
    if let Some(credentials) = masked.credentials.as_mut() {
        for profile in credentials.profiles.values_mut() {
            profile.secret_ref = "[encrypted]".to_owned();
        }
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

pub fn store_local_credential_secret(
    config_dir: &Path,
    value: &str,
) -> Result<String, ConfigError> {
    store_local_config_secret_value(config_dir, value, "local_credential")
}

pub fn load_local_credential_secret(
    config_dir: &Path,
    secret_ref: &str,
) -> Result<String, ConfigError> {
    load_local_config_secret_value(config_dir, secret_ref)
}

pub fn remove_local_credential_secret(
    config_dir: &Path,
    secret_ref: &str,
) -> Result<(), ConfigError> {
    let path = config_dir.join("keys").join(format!("{secret_ref}.json"));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConfigError::Io(error)),
    }
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
    let nonce = config_nonce(&key_path, &nonce_bytes)?;
    let plaintext = cipher
        .decrypt(&nonce, sealed.as_ref())
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

type ConfigNonce = Nonce<Aes256Gcm>;

fn config_nonce(key_path: &Path, nonce_bytes: &[u8]) -> Result<ConfigNonce, ConfigError> {
    ConfigNonce::try_from(nonce_bytes).map_err(|_| {
        config_key_read_error(
            key_path,
            Some(format!(
                "expected 12-byte aes-256-gcm nonce, found {} bytes",
                nonce_bytes.len()
            )),
        )
    })
}

fn random_config_nonce() -> Result<ConfigNonce, ConfigError> {
    ConfigNonce::try_generate().map_err(|error| ConfigError::Crypto(error.to_string()))
}

fn random_config_secret_bytes() -> Result<[u8; 32], ConfigError> {
    <[u8; 32]>::try_generate().map_err(|error| ConfigError::Crypto(error.to_string()))
}

pub fn resolve_runx_workspace_base(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    env.get("RUNX_CWD")
        .map(|path| resolve_base_path(path, cwd))
        .or_else(|| env.get("INIT_CWD").map(|path| resolve_base_path(path, cwd)))
        .or_else(|| find_runx_workspace_root(&admitted_cwd(cwd)))
        .unwrap_or_else(|| admitted_cwd(cwd))
}

fn resolve_base_path(path: &str, cwd: &Path) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        admitted_cwd(cwd).join(path)
    }
}

fn admitted_cwd(cwd: &Path) -> PathBuf {
    cwd.to_path_buf()
}

fn find_runx_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join("pnpm-workspace.yaml").exists()
            || current.join(".runx").join("project.json").exists()
        {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn home_dir(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    env.get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.to_path_buf())
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
    let nonce = random_config_nonce()?;
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
            let secret_bytes = random_config_secret_bytes()?;
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
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn hex_prefix(bytes: &[u8], len: usize) -> String {
    let mut value = String::new();
    for byte in bytes {
        value.push_str(&format!("{byte:02x}"));
    }
    value.chars().take(len).collect()
}
