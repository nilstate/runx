use thiserror::Error;

/// The environment boundary is string-only, while provider capabilities are
/// opaque strings. JSON is the one lossless transport for that typed list:
/// delimiters inside a provider-defined capability never acquire Runx meaning.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error(
    "RUNX_PROVIDER_PERMISSION_GRANTED_SCOPES must contain a JSON array of non-blank provider capability strings"
)]
pub struct ProviderScopeTransportError;

pub fn encode_provider_scopes_env(
    scopes: &[String],
) -> Result<String, ProviderScopeTransportError> {
    validate_provider_scopes(scopes)?;
    serde_json::to_string(scopes).map_err(|_| ProviderScopeTransportError)
}

pub fn decode_provider_scopes_env(value: &str) -> Result<Vec<String>, ProviderScopeTransportError> {
    let scopes =
        serde_json::from_str::<Vec<String>>(value).map_err(|_| ProviderScopeTransportError)?;
    validate_provider_scopes(&scopes)?;
    Ok(scopes)
}

fn validate_provider_scopes(scopes: &[String]) -> Result<(), ProviderScopeTransportError> {
    if scopes.is_empty() || scopes.iter().any(|scope| scope.trim().is_empty()) {
        return Err(ProviderScopeTransportError);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_transport_round_trips_opaque_capabilities_exactly()
    -> Result<(), ProviderScopeTransportError> {
        let scopes = vec![
            "vendor.operation:v3".to_owned(),
            "https://provider.example/auth/custom.scope?mode=read,write".to_owned(),
            "opaque capability with spaces".to_owned(),
            "vendor.operation:v3".to_owned(),
        ];

        let encoded = encode_provider_scopes_env(&scopes)?;
        let decoded = decode_provider_scopes_env(&encoded)?;

        assert_eq!(decoded, scopes);
        Ok(())
    }

    #[test]
    fn environment_transport_rejects_delimited_and_blank_surrogates() {
        assert!(decode_provider_scopes_env("repo.read,repo.write").is_err());
        assert!(decode_provider_scopes_env(r#"["repo.read", " "]"#).is_err());
        assert!(encode_provider_scopes_env(&[]).is_err());
    }
}
