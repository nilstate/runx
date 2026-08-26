// Module rationale: paid registry skills keep the ordinary `runx skill`
// command while the hosted HTTP boundary owns x402 wire semantics. The CLI
// validates and renders the challenge; payment remains an ordinary payment
// skill and never enters this router.
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use runx_contracts::{JsonObject, JsonValue, X402_PAYMENT_REQUIRED_HEADER, X402PaymentRequired};
use runx_runtime::{HttpMethod, ReqwestHttpTransport, RuntimeHttpRequest, RuntimeHttpTransport};
use url::Url;

use super::resolver::ResolvedSkillRef;

const MAX_CHALLENGE_BYTES: usize = 256 * 1024;

pub(super) fn discover_paid_skill(
    resolved: &ResolvedSkillRef,
    requested_runner: Option<&str>,
    inputs: &JsonObject,
) -> Result<JsonValue, String> {
    let transport = ReqwestHttpTransport::new()
        .map_err(|error| format!("failed to initialize marketplace HTTP: {error}"))?;
    discover_paid_skill_with_transport(resolved, requested_runner, inputs, &transport)
}

fn discover_paid_skill_with_transport<T: RuntimeHttpTransport>(
    resolved: &ResolvedSkillRef,
    requested_runner: Option<&str>,
    inputs: &JsonObject,
    transport: &T,
) -> Result<JsonValue, String> {
    let listing = resolved
        .paid_listing
        .as_ref()
        .ok_or_else(|| "paid registry listing is unavailable".to_owned())?;
    let runner = selected_runner(listing, requested_runner)?;
    let base_url = resolved
        .hosted_registry_url
        .as_deref()
        .ok_or_else(|| "paid registry skill has no hosted execution surface".to_owned())?;
    let resource_url = paid_skill_resource_url(base_url, listing.skill_id.as_str())?;
    let response = transport
        .send_limited(
            RuntimeHttpRequest {
                method: HttpMethod::Post,
                url: resource_url.clone(),
                headers: Vec::new(),
                body: None,
            },
            MAX_CHALLENGE_BYTES,
        )
        .map_err(|error| format!("marketplace discovery failed: {error}"))?;
    if response.status != 402 {
        return Err(format!(
            "marketplace discovery returned HTTP {}; expected 402",
            response.status
        ));
    }
    let body: X402PaymentRequired = serde_json::from_str(&response.body)
        .map_err(|error| format!("marketplace returned an invalid x402 challenge body: {error}"))?;
    let encoded = response
        .headers
        .iter()
        .find(|header| {
            header
                .name
                .eq_ignore_ascii_case(X402_PAYMENT_REQUIRED_HEADER)
        })
        .map(|header| header.value.as_str())
        .ok_or_else(|| "marketplace 402 omitted PAYMENT-REQUIRED".to_owned())?;
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|error| format!("marketplace PAYMENT-REQUIRED is not valid base64: {error}"))?;
    let header: X402PaymentRequired = serde_json::from_slice(&decoded)
        .map_err(|error| format!("marketplace PAYMENT-REQUIRED is invalid: {error}"))?;
    if header != body {
        return Err("marketplace x402 header and body challenges differ".to_owned());
    }

    serde_json::from_value(serde_json::json!({
        "status": "payment_required",
        "skill_name": listing.skill_id,
        "runner": runner,
        "result": {
            "payment_required": body,
            "resource": {
                "url": resource_url,
                "method": "POST",
                "body": {
                    "runner": runner,
                    "inputs": inputs,
                },
                "requires_idempotency_key": true,
            },
            "summary": "Hosted marketplace settlement is required before this skill can run."
        }
    }))
    .map_err(|error| format!("failed to render marketplace challenge: {error}"))
}

fn selected_runner(
    listing: &runx_contracts::PaidSkillListing,
    requested: Option<&str>,
) -> Result<String, String> {
    if let Some(runner) = requested {
        return listing
            .offers
            .as_map()
            .contains_key(runner)
            .then(|| runner.to_owned())
            .ok_or_else(|| format!("paid listing has no offer for runner '{runner}'"));
    }
    if listing.offers.as_map().len() == 1 {
        return listing
            .offers
            .as_map()
            .keys()
            .next()
            .cloned()
            .ok_or_else(|| "paid listing has no runnable offers".to_owned());
    }
    Err("paid listing has multiple offers; select a runner explicitly".to_owned())
}

