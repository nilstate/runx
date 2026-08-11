use runx_contracts::{JsonObject, JsonValue};
use runx_parser::{HarnessProviderAccess, HarnessProviderResponsesFixture};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use crate::effects::{ProviderPermissionEffect, RuntimeEffectRegistry};
use crate::http::{
    HttpMethod, RuntimeHttpError, RuntimeHttpRequest, RuntimeHttpResponse, RuntimeHttpTransport,
};

pub(crate) const HARNESS_PROVIDER_BASE_URL: &str = "https://provider-fixture.runx.invalid";
pub(crate) const HARNESS_PROVIDER_TOKEN: &str = "runx-harness-provider-token";

/// Wire an exact provider fixture beneath the production provider effect. No
/// public runner input or environment variable can construct this transport;
/// only the isolated harness front can attach it.
pub(crate) fn effects_with_harness_provider_responses(
    effects: &RuntimeEffectRegistry,
    fixture: Option<&HarnessProviderResponsesFixture>,
) -> Result<RuntimeEffectRegistry, crate::RuntimeEffectError> {
    let Some(fixture) = fixture else {
        return Ok(effects.clone());
    };
    let mut effects = effects.clone();
    effects.replace_effect(ProviderPermissionEffect::with_http_transport(
        HarnessProviderTransport {
            fixture: fixture.clone(),
            mutation_keys: Arc::new(Mutex::new(BTreeMap::new())),
        },
    ))?;
    Ok(effects)
}

#[derive(Clone, Debug)]
struct HarnessProviderTransport {
    fixture: HarnessProviderResponsesFixture,
    mutation_keys: Arc<Mutex<BTreeMap<(String, String), String>>>,
}

impl RuntimeHttpTransport for HarnessProviderTransport {
    fn send(&self, request: RuntimeHttpRequest) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        self.validate_authorization(&request)?;
        match (request.method, request.url.as_str()) {
            (HttpMethod::Get, url) if url == format!("{HARNESS_PROVIDER_BASE_URL}/v1/me") => {
                json_response(JsonValue::Object(JsonObject::from([
                    ("status".to_owned(), JsonValue::String("success".to_owned())),
                    (
                        "principal".to_owned(),
                        JsonValue::Object(JsonObject::from([(
                            "principal_id".to_owned(),
                            JsonValue::String(self.fixture.principal_id.clone()),
                        )])),
                    ),
                ])))
            }
            (HttpMethod::Get, url) if url == format!("{HARNESS_PROVIDER_BASE_URL}/v1/grants") => {
                let grants = self
                    .fixture
                    .grants
                    .iter()
                    .map(|grant| {
                        JsonValue::Object(JsonObject::from([
                            (
                                "grant_id".to_owned(),
                                JsonValue::String(grant.grant_id.clone()),
                            ),
                            (
                                "provider".to_owned(),
                                JsonValue::String(grant.provider.clone()),
                            ),
                            (
                                "scopes".to_owned(),
                                JsonValue::Array(
                                    grant
                                        .scopes
                                        .iter()
                                        .cloned()
                                        .map(JsonValue::String)
                                        .collect(),
                                ),
                            ),
                            ("status".to_owned(), JsonValue::String("active".to_owned())),
                        ]))
                    })
                    .collect();
                json_response(JsonValue::Object(JsonObject::from([
                    ("status".to_owned(), JsonValue::String("success".to_owned())),
                    ("grants".to_owned(), JsonValue::Array(grants)),
                ])))
            }
            (HttpMethod::Post, url)
                if url == format!("{HARNESS_PROVIDER_BASE_URL}/v1/provider-operations") =>
            {
                self.provider_operation(request.body.as_deref())
            }
            _ => Err(transport_error(format!(
                "the harness provider fixture has no response for {} {}",
                request.method.as_str(),
                request.url
            ))),
        }
    }
}

impl HarnessProviderTransport {
    fn validate_authorization(&self, request: &RuntimeHttpRequest) -> Result<(), RuntimeHttpError> {
        let expected = format!("Bearer {HARNESS_PROVIDER_TOKEN}");
        if request.headers.iter().any(|header| {
            header.name.eq_ignore_ascii_case("authorization") && header.value == expected
        }) {
            return Ok(());
        }
        Err(transport_error(
            "the harness provider request omitted its isolated bearer binding".to_owned(),
        ))
    }

