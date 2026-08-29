use std::collections::{BTreeMap, BTreeSet};

use runx_contracts::{JsonNumber, JsonObject, JsonValue};

use super::super::NativeInvocation;
use super::HttpBatchInput;
use super::auth::{RequestAuth, request_auth};
use super::request::{RequestExecution, execute_one};
use super::resolution::{allowed_hosts, estimated_size, json_u64, method, required_string};
use super::{BatchMode, MAX_HTTP_OUTPUT_BYTES, MAX_REQUESTS, invalid};
use crate::RuntimeError;
use crate::http::NativeHttpTransport;

struct BatchAccumulator {
    seen_ids: BTreeSet<String>,
    prior: BTreeMap<String, JsonObject>,
    responses: Vec<JsonValue>,
    stopped: bool,
    output_bytes: usize,
    request_count: u64,
}

impl BatchAccumulator {
    fn new() -> Self {
        Self {
            seen_ids: BTreeSet::new(),
            prior: BTreeMap::new(),
            responses: Vec::new(),
            stopped: false,
            output_bytes: 0,
            request_count: 0,
        }
    }

    fn admit_id(&mut self, request_id: &str) -> Result<(), RuntimeError> {
        if self.seen_ids.insert(request_id.to_owned()) {
            Ok(())
        } else {
            Err(invalid(format!("duplicate request id {request_id:?}")))
        }
    }

    fn record(
        &mut self,
        request_id: &str,
        response: JsonObject,
        stop_on_error: bool,
    ) -> Result<(), RuntimeError> {
        let performed = response
            .get("performed")
            .and_then(JsonValue::as_bool)
            .unwrap_or(true);
        if performed {
            self.request_count = self
                .request_count
                .saturating_add(response.get("page_count").and_then(json_u64).unwrap_or(1));
        }
        self.output_bytes = self.output_bytes.saturating_add(estimated_size(&response)?);
        if self.output_bytes > MAX_HTTP_OUTPUT_BYTES {
            return Err(invalid(format!(
                "HTTP batch output exceeded {MAX_HTTP_OUTPUT_BYTES} bytes"
            )));
        }
        let status = response
            .get("status")
            .and_then(json_u64)
            .unwrap_or_default();
        let ok = response
            .get("ok")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        self.stopped = status == 429 || (stop_on_error && !ok);
        self.prior.insert(request_id.to_owned(), response.clone());
        self.responses.push(JsonValue::Object(response));
        Ok(())
    }

    fn finish(self) -> JsonValue {
        let decision = if self.stopped { "stopped" } else { "completed" };
        JsonValue::Object(JsonObject::from([(
            "http_execution".to_owned(),
            JsonValue::Object(JsonObject::from([
                (
                    "schema".to_owned(),
                    JsonValue::String("runx.http.execution.v1".to_owned()),
                ),
                (
                    "decision".to_owned(),
                    JsonValue::String(decision.to_owned()),
                ),
                ("responses".to_owned(), JsonValue::Array(self.responses)),
                (
                    "request_count".to_owned(),
                    JsonValue::Number(JsonNumber::U64(self.request_count)),
                ),
                ("stopped".to_owned(), JsonValue::Bool(self.stopped)),
            ])),
        )]))
    }
}

pub(super) fn execute_batch(
    invocation: &NativeInvocation<'_, HttpBatchInput>,
    mode: BatchMode,
) -> Result<JsonValue, RuntimeError> {
    let auth = request_auth(invocation.inputs.auth.as_ref())?;
    let allowed_hosts = admitted_hosts(invocation, &auth)?;
    let requests = admit_requests(&invocation.inputs.requests, mode)?;
    let stop_on_error = invocation.inputs.stop_on_error;
    let transport = NativeHttpTransport::new(
        invocation.harness_http_responses(),
        invocation.harness_http_exchanges(),
    )
    .map_err(|error| invalid(format!("native HTTP transport unavailable: {error}")))?;
    let mut batch = BatchAccumulator::new();

    for (index, raw_request) in requests.iter().enumerate() {
        if batch.stopped {
            break;
        }
        let request = raw_request
            .as_object()
            .ok_or_else(|| invalid(format!("requests[{index}] must be an object")))?;
        let request_id = required_string(request, "id")?;
        batch.admit_id(request_id)?;
        let response = match unmet_dependency(request, &batch.prior)? {
            Some(dependency) => skipped_response(request_id, &dependency),
            None => execute_one(
                &transport,
                RequestExecution {
                    request,
                    request_id,
                    allowed_hosts: &allowed_hosts,
                    auth: &auth,
                    invocation,
                    prior: &batch.prior,
                    retry_as_idempotent: mode.retries_as_idempotent(),
                },
            )?,
        };
        batch.record(request_id, response, stop_on_error)?;
    }
    Ok(batch.finish())
}

