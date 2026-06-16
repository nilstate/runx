use std::collections::BTreeMap;
use std::path::Path;

use runx_runtime::{
    ConfigError, load_local_public_api_token, load_runx_config_file, resolve_runx_home_dir,
};

pub(crate) fn resolve(
    explicit_token: Option<&str>,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Option<String>, ConfigError> {
    if let Some(token) = non_empty_token(explicit_token) {
        return Ok(Some(token));
    }
    if let Some(token) = non_empty_token(env.get("RUNX_PUBLIC_API_TOKEN").map(String::as_str)) {
        return Ok(Some(token));
    }
    if let Some(token) = non_empty_token(env.get("RUNX_CONNECT_ACCESS_TOKEN").map(String::as_str)) {
        return Ok(Some(token));
    }
    let config_dir = resolve_runx_home_dir(env, cwd);
    let config = load_runx_config_file(&config_dir.join("config.json"))?;
    let Some(token_ref) = config
        .public
        .and_then(|public| public.api_token_ref)
        .and_then(|value| non_empty_token(Some(&value)))
    else {
        return Ok(None);
    };
    Ok(Some(
        load_local_public_api_token(&config_dir, &token_ref)?
            .trim()
            .to_owned(),
    ))
}

fn non_empty_token(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