fn paid_skill_resource_url(base_url: &str, skill_id: &str) -> Result<String, String> {
    let (owner, name) =
        runx_runtime::registry::split_skill_id(skill_id).map_err(|error| error.to_string())?;
    let mut url =
        Url::parse(base_url).map_err(|error| format!("hosted registry URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.cannot_be_a_base() {
        return Err("hosted registry URL must be HTTP(S)".to_owned());
    }
    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .map_err(|_| "hosted registry URL cannot carry skill routes".to_owned())?
        .pop_if_empty()
        .extend(["v1", "skills", owner, name, "run"]);
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use runx_contracts::PaidSkillListing;
    use runx_runtime::{RuntimeHttpHeader, RuntimeHttpResponse};

    use super::*;
    use crate::skill::resolver::{RegistryTrustState, SkillRefKind};

    struct FakeTransport {
        response: RuntimeHttpResponse,
        requests: RefCell<Vec<RuntimeHttpRequest>>,
    }

    impl RuntimeHttpTransport for FakeTransport {
        fn send(
            &self,
            request: RuntimeHttpRequest,
        ) -> Result<RuntimeHttpResponse, runx_runtime::RuntimeHttpError> {
            self.requests.borrow_mut().push(request);
            Ok(self.response.clone())
        }
    }

    #[test]
    fn paid_registry_skill_renders_the_exact_hosted_x402_challenge() {
        let body = serde_json::json!({
            "x402Version": 2,
            "resource": {
                "url": "https://api.runx.test/v1/skills/ausca/document-ocr/run",
                "description": "OCR",
                "mimeType": "application/json"
            },
            "accepts": [{
                "scheme": "exact",
                "network": "eip155:8453",
                "amount": "300000",
                "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                "payTo": "0x26572ff23c6c52bfb1a69cb0c9114a8be443b422",
                "maxTimeoutSeconds": 300
            }]
        });
        let encoded = STANDARD.encode(serde_json::to_vec(&body).expect("challenge JSON"));
        let mut response = RuntimeHttpResponse::new(402, body.to_string());
        response.headers = vec![RuntimeHttpHeader::new(
            X402_PAYMENT_REQUIRED_HEADER,
            encoded,
        )];
        let transport = FakeTransport {
            response,
            requests: RefCell::new(Vec::new()),
        };
        let resolved = resolved_paid_listing();
        let output = discover_paid_skill_with_transport(
            &resolved,
            None,
            &JsonObject::from([("document".to_owned(), JsonValue::String("ref".to_owned()))]),
            &transport,
        )
        .expect("paid discovery");

        let output: serde_json::Value =
            serde_json::to_value(output).expect("serializable challenge output");
        assert_eq!(output["status"], "payment_required");
        assert_eq!(output["runner"], "invoke");
        assert_eq!(output["result"]["payment_required"], body);
        assert_eq!(transport.requests.borrow()[0].method, HttpMethod::Post);
        assert_eq!(
            transport.requests.borrow()[0].url,
            "https://api.runx.test/v1/skills/ausca/document-ocr/run"
        );
        assert!(transport.requests.borrow()[0].body.is_none());
    }

    fn resolved_paid_listing() -> ResolvedSkillRef {
        ResolvedSkillRef {
            kind: SkillRefKind::Registry,
            skill_id: Some("ausca/document-ocr".to_owned()),
            version: Some("0.1.0".to_owned()),
            digest: Some(format!("sha256:{}", "a".repeat(64))),
            profile_digest: Some(format!("sha256:{}", "b".repeat(64))),
            package_digest: None,
            registry_source: Some("remote https://api.runx.test".to_owned()),
            registry_source_fingerprint: Some("remote:https://api.runx.test".to_owned()),
            trust_state: Some(RegistryTrustState::Trusted),
            trust_tier: Some("community".to_owned()),
            registry_key_id: Some("test".to_owned()),
            paid_listing: Some(listing()),
            hosted_registry_url: Some("https://api.runx.test".to_owned()),
            runnable_path: "unused".into(),
        }
    }

    fn listing() -> PaidSkillListing {
        serde_json::from_value(serde_json::json!({
            "skill_id": "ausca/document-ocr",
            "version": "0.1.0",
            "skill_digest": format!("sha256:{}", "a".repeat(64)),
            "profile_digest": format!("sha256:{}", "b".repeat(64)),
            "package_digest": format!("sha256:{}", "c".repeat(64)),
            "vendor_ref": { "type": "principal", "uri": "runx:principal:ausca" },
            "offers": {
                "invoke": {
                    "amount_minor": 30,
                    "currency": "USD",
                    "accepted_settlement_families": ["x402"],
                    "offer_revision": {
                        "offer_id": "ausca/document-ocr#invoke",
                        "revision": "0.1.0",
                        "revision_digest": format!("sha256:{}", "d".repeat(64)),
                        "input_schema_digest": format!("sha256:{}", "e".repeat(64)),
                        "output_schema_digest": format!("sha256:{}", "f".repeat(64))
                    }
                }
            }
        }))
        .expect("paid listing")
    }
}