fn admitted_hosts(
    invocation: &NativeInvocation<'_, HttpBatchInput>,
    auth: &RequestAuth,
) -> Result<BTreeSet<String>, RuntimeError> {
    let requested = allowed_hosts(&invocation.inputs.allowed_hosts)?;
    if !auth.uses_credential() {
        return Ok(requested);
    }
    let bound = invocation.credential_delivery.destination_hosts();
    if bound.is_empty() {
        return Err(invalid(
            "authenticated HTTP requires a resolved credential audience binding",
        ));
    }
    if let Some(host) = requested.iter().find(|host| !bound.contains(*host)) {
        return Err(invalid(format!(
            "authenticated HTTP host {host:?} is outside the resolved credential audience"
        )));
    }
    Ok(requested)
}

fn admit_requests(requests: &[JsonValue], mode: BatchMode) -> Result<&[JsonValue], RuntimeError> {
    if requests.len() > MAX_REQUESTS {
        return Err(invalid(format!(
            "requests must contain no more than {MAX_REQUESTS} records"
        )));
    }
    for (index, request) in requests.iter().enumerate() {
        let request = request
            .as_object()
            .ok_or_else(|| invalid(format!("requests[{index}] must be an object")))?;
        let request_method = method(request.get("method").and_then(JsonValue::as_str))?;
        if !mode.admits(request_method) {
            return Err(invalid(format!(
                "requests[{index}] method {} is not admitted by {}",
                request_method.as_str(),
                mode.label()
            )));
        }
    }
    Ok(requests)
}

fn unmet_dependency(
    request: &JsonObject,
    prior: &BTreeMap<String, JsonObject>,
) -> Result<Option<String>, RuntimeError> {
    let Some(value) = request.get("requires_success_of") else {
        return Ok(None);
    };
    let dependencies = value
        .as_array()
        .ok_or_else(|| invalid("requires_success_of must be an array"))?;
    for dependency in dependencies {
        let dependency = dependency
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("requires_success_of entries must be non-empty strings"))?;
        let succeeded = prior
            .get(dependency)
            .and_then(|response| response.get("ok"))
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        if !succeeded {
            return Ok(Some(dependency.to_owned()));
        }
    }
    Ok(None)
}

fn skipped_response(request_id: &str, dependency: &str) -> JsonObject {
    JsonObject::from([
        ("id".to_owned(), JsonValue::String(request_id.to_owned())),
        ("performed".to_owned(), JsonValue::Bool(false)),
        ("status".to_owned(), JsonValue::Number(JsonNumber::U64(0))),
        ("ok".to_owned(), JsonValue::Bool(false)),
        ("json".to_owned(), JsonValue::Null),
        ("body".to_owned(), JsonValue::String(String::new())),
        ("body_digest".to_owned(), JsonValue::String(String::new())),
        (
            "body_bytes".to_owned(),
            JsonValue::Number(JsonNumber::U64(0)),
        ),
        ("truncated".to_owned(), JsonValue::Bool(false)),
        ("headers".to_owned(), JsonValue::Object(JsonObject::new())),
        (
            "skip_reason".to_owned(),
            JsonValue::String(format!("dependency {dependency:?} did not succeed")),
        ),
    ])
}

#[cfg(test)]
mod tests;
