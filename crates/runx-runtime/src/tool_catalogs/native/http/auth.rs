use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use runx_contracts::JsonObject;
use serde::Deserialize;
use url::Url;

use super::super::NativeInvocation;
use super::invalid;
use super::resolution::{percent_encode, required_string};
use crate::RuntimeError;
use crate::http::{HttpMethod, RuntimeHttpHeader};

#[derive(Clone, Debug)]
pub(super) enum RequestAuth {
    None,
    Bearer { secret_env: String },
    OAuth1 { secret_env: String },
}

impl RequestAuth {
    pub(super) const fn uses_credential(&self) -> bool {
        !matches!(self, Self::None)
    }
}

#[derive(Debug, Deserialize)]
struct OAuth1Credential {
    consumer_key: String,
    consumer_secret: String,
    access_token: String,
    access_secret: String,
}

pub(super) fn request_auth(auth: Option<&JsonObject>) -> Result<RequestAuth, RuntimeError> {
    let Some(auth) = auth else {
        return Ok(RequestAuth::None);
    };
    let auth_type = required_string(auth, "type")?;
    let secret_env = required_string(auth, "secret_env")?.to_owned();
    match auth_type {
        "bearer" => Ok(RequestAuth::Bearer { secret_env }),
        "oauth1" => Ok(RequestAuth::OAuth1 { secret_env }),
        other => Err(invalid(format!(
            "auth.type {other:?} must be bearer or oauth1"
        ))),
    }
}

pub(super) fn apply_auth<I: ?Sized>(
    headers: &mut Vec<RuntimeHttpHeader>,
    method: HttpMethod,
    url: &Url,
    auth: &RequestAuth,
    invocation: &NativeInvocation<'_, I>,
) -> Result<(), RuntimeError> {
    let secret_env = invocation.credential_delivery.secret_env();
    match auth {
        RequestAuth::None => Ok(()),
        RequestAuth::Bearer { secret_env: name } => {
            let token = secret_env
                .get(name)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(format!("delivered secret {name} is missing")))?;
            headers.push(RuntimeHttpHeader::new(
                "authorization",
                format!("Bearer {token}"),
            ));
            Ok(())
        }
        RequestAuth::OAuth1 { secret_env: name } => {
            let raw = secret_env
                .get(name)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(format!("delivered secret {name} is missing")))?;
            let credential: OAuth1Credential = serde_json::from_str(raw).map_err(|_| {
                invalid(format!("delivered secret {name} is not valid OAuth1 JSON"))
            })?;
            validate_oauth1_credential(&credential, name)?;
            headers.push(RuntimeHttpHeader::new(
                "authorization",
                oauth1_header(method, url, &credential)?,
            ));
            Ok(())
        }
    }
}

fn validate_oauth1_credential(
    credential: &OAuth1Credential,
    secret_env: &str,
) -> Result<(), RuntimeError> {
    if [
        &credential.consumer_key,
        &credential.consumer_secret,
        &credential.access_token,
        &credential.access_secret,
    ]
    .into_iter()
    .any(|value| value.is_empty())
    {
        return Err(invalid(format!(
            "delivered secret {secret_env} has incomplete OAuth1 material"
        )));
    }
    Ok(())
}

fn oauth1_header(
    method: HttpMethod,
    url: &Url,
    credential: &OAuth1Credential,
) -> Result<String, RuntimeError> {
    let mut oauth = oauth1_parameters(credential)?;
    let parameter_string = signature_parameter_string(url, &oauth);
    let base_string = signature_base_string(method, url, &parameter_string);
    oauth.insert(
        "oauth_signature".to_owned(),
        sign_oauth1(&base_string, credential),
    );
    Ok(render_oauth1_header(&oauth))
}

fn oauth1_parameters(
    credential: &OAuth1Credential,
) -> Result<BTreeMap<String, String>, RuntimeError> {
    let mut nonce = [0_u8; 16];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| invalid("generating OAuth1 nonce"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid("system clock is before the Unix epoch"))?
        .as_secs()
        .to_string();
    Ok(BTreeMap::from([
        (
            "oauth_consumer_key".to_owned(),
            credential.consumer_key.clone(),
        ),
        ("oauth_nonce".to_owned(), hex(&nonce)),
        ("oauth_signature_method".to_owned(), "HMAC-SHA1".to_owned()),
        ("oauth_timestamp".to_owned(), timestamp),
        ("oauth_token".to_owned(), credential.access_token.clone()),
        ("oauth_version".to_owned(), "1.0".to_owned()),
    ]))
}

fn signature_parameter_string(url: &Url, oauth: &BTreeMap<String, String>) -> String {
    let mut signature_params = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    signature_params.extend(
        oauth
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    signature_params.sort_by(|left, right| {
        let left = (percent_encode(&left.0), percent_encode(&left.1));
        let right = (percent_encode(&right.0), percent_encode(&right.1));
        left.cmp(&right)
    });
    signature_params
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn signature_base_string(method: HttpMethod, url: &Url, parameter_string: &str) -> String {
    let mut base_url = url.clone();
    base_url.set_query(None);
    base_url.set_fragment(None);
    format!(
        "{}&{}&{}",
        method.as_str(),
        percent_encode(base_url.as_str()),
        percent_encode(parameter_string)
    )
}

fn sign_oauth1(base_string: &str, credential: &OAuth1Credential) -> String {
    let signing_key = format!(
        "{}&{}",
        percent_encode(&credential.consumer_secret),
        percent_encode(&credential.access_secret)
    );
    let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, signing_key.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(hmac::sign(&key, base_string.as_bytes()))
}

fn render_oauth1_header(oauth: &BTreeMap<String, String>) -> String {
    format!(
        "OAuth {}",
        oauth
            .iter()
            .map(|(key, value)| format!("{}=\"{}\"", percent_encode(key), percent_encode(value)))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}
