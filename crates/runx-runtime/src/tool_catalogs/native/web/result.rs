use runx_contracts::{JsonNumber, JsonObject, JsonValue};
use url::Url;

use super::ExtractMode;
use super::extract::extract_content;
use crate::RuntimeError;
use crate::http::RuntimeHttpResponse;

pub(super) fn success_result(
    attempted_host: &str,
    allowlist: &[String],
    mode: ExtractMode,
    final_url: Url,
    response: RuntimeHttpResponse,
    redirects: Vec<JsonValue>,
) -> Result<JsonObject, RuntimeError> {
    let status = response.status;
    let content_type = response_header(&response, "content-type")
        .unwrap_or_default()
        .to_owned();
    let extracted = extract_content(&response.body, mode, &final_url, &content_type)?;
    let (decision, blockers) = provider_status(status);
    let provenance = success_provenance(&response, redirects);
    Ok(JsonObject::from([
        (
            "decision".to_owned(),
            JsonValue::String(decision.to_owned()),
        ),
        (
            "final_url".to_owned(),
            JsonValue::String(final_url.to_string()),
        ),
        (
            "status".to_owned(),
            JsonValue::Number(JsonNumber::U64(u64::from(status))),
        ),
        (
            "content_digest".to_owned(),
            JsonValue::String(response.body_digest),
        ),
        (
            "extract_mode".to_owned(),
            JsonValue::String(mode.as_str().to_owned()),
        ),
        ("extracted".to_owned(), extracted),
        ("provenance".to_owned(), provenance),
        (
            "policy".to_owned(),
            policy("allowed", attempted_host, allowlist),
        ),
        ("blockers".to_owned(), JsonValue::Array(blockers)),
    ]))
}

fn provider_status(status: u16) -> (&'static str, Vec<JsonValue>) {
    if (200..300).contains(&status) {
        ("ready", Vec::new())
    } else {
        (
            "provider_error",
            vec![JsonValue::String(format!(
                "provider returned HTTP {status}"
            ))],
        )
    }
}

fn success_provenance(response: &RuntimeHttpResponse, redirects: Vec<JsonValue>) -> JsonValue {
    JsonValue::Object(JsonObject::from([
        (
            "fetched_at".to_owned(),
            JsonValue::String(crate::time::now_iso8601()),
        ),
        ("redirects".to_owned(), JsonValue::Array(redirects)),
        (
            "bytes".to_owned(),
            JsonValue::Number(JsonNumber::U64(response.body_bytes as u64)),
        ),
        ("truncated".to_owned(), JsonValue::Bool(response.truncated)),
    ]))
}

pub(super) fn failed_result(
    decision: &str,
    attempted_host: &str,
    allowlist: &[String],
    mode: ExtractMode,
    blocker: &str,
) -> JsonObject {
    JsonObject::from([
        (
            "decision".to_owned(),
            JsonValue::String(decision.to_owned()),
        ),
        ("final_url".to_owned(), JsonValue::String(String::new())),
        ("status".to_owned(), JsonValue::Number(JsonNumber::U64(0))),
        (
            "content_digest".to_owned(),
            JsonValue::String(String::new()),
        ),
        (
            "extract_mode".to_owned(),
            JsonValue::String(mode.as_str().to_owned()),
        ),
        ("extracted".to_owned(), mode.empty()),
        (
            "provenance".to_owned(),
            JsonValue::Object(JsonObject::from([
                ("fetched_at".to_owned(), JsonValue::String(String::new())),
                ("redirects".to_owned(), JsonValue::Array(Vec::new())),
                ("bytes".to_owned(), JsonValue::Number(JsonNumber::U64(0))),
                ("truncated".to_owned(), JsonValue::Bool(false)),
            ])),
        ),
        (
            "policy".to_owned(),
            policy("denied", attempted_host, allowlist),
        ),
        (
            "blockers".to_owned(),
            JsonValue::Array(vec![JsonValue::String(blocker.to_owned())]),
        ),
    ])
}

pub(super) fn wrapped(result: JsonObject) -> JsonValue {
    JsonValue::Object(JsonObject::from([(
        "fetch_result".to_owned(),
        JsonValue::Object(result),
    )]))
}

fn policy(decision: &str, attempted_host: &str, allowlist: &[String]) -> JsonValue {
    JsonValue::Object(JsonObject::from([
        (
            "allowlist_decision".to_owned(),
            JsonValue::String(decision.to_owned()),
        ),
        (
            "attempted_host".to_owned(),
            JsonValue::String(attempted_host.to_owned()),
        ),
        (
            "allowlist_checked".to_owned(),
            JsonValue::Array(allowlist.iter().cloned().map(JsonValue::String).collect()),
        ),
    ]))
}

fn response_header<'a>(response: &'a RuntimeHttpResponse, name: &str) -> Option<&'a str> {
    response
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}