    fn provider_operation(
        &self,
        body: Option<&str>,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        let request = serde_json::from_str::<JsonObject>(
            body.ok_or_else(|| transport_error("provider operation body is missing".to_owned()))?,
        )
        .map_err(|error| transport_error(format!("provider operation body is invalid: {error}")))?;
        let grant_id = required_string(&request, "grant_id")?;
        let operation = required_string(&request, "operation")?;
        let target = required_string(&request, "target")?;
        let access = required_string(&request, "access")?;
        let access = match access {
            "read" => HarnessProviderAccess::Read,
            "mutate" => HarnessProviderAccess::Mutate,
            value => {
                return Err(transport_error(format!(
                    "unsupported provider access {value:?}"
                )));
            }
        };
        let fixture = self
            .fixture
            .operations
            .iter()
            .find(|fixture| {
                fixture.grant_id == grant_id
                    && fixture.operation == operation
                    && fixture.target == target
                    && fixture.access == access
            })
            .ok_or_else(|| {
                transport_error(format!(
                    "the harness provider fixture has no exact {access:?} operation {operation:?} for target {target:?} and grant {grant_id:?}"
                ))
            })?;
        let provider = self
            .fixture
            .grants
            .iter()
            .find(|grant| grant.grant_id == grant_id)
            .map(|grant| grant.provider.clone())
            .ok_or_else(|| transport_error(format!("unknown harness grant {grant_id:?}")))?;
        let identity = runx_contracts::sha256_prefixed(
            format!("{grant_id}\0{operation}\0{target}").as_bytes(),
        );
        let idempotency_key = if access == HarnessProviderAccess::Mutate {
            let input = request
                .get("input")
                .and_then(JsonValue::as_object)
                .ok_or_else(|| transport_error("provider mutation input is missing".to_owned()))?;
            Some(required_string(input, "idempotency_key")?.to_owned())
        } else {
            None
        };
        let mut result = fixture.result.clone();
        if let (Some(idempotency_key), JsonValue::Object(result)) =
            (idempotency_key.as_deref(), &mut result)
            && result.get("idempotency_key").and_then(JsonValue::as_str)
                == Some("$request.idempotency_key")
        {
            result.insert(
                "idempotency_key".to_owned(),
                JsonValue::String(idempotency_key.to_owned()),
            );
        }
        if let JsonValue::Object(result) = &mut result
            && result.get("idempotency_key").and_then(JsonValue::as_str)
                == Some("$previous.idempotency_key")
        {
            let previous = self
                .mutation_keys
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&(grant_id.to_owned(), target.to_owned()))
                .cloned()
                .ok_or_else(|| {
                    transport_error(format!(
                        "the harness provider fixture has no prior mutation idempotency for grant {grant_id:?} and target {target:?}"
                    ))
                })?;
            result.insert("idempotency_key".to_owned(), JsonValue::String(previous));
        }
        let mut response = JsonObject::from([
            ("status".to_owned(), JsonValue::String("success".to_owned())),
            ("provider".to_owned(), JsonValue::String(provider)),
            (
                "operation".to_owned(),
                JsonValue::String(operation.to_owned()),
            ),
            ("target".to_owned(), JsonValue::String(target.to_owned())),
            (
                "access".to_owned(),
                JsonValue::String(access_name(access).to_owned()),
            ),
            ("result".to_owned(), result),
            (
                "readback_ref".to_owned(),
                JsonValue::String(format!("runx:harness:provider-readback:{identity}")),
            ),
        ]);
        if let Some(idempotency_key) = idempotency_key {
            self.mutation_keys
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(
                    (grant_id.to_owned(), target.to_owned()),
                    idempotency_key.clone(),
                );
            response.insert(
                "operation_id".to_owned(),
                JsonValue::String(format!("harness-{identity}")),
            );
            response.insert(
                "idempotency_key".to_owned(),
                JsonValue::String(idempotency_key),
            );
        }
        json_response(JsonValue::Object(response))
    }
}

fn access_name(access: HarnessProviderAccess) -> &'static str {
    match access {
        HarnessProviderAccess::Read => "read",
        HarnessProviderAccess::Mutate => "mutate",
    }
}

fn required_string<'a>(object: &'a JsonObject, field: &str) -> Result<&'a str, RuntimeHttpError> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| transport_error(format!("provider operation {field} is missing")))
}

fn json_response(value: JsonValue) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
    serde_json::to_string(&value)
        .map(|body| RuntimeHttpResponse::new(200, body))
        .map_err(|error| transport_error(format!("harness provider response failed: {error}")))
}

fn transport_error(message: String) -> RuntimeHttpError {
    RuntimeHttpError::Transport { message }
}
