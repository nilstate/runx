//! Native bounded web retrieval and extraction.
//!
//! This is the reusable read surface for skills that need a page, not a local
//! JavaScript HTTP client. Runx owns SSRF protection, redirect admission,
//! response bounds, provenance, and extraction mechanics in one place.

use runx_contracts::{JsonNumber, JsonObject, JsonValue};
use url::Url;

mod capability;
mod extract;
mod output;
mod policy;
mod result;

pub(super) use capability::CAPABILITIES;
use capability::WebFetchInput;
use output::WebFetchOutput;

use policy::{host_allowed, normalize_allowlist, normalized_host, parse_web_url, safe_host};
use result::{failed_result, success_result, wrapped};

use super::NativeInvocation;
use super::capability::decode_typed_output;
use crate::RuntimeError;
use crate::http::{
    HttpMethod, ReqwestHttpTransport, RuntimeHttpError, RuntimeHttpHeader, RuntimeHttpRequest,
    RuntimeHttpResponse, STANDARD_HTTP_RESPONSE_BYTES,
};

const TOOL: &str = "web.fetch";
const MAX_WEB_FETCH_BYTES: usize = STANDARD_HTTP_RESPONSE_BYTES;
const MAX_REDIRECTS: usize = 10;

#[derive(Clone, Copy)]
enum ExtractMode {
    Text,
    Metadata,
    Links,
}

impl ExtractMode {
    fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "text" => Ok(Self::Text),
            "metadata" => Ok(Self::Metadata),
            "links" => Ok(Self::Links),
            _ => Err("extract must be text, metadata, or links"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Metadata => "metadata",
            Self::Links => "links",
        }
    }

    fn empty(self) -> JsonValue {
        match self {
            Self::Text => JsonValue::String(String::new()),
            Self::Metadata => JsonValue::Object(JsonObject::new()),
            Self::Links => JsonValue::Array(Vec::new()),
        }
    }
}

fn fetch(invocation: &NativeInvocation<'_, WebFetchInput>) -> Result<WebFetchOutput, RuntimeError> {
    let request = match FetchRequest::admit(invocation.inputs) {
        Ok(request) => request,
        Err(result) => return decode_typed_output(TOOL, wrapped(result)),
    };
    let transport = ReqwestHttpTransport::new()
        .map_err(|error| invalid(format!("native HTTP transport unavailable: {error}")))?;
    let output = match fetch_redirects(
        &transport,
        request.initial_url,
        &request.allowlist,
        request.max_bytes,
    ) {
        Ok((final_url, response, redirects)) => success_result(
            &request.initial_host,
            &request.allowlist,
            request.mode,
            final_url,
            response,
            redirects,
        )
        .map(wrapped),
        Err(FetchError::Policy { host, message }) => Ok(wrapped(failed_result(
            "policy_denied",
            &host,
            &request.allowlist,
            request.mode,
            &message,
        ))),
        Err(FetchError::Provider(message)) => Ok(wrapped(failed_result(
            "provider_error",
            &request.initial_host,
            &request.allowlist,
            request.mode,
            &message,
        ))),
    }?;
    decode_typed_output(TOOL, output)
}

struct FetchRequest {
    initial_url: Url,
    initial_host: String,
    allowlist: Vec<String>,
    mode: ExtractMode,
    max_bytes: usize,
}

