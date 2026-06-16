use super::*;

use runx_runtime::registry::{HttpResponse, RuntimeHttpError};
use std::cell::RefCell;
use std::fs;

#[derive(Default)]
struct StubTransport {
    requests: RefCell<Vec<HttpRequest>>,
    responses: RefCell<Vec<HttpResponse>>,
}

impl StubTransport {
    fn with_responses(responses: Vec<HttpResponse>) -> Self {
        Self {
            requests: RefCell::new(Vec::new()),
            responses: RefCell::new(responses.into_iter().rev().collect()),
        }
    }
}

impl Transport for StubTransport {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, RuntimeHttpError> {
        self.requests.borrow_mut().push(request);
        Ok(self.responses.borrow_mut().pop().unwrap_or(HttpResponse {
            status: 500,
            body: "missing stub response".to_owned(),
        }))
    }
}

#[test]
fn parses_login_plan() -> Result<(), String> {
    let args = vec![
        OsString::from("login"),
        OsString::from("--api-base-url"),
        OsString::from("https://runx.test/"),
        OsString::from("--provider"),
        OsString::from("github"),
        OsString::from("--allow-local-api"),
        OsString::from("--json"),
    ];
    assert_eq!(
        parse_login_plan(&args)?,
        LoginPlan {
            api_base_url: Some("https://runx.test/".to_owned()),
            provider: Some("github".to_owned()),
            allow_local_api: true,
            json: true,
        }
    );
    Ok(())
}

#[test]
fn login_exchange_stores_encrypted_public_api_token() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile_dir()?;
    let env = BTreeMap::from([("RUNX_HOME".to_owned(), temp.to_string_lossy().to_string())]);
    let transport = StubTransport::with_responses(vec![
        HttpResponse {
            status: 201,
            body: serde_json::json!({
                "status": "pending",
                "session_id": "login_1",
                "login_token": "ticket_1",
                "authorization_url": "https://runx.test/connect/login_1",
                "poll_after_ms": 0
            })
            .to_string(),
        },
        HttpResponse {
            status: 202,
            body: serde_json::json!({
                "status": "pending",
                "session_id": "login_1",
                "poll_after_ms": 0
            })
            .to_string(),
        },
        HttpResponse {
            status: 200,
            body: serde_json::json!({
                "status": "success",
                "session_id": "login_1",
                "principal_id": "user_1",
                "credential_id": "cred_1",
                "token": "rxk_secret"
            })
            .to_string(),
        },
    ]);
    let output = run_login_command_with_transport(
        &LoginPlan {
            api_base_url: Some("https://runx.test/".to_owned()),
            provider: Some("github".to_owned()),
            allow_local_api: false,
            json: true,
        },
        &env,
        &temp,
        &transport,
        |_| {},
    )?;

    assert!(output.contains("\"status\": \"success\""));
    let config = fs::read_to_string(temp.join("config.json"))?;
    assert!(config.contains("api_token_ref"));
    assert!(!config.contains("rxk_secret"));

    let requests = transport.requests.borrow();
    assert_eq!(requests[0].url, "https://runx.test/v1/login/sessions");
    assert_eq!(requests[0].method, HttpMethod::Post);
    assert_eq!(
        request_json_body(&requests[0])?,
        serde_json::json!({"provider":"github"})
    );
    assert_eq!(
        requests[1].url,
        "https://runx.test/v1/login/sessions/login_1/complete"
    );
    assert_eq!(
        request_json_body(&requests[1])?,
        serde_json::json!({"login_token":"ticket_1"})
    );
    assert_eq!(
        requests[2].url,
        "https://runx.test/v1/login/sessions/login_1/complete"
    );
    Ok(())
}

#[test]
fn login_surfaces_api_error() {
    let transport = StubTransport::with_responses(vec![HttpResponse {
        status: 400,
        body: serde_json::json!({
            "status": "error",
            "error": {"code": "login_request_invalid", "detail": "provider must be github"}
        })
        .to_string(),
    }]);
    let error = run_login_command_with_transport(
        &LoginPlan {
            api_base_url: Some("https://runx.test/".to_owned()),
            provider: Some("bad".to_owned()),
            allow_local_api: false,
            json: false,
        },
        &BTreeMap::new(),
        &std::env::temp_dir(),
        &transport,
        |_| {},
    )
    .expect_err("login should fail");
    assert!(error.to_string().contains("[login_request_invalid]"));
}

fn request_json_body(request: &HttpRequest) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::from_str(request.body.as_deref().unwrap_or_default())
}

fn tempfile_dir() -> Result<std::path::PathBuf, std::io::Error> {
    let path = std::env::temp_dir().join(format!(
        "runx-cli-login-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(&path)?;
    Ok(path)
}
