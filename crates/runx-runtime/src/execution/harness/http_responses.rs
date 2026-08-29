use std::collections::BTreeMap;

use runx_parser::{
    HarnessHttpExchangeFixture, HarnessHttpRequestBodyFixture, HarnessHttpResponseFixture,
};

use crate::effects::RuntimeEffectRegistry;
use crate::http::{
    HttpMethod, RuntimeHarnessHttpExchange, RuntimeHarnessHttpRequestBody, RuntimeHttpHeader,
    RuntimeHttpResponse,
};

/// Attach exact fixture bytes to a cloned execution registry. No public
/// runtime input, environment variable, or provider configuration can create
/// this state; only the harness front calls this function.
pub(crate) fn effects_with_harness_http(
    effects: &RuntimeEffectRegistry,
    fixtures: &BTreeMap<String, HarnessHttpResponseFixture>,
    exchanges: &[HarnessHttpExchangeFixture],
) -> RuntimeEffectRegistry {
    if fixtures.is_empty() && exchanges.is_empty() {
        return effects.clone();
    }
    let responses = fixtures
        .iter()
        .map(|(url, fixture)| (url.clone(), runtime_response(fixture)))
        .collect();
    let exchanges = exchanges
        .iter()
        .map(|exchange| RuntimeHarnessHttpExchange {
            method: runtime_method(&exchange.request.method),
            url: exchange.request.url.clone(),
            body: match &exchange.request.body {
                HarnessHttpRequestBodyFixture::None(_) => RuntimeHarnessHttpRequestBody::None,
                HarnessHttpRequestBodyFixture::Json { json } => {
                    RuntimeHarnessHttpRequestBody::Json(json.clone())
                }
            },
            response: runtime_response(&exchange.response),
        })
        .collect();
    effects
        .clone()
        .with_harness_http_responses(responses)
        .with_harness_http_exchanges(exchanges)
}

fn runtime_response(fixture: &HarnessHttpResponseFixture) -> RuntimeHttpResponse {
    let mut response = RuntimeHttpResponse::new(fixture.status, fixture.body.clone());
    response.headers = fixture
        .headers
        .iter()
        .map(|(name, value)| RuntimeHttpHeader::new(name, value))
        .collect();
    response
}

fn runtime_method(method: &str) -> HttpMethod {
    match method {
        "GET" => HttpMethod::Get,
        "POST" => HttpMethod::Post,
        "PUT" => HttpMethod::Put,
        "PATCH" => HttpMethod::Patch,
        "DELETE" => HttpMethod::Delete,
        _ => unreachable!("harness HTTP method was validated by runx-parser"),
    }
}