impl FetchRequest {
    // Function rationale: request admission is one fail-closed
    // security boundary over URL syntax, host allowlisting, and response bounds.
    fn admit(inputs: &WebFetchInput) -> Result<Self, JsonObject> {
        let raw_url = inputs.url.trim();
        let attempted_host = safe_host(raw_url);
        let mode = ExtractMode::parse(inputs.extract.trim()).map_err(|blocker| {
            failed_result(
                "needs_agent",
                &attempted_host,
                &[],
                ExtractMode::Text,
                blocker,
            )
        })?;
        let allowlist = normalize_allowlist(&inputs.allowlist).map_err(|blocker| {
            failed_result("needs_agent", &attempted_host, &[], mode, &blocker)
        })?;
        if raw_url.is_empty() || allowlist.is_empty() {
            let mut blockers = Vec::new();
            if raw_url.is_empty() {
                blockers.push(JsonValue::String("url is missing".to_owned()));
            }
            if allowlist.is_empty() {
                blockers.push(JsonValue::String("allowlist is missing".to_owned()));
            }
            let mut result = failed_result(
                "needs_agent",
                &attempted_host,
                &allowlist,
                mode,
                "missing required input",
            );
            result.insert("blockers".to_owned(), JsonValue::Array(blockers));
            return Err(result);
        }
        let max_bytes = usize::try_from(inputs.max_bytes)
            .ok()
            .filter(|value| (1..=MAX_WEB_FETCH_BYTES).contains(value))
            .ok_or_else(|| {
                failed_result(
                    "needs_agent",
                    &attempted_host,
                    &allowlist,
                    mode,
                    "max_bytes must be a positive integer no greater than 8388608",
                )
            })?;
        let initial_url = parse_web_url(raw_url).map_err(|blocker| {
            failed_result("needs_agent", &attempted_host, &allowlist, mode, &blocker)
        })?;
        let initial_host = normalized_host(&initial_url).unwrap_or_default();
        if !host_allowed(&initial_host, &allowlist) {
            return Err(failed_result(
                "policy_denied",
                &initial_host,
                &allowlist,
                mode,
                &format!("host {initial_host:?} is not allowlisted"),
            ));
        }
        Ok(Self {
            initial_url,
            initial_host,
            allowlist,
            mode,
            max_bytes,
        })
    }
}

enum FetchError {
    Policy { host: String, message: String },
    Provider(String),
}

fn fetch_redirects(
    transport: &ReqwestHttpTransport,
    start_url: Url,
    allowlist: &[String],
    max_bytes: usize,
) -> Result<(Url, RuntimeHttpResponse, Vec<JsonValue>), FetchError> {
    let mut current = start_url;
    let mut redirects = Vec::new();
    for hop in 0..=MAX_REDIRECTS {
        let response = transport
            .send_bounded(
                RuntimeHttpRequest {
                    method: HttpMethod::Get,
                    url: current.to_string(),
                    headers: vec![RuntimeHttpHeader::new(
                        "accept",
                        "text/html, text/plain, application/json;q=0.9, */*;q=0.1",
                    )],
                    body: None,
                },
                max_bytes,
            )
            .map_err(classify_transport_error)?;
        if !(300..400).contains(&response.status) {
            return Ok((current, response, redirects));
        }
        let next = admit_redirect(&current, &response, allowlist, hop)?;
        redirects.push(redirect_record(&current, &next, response.status));
        current = next;
    }
    Err(FetchError::Provider(
        "redirect loop did not terminate".to_owned(),
    ))
}

fn admit_redirect(
    current: &Url,
    response: &RuntimeHttpResponse,
    allowlist: &[String],
    hop: usize,
) -> Result<Url, FetchError> {
    let location = response_header(response, "location").ok_or_else(|| {
        FetchError::Provider(format!(
            "provider returned redirect HTTP {} without a location",
            response.status
        ))
    })?;
    if hop == MAX_REDIRECTS {
        return Err(FetchError::Provider(format!(
            "provider exceeded {MAX_REDIRECTS} redirects"
        )));
    }
    let next = current
        .join(location)
        .map_err(|error| FetchError::Provider(format!("invalid redirect URL: {error}")))?;
    parse_web_url(next.as_str()).map_err(FetchError::Provider)?;
    let next_host = normalized_host(&next).unwrap_or_default();
    if !host_allowed(&next_host, allowlist) {
        return Err(FetchError::Policy {
            host: next_host.clone(),
            message: format!("redirect host {next_host:?} is not allowlisted"),
        });
    }
    Ok(next)
}

fn redirect_record(from: &Url, to: &Url, status: u16) -> JsonValue {
    JsonValue::Object(JsonObject::from([
        (
            "status".to_owned(),
            JsonValue::Number(JsonNumber::U64(u64::from(status))),
        ),
        ("from".to_owned(), JsonValue::String(from.to_string())),
        ("to".to_owned(), JsonValue::String(to.to_string())),
    ]))
}

fn classify_transport_error(error: RuntimeHttpError) -> FetchError {
    match error {
        RuntimeHttpError::PrivateNetworkUrl { host } => FetchError::Policy {
            message: format!("host {host:?} is not publicly routable"),
            host,
        },
        other => FetchError::Provider(other.to_string()),
    }
}

fn response_header<'a>(response: &'a RuntimeHttpResponse, name: &str) -> Option<&'a str> {
    response
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn invalid(message: impl Into<String>) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: TOOL.to_owned(),
        message: message.into(),
    }
}
