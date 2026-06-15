use super::*;

use runx_runtime::registry::{HttpResponse, RuntimeHttpError};
use std::cell::RefCell;

#[derive(Default)]
struct StubTransport {
    requests: RefCell<Vec<HttpRequest>>,
    response: RefCell<Option<HttpResponse>>,
}

impl Transport for StubTransport {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, RuntimeHttpError> {
        self.requests.borrow_mut().push(request);
        Ok(self.response.borrow_mut().take().unwrap_or(HttpResponse {
            status: 201,
            body: serde_json::json!({
                "status": "notarized",
                "digest": "sha256:abc",
                "public_hash": "abc",
                "mode": "full",
                "published": true,
                "public_url": "https://runx.test/r/abc",
                "verdict": {"valid": true}
            })
            .to_string(),
        }))
    }
}

#[test]
fn parses_publish_plan() -> Result<(), String> {
    let args = vec![
        OsString::from("publish"),
        OsString::from("receipt.json"),
        OsString::from("--api-base-url"),
        OsString::from("https://runx.test/"),
        OsString::from("--token"),
        OsString::from("rxk_test"),
        OsString::from("--json"),
    ];
    let plan = parse_publish_plan(&args)?;
    assert_eq!(
        plan,
        PublishPlan {
            receipt_path: PathBuf::from("receipt.json"),
            api_base_url: Some("https://runx.test/".to_owned()),
            token: Some("rxk_test".to_owned()),
            allow_local_api: false,
            json: true,
        }
    );
    Ok(())
}

#[test]
// rust-style-allow: long-function - this regression asserts endpoint and token
// precedence in one table-shaped flow so the cases stay visually adjacent.
fn resolves_publish_endpoint_and_token_precedence() {
    let mut env = BTreeMap::new();
    env.insert(
        "RUNX_PUBLIC_API_BASE_URL".to_owned(),
        "https://env.runx.test/".to_owned(),
    );
    env.insert(
        "RUNX_CONNECT_ACCESS_TOKEN".to_owned(),
        "connect-token".to_owned(),
    );
    env.insert(
        "RUNX_PUBLIC_API_TOKEN".to_owned(),
        "public-token".to_owned(),
    );
    let plan = PublishPlan {
        receipt_path: PathBuf::from("receipt.json"),
        api_base_url: Some("https://plan.runx.test/".to_owned()),
        token: Some("plan-token".to_owned()),
        allow_local_api: false,
        json: false,
    };

    assert_eq!(
        resolve_public_api_base_url(&plan, &env),
        "https://plan.runx.test"
    );
    assert_eq!(
        resolve_publish_token(&plan, &env).as_deref(),
        Some("plan-token")
    );

    let env_plan = PublishPlan {
        token: None,
        api_base_url: None,
        ..plan
    };
    assert_eq!(
        resolve_public_api_base_url(&env_plan, &env),
        "https://env.runx.test"
    );
    assert_eq!(
        resolve_publish_token(&env_plan, &env).as_deref(),
        Some("public-token")
    );

    let empty_token_plan = PublishPlan {
        receipt_path: PathBuf::from("receipt.json"),
        token: Some("   ".to_owned()),
        api_base_url: None,
        allow_local_api: false,
        json: false,
    };
    assert_eq!(
        resolve_publish_token(&empty_token_plan, &env).as_deref(),
        Some("public-token")
    );

    let empty_url_plan = PublishPlan {
        receipt_path: PathBuf::from("receipt.json"),
        api_base_url: Some("  /  ".to_owned()),
        token: None,
        allow_local_api: false,
        json: false,
    };
    assert_eq!(
        resolve_public_api_base_url(&empty_url_plan, &BTreeMap::new()),
        "https://runx.ai"
    );
}

#[test]
fn parses_and_resolves_local_api_override() -> Result<(), String> {
    let args = vec![
        OsString::from("publish"),
        OsString::from("receipt.json"),
        OsString::from("--allow-local-api"),
    ];
    let plan = parse_publish_plan(&args)?;
    assert!(plan.allow_local_api);
    assert!(allow_local_api(&plan, &BTreeMap::new()));

    let plan = PublishPlan {
        receipt_path: PathBuf::from("receipt.json"),
        api_base_url: None,
        token: None,
        allow_local_api: false,
        json: false,
    };
    let mut env = BTreeMap::new();
    env.insert("RUNX_PUBLISH_ALLOW_LOCAL_API".to_owned(), "true".to_owned());
    assert!(allow_local_api(&plan, &env));
    Ok(())
}

#[test]
fn posts_full_receipt_publish_request() -> Result<(), String> {
    let transport = StubTransport::default();
    let receipt: JsonValue =
        serde_json::from_value(serde_json::json!({"id": "receipt_1"})).map_err(stringify)?;
    let response = publish_receipt(
        &transport,
        &PublishOptions {
            base_url: "https://runx.test/",
            token: "rxk_test",
            receipt: &receipt,
        },
    )
    .map_err(|error| error.to_string())?;

    assert_eq!(
        response.public_url.as_deref(),
        Some("https://runx.test/r/abc")
    );
    let requests = transport.requests.borrow();
    assert_eq!(requests[0].url, "https://runx.test/v1/receipts/notarize");
    assert_eq!(requests[0].method, HttpMethod::Post);
    assert!(
        requests[0]
            .headers
            .iter()
            .any(|header| header.name == "authorization" && header.value == "Bearer rxk_test")
    );
    assert_eq!(
        request_json_body(&requests[0])?,
        serde_json::from_value::<JsonValue>(
            serde_json::json!({"publish": true, "receipt": {"id": "receipt_1"}})
        )
        .map_err(stringify)?
    );
    Ok(())
}

#[test]
fn human_output_reflects_notary_status() -> Result<(), PublishCliError> {
    let output = render_publish_result(
        false,
        &ReceiptPublishResponse {
            status: "notarized".to_owned(),
            replay_status: Some("fresh".to_owned()),
            digest: "sha256:abc".to_owned(),
            public_hash: "abc".to_owned(),
            mode: "full".to_owned(),
            published: false,
            public_url: None,
            receipt_id: Some("receipt_1".to_owned()),
            verdict: Some(
                serde_json::from_value(serde_json::json!({"valid": true}))
                    .map_err(|error| PublishCliError::Serialize(error.to_string()))?,
            ),
        },
    )?;

    assert!(output.contains("notarized receipt sha256:abc (full)"));
    assert!(output.contains("status:      notarized"));
    assert!(output.contains("published:   false"));
    assert!(output.contains("receipt id:  receipt_1"));
    assert!(output.contains("replay:      fresh"));
    assert!(output.contains(r#"verdict:     {"valid":true}"#));
    Ok(())
}

fn request_json_body(request: &HttpRequest) -> Result<JsonValue, String> {
    let body = request
        .body
        .as_deref()
        .ok_or_else(|| "request should include a body".to_owned())?;
    serde_json::from_str(body).map_err(stringify)
}

fn stringify(error: impl std::fmt::Display) -> String {
    error.to_string()
}
