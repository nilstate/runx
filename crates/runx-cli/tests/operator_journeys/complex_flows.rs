use super::*;
use std::io::Read;
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
struct ProviderRequestTrace {
    operation: String,
    access: String,
    provider_target: String,
    idempotency_key: Option<String>,
}

type ProviderServer = thread::JoinHandle<Result<Vec<ProviderRequestTrace>, String>>;
type ProviderFixture = (String, ProviderServer);

fn spawn_send_provider() -> TestResult<ProviderFixture> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr()?;
    let server = thread::spawn(move || -> Result<Vec<ProviderRequestTrace>, String> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut operations = Vec::new();
        let mut mutation_key = None;
        while operations.len() < 2 {
            if Instant::now() >= deadline {
                return Err(format!(
                    "provider fixture timed out after {} operations",
                    operations.len()
                ));
            }
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => return Err(error.to_string()),
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .map_err(|error| error.to_string())?;
            let request = read_http_request(&mut stream)?;
            let request_line = request.lines().next().unwrap_or_default();
            if request_line.starts_with("GET /v1/me HTTP/1.1") {
                write_http_json(
                    &mut stream,
                    &serde_json::json!({
                        "status": "success",
                        "principal": {"principal_id": "operator:test", "role": "user"}
                    }),
                )?;
                continue;
            }
            if !request_line.starts_with("POST /v1/provider-operations HTTP/1.1") {
                return Err(format!("unexpected provider request: {request_line}"));
            }
            let body = request
                .split_once("\r\n\r\n")
                .map(|(_, body)| body)
                .ok_or_else(|| "provider request omitted its body".to_owned())?;
            let value: Value = serde_json::from_str(body)
                .map_err(|error| format!("invalid provider request JSON: {error}"))?;
            let operation = value["operation"]
                .as_str()
                .ok_or_else(|| "provider request omitted operation".to_owned())?
                .to_owned();
            let access = value["access"]
                .as_str()
                .ok_or_else(|| "provider request omitted access".to_owned())?
                .to_owned();
            let target = value["target"]
                .as_str()
                .ok_or_else(|| "provider request omitted target".to_owned())?
                .to_owned();
            let key = value["input"]["idempotency_key"]
                .as_str()
                .map(str::to_owned);
            if operation == "message.send" {
                mutation_key = key.clone();
            }
            let key = key.or_else(|| mutation_key.clone());
            operations.push(ProviderRequestTrace {
                operation: operation.clone(),
                access: access.clone(),
                provider_target: target.clone(),
                idempotency_key: key.clone(),
            });
            let mut response = serde_json::json!({
                "status": "success",
                "provider": "provider-send-demo",
                "operation": operation,
                "target": target,
                "access": access,
                "readback_ref": format!("runx:provider_readback:message-001:{}", operations.len()),
                "result": {
                    "message_id": "message-001",
                    "principal_ref": "account:release-bot",
                    "audience_ref": "release-subscribers",
                    "content_digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                    "status": "sent",
                    "sent_at": "2026-08-11T00:00:00Z",
                    "idempotency_key": key
                }
            });
            if response["access"] == "mutate" {
                response["operation_id"] = Value::String("provider-operation-message-001".into());
                response["idempotency_key"] = response["result"]["idempotency_key"].clone();
            } else {
                response["idempotency_key"] = response["result"]["idempotency_key"].clone();
            }
            write_http_json(&mut stream, &response)?;
        }
        Ok(operations)
    });
    Ok((format!("http://{address}"), server))
}

fn spawn_mutation_provider(
    provider: &'static str,
    return_readback: bool,
) -> TestResult<(
    String,
    thread::JoinHandle<Result<ProviderRequestTrace, String>>,
)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr()?;
    let server = thread::spawn(move || -> Result<ProviderRequestTrace, String> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() >= deadline {
                return Err("provider mutation fixture timed out".to_owned());
            }
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => return Err(error.to_string()),
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .map_err(|error| error.to_string())?;
            let request = read_http_request(&mut stream)?;
            let request_line = request.lines().next().unwrap_or_default();
            if request_line.starts_with("GET /v1/me HTTP/1.1") {
                write_http_json(
                    &mut stream,
                    &serde_json::json!({
                        "status": "success",
                        "principal": {"principal_id": "operator:test", "role": "user"}
                    }),
                )?;
                continue;
            }
            if !request_line.starts_with("POST /v1/provider-operations HTTP/1.1") {
                return Err(format!("unexpected provider request: {request_line}"));
            }
            let body = request
                .split_once("\r\n\r\n")
                .map(|(_, body)| body)
                .ok_or_else(|| "provider request omitted its body".to_owned())?;
            let value: Value = serde_json::from_str(body)
                .map_err(|error| format!("invalid provider request JSON: {error}"))?;
            let trace = ProviderRequestTrace {
                operation: value["operation"].as_str().unwrap_or_default().to_owned(),
                access: value["access"].as_str().unwrap_or_default().to_owned(),
                provider_target: value["target"].as_str().unwrap_or_default().to_owned(),
                idempotency_key: value["input"]["idempotency_key"]
                    .as_str()
                    .map(str::to_owned),
            };
            if !return_readback {
                // Closing after reading the mutation models acceptance followed
                // by an ambiguous transport failure.
                return Ok(trace);
            }
            let key = trace
                .idempotency_key
                .clone()
                .ok_or_else(|| "mutation omitted its idempotency key".to_owned())?;
            write_http_json(
                &mut stream,
                &serde_json::json!({
                    "status": "success",
                    "provider": provider,
                    "operation": trace.operation.clone(),
                    "target": trace.provider_target.clone(),
                    "access": trace.access.clone(),
                    "operation_id": "provider-operation-recovered-001",
                    "idempotency_key": key.clone(),
                    "readback_ref": "runx:provider_readback:recovered-001",
                    "result": {
                        "message_id": "message-recovered-001",
                        "principal_ref": "account:release-bot",
                        "audience_ref": "release-subscribers",
                        "content_digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                        "status": "sent",
                        "sent_at": "2026-08-11T00:00:00Z",
                        "idempotency_key": key
                    }
                }),
            )?;
            return Ok(trace);
        }
    });
    Ok((format!("http://{address}"), server))
}

fn read_http_request(stream: &mut std::net::TcpStream) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let mut expected = None;
    loop {
        let length = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if length == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..length]);
        if expected.is_none()
            && let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
        {
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            });
            expected = Some(header_end + 4 + content_length.unwrap_or(0));
        }
        if expected.is_some_and(|expected| bytes.len() >= expected) {
            break;
        }
    }
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

fn write_http_json(stream: &mut std::net::TcpStream, body: &Value) -> Result<(), String> {
    let body = body.to_string();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .map_err(|error| error.to_string())
}

fn provider_command(root: &Path, base_url: &str) -> Command {
    let mut command = command(root);
    command
        .env("RUNX_PROVIDER_PERMISSION_GRANT_ID", "grant-send-demo")
        .env(
            "RUNX_PROVIDER_PERMISSION_GRANTED_SCOPES",
            r#"["message.send","message.read"]"#,
        )
        .env(
            "RUNX_PROVIDER_PERMISSION_PRINCIPAL_REF",
            "runx:principal:operator:test",
        )
        .env(
            "RUNX_PROVIDER_PERMISSION_TRANSPORT",
            "hosted:grant-send-demo",
        )
        .env("RUNX_PUBLIC_API_BASE_URL", base_url)
        .env("RUNX_PUBLIC_API_TOKEN", "rxk_operator_journey")
        .env("RUNX_PUBLIC_API_ALLOW_PRIVATE_NETWORK", "1");
    command
}

#[test]
fn publishing_journey_plans_once_gates_once_and_closes_on_provider_readback() -> TestResult {
    let root = crate::support::temp_root("runx-publishing-provider-journey");
    let repo_root = crate::support::repo_root()?;
    let receipt_dir = root.join(".runx/receipts");
    fs::create_dir_all(&root)?;
    let (base_url, server) = spawn_send_provider()?;

    let pause = provider_command(&root, &base_url)
        .arg("skill")
        .arg(repo_root.join("skills/send-as"))
        .args([
            "--input",
            "objective=Send the digest-bound release notice.",
            "--input",
            "principal=account:release-bot",
            "--input",
            r#"provider_context={"provider":"provider-send-demo","account_ref":"acct_release","runtime_path":"provider.send","ready":true}"#,
            "--input",
            r#"audience={"type":"channel","ref":"release-subscribers"}"#,
            "--input",
            r#"content_ref={"draft_ref":"message:release-notice","digest":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","subject_or_title":"Release notice"}"#,
            "--input",
            "consent_basis=Subscribers opted in to release notices.",
            "--input",
            "operator_context=Require exact approval before live delivery.",
            "--input",
            r#"connector={"provider":"provider-send-demo","target":"account:acct_release/channel:release-subscribers"}"#,
        ])
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .args(["--json"])
        .output()?;
    let pause = assert_json(&pause, 2)?;
    assert_eq!(pause["status"], "needs_agent", "{pause}");
    let run_id = json_string(&pause, "run_id")?;
    let plan_request = pause["requests"]
        .as_array()
        .and_then(|requests| requests.first())
        .and_then(|request| request["id"].as_str())
        .ok_or("publishing pause omitted its planning request")?;
    let plan_answer = serde_json::json!({
        "answers": {
            (plan_request): {
                "send_plan": send_plan("provider-send-demo")
            }
        }
    })
    .to_string();
    let mut plan_resume = provider_command(&root, &base_url);
    plan_resume
        .arg("resume")
        .arg(run_id)
        .arg("-")
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json");
    let approval_pause = output_with_stdin(&mut plan_resume, &plan_answer)?;
    let approval_pause = assert_json(&approval_pause, 2)?;
    assert_eq!(
        approval_pause["status"], "needs_approval",
        "{approval_pause}"
    );
    assert_eq!(approval_pause["run_id"], run_id);
    let approval_id = approval_pause["requests"]
        .as_array()
        .and_then(|requests| requests.first())
        .and_then(|request| request["id"].as_str())
        .ok_or("publishing pause omitted its live-send approval")?;
    let approval = serde_json::json!({
        "approvals": {
            (approval_id): {
                "approved": true,
                "reason": "Publish this exact content digest to this exact audience."
            }
        }
    })
    .to_string();
    let mut send = provider_command(&root, &base_url);
    send.arg("resume")
        .arg(run_id)
        .arg("-")
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json");
    let sent = output_with_stdin(&mut send, &approval)?;
    let sent = assert_json(&sent, 0)?;
    let server = server
        .join()
        .map_err(|_| "provider fixture panicked")?
        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;

    assert_eq!(sent["status"], "sealed", "{sent}");
    assert_eq!(sent["outcome"], "completed");
    assert_eq!(sent["run_id"], run_id);
    let result = &sent["result"]["send_result"]["data"];
    assert_eq!(result["status"], "sent", "{result}");
    assert_eq!(result["outcome"], "completed");
    assert_eq!(result["provider"], "provider-send-demo");
    assert_eq!(
        result["content_digest"],
        send_plan("provider-send-demo")["content"]["digest"]
    );
    assert_eq!(server.len(), 2);
    assert_eq!(server[0].operation, "message.send");
    assert_eq!(server[0].access, "mutate");
    assert_eq!(server[1].operation, "message.read");
    assert_eq!(server[1].access, "read");
    assert_eq!(server[0].provider_target, server[1].provider_target);
    assert_eq!(server[0].idempotency_key, server[1].idempotency_key);
    assert!(
        server[0]
            .idempotency_key
            .as_deref()
            .is_some_and(|key| key.starts_with("runx:sha256:") && key.len() == 76)
    );
    assert!(sent.get("execution").is_none());
    assert!(
        sent.to_string().len() < 16_384,
        "default output is not compact"
    );
    let receipt_id = json_string(&sent, "receipt_id")?;
    assert_receipt_verifies(&root, &receipt_dir, receipt_id)?;
    let history = assert_history_contains_local_receipt(&root, &receipt_dir, receipt_id)?;
    assert!(
        history["pendingRuns"]
            .as_array()
            .is_some_and(|runs| runs.iter().all(|run| run["id"] != run_id))
    );
    Ok(())
}

#[test]
fn ambiguous_publish_recovers_same_provider_and_never_silently_fails_over() -> TestResult {
    let root = crate::support::temp_root("runx-provider-recovery-journey");
    let repo_root = crate::support::repo_root()?;
    let receipt_dir = root.join(".runx/receipts");
    fs::create_dir_all(&root)?;
    let provider_a = "provider-send-demo";
    let provider_b = "provider-send-backup";
    let provider_a_inputs = root.join("provider-a-send.json");
    let provider_b_inputs = root.join("provider-b-send.json");
    fs::write(
        &provider_a_inputs,
        send_apply_inputs(provider_a).to_string(),
    )?;
    fs::write(
        &provider_b_inputs,
        send_apply_inputs(provider_b).to_string(),
    )?;
    let (ambiguous_url, ambiguous_server) = spawn_mutation_provider(provider_a, false)?;

    let pause = provider_command(&root, &ambiguous_url)
        .arg("skill")
        .arg(repo_root.join("skills/send-as"))
        .arg("apply")
        .arg("--inputs")
        .arg("provider-a-send.json")
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json")
        .output()?;
    let pause = assert_json(&pause, 2)?;
    assert_eq!(pause["status"], "needs_approval", "{pause}");
    let run_id = json_string(&pause, "run_id")?;
    let approval_id = pause["requests"]
        .as_array()
        .and_then(|requests| requests.first())
        .and_then(|request| request["id"].as_str())
        .ok_or("provider recovery pause omitted approval")?;
    let approval = serde_json::json!({
        "approvals": {
            (approval_id): {
                "approved": true,
                "reason": "Attempt this exact provider mutation once."
            }
        }
    })
    .to_string();
    let mut attempt = provider_command(&root, &ambiguous_url);
    attempt
        .arg("resume")
        .arg(run_id)
        .arg("-")
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json");
    let ambiguous = output_with_stdin(&mut attempt, &approval)?;
    let ambiguous = assert_json(&ambiguous, 1)?;
    assert_eq!(ambiguous["status"], "failure", "{ambiguous}");
    assert!(
        ambiguous["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("outcome is unknown"))
    );
    let ambiguous_trace = ambiguous_server
        .join()
        .map_err(|_| "ambiguous provider fixture panicked")?
        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
    assert_eq!(ambiguous_trace.operation, "message.send");
    assert_eq!(ambiguous_trace.access, "mutate");

    // A different provider is a different consequential act. The runtime must
    // require a fresh exact approval instead of treating it as recovery.
    let failover = provider_command(&root, &ambiguous_url)
        .arg("skill")
        .arg(repo_root.join("skills/send-as"))
        .arg("apply")
        .arg("--inputs")
        .arg("provider-b-send.json")
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json")
        .output()?;
    let failover = assert_json(&failover, 2)?;
    assert_eq!(failover["status"], "needs_approval", "{failover}");
    assert_ne!(failover["run_id"], run_id);

    // Retrying the original act uses its recorded authority and exact key. It
    // does not make the operator approve the same mutation a second time.
    let (recovery_url, recovery_server) = spawn_mutation_provider(provider_a, true)?;
    let recovered = provider_command(&root, &recovery_url)
        .arg("skill")
        .arg(repo_root.join("skills/send-as"))
        .arg("apply")
        .arg("--inputs")
        .arg("provider-a-send.json")
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json")
        .output()?;
    let recovered = assert_json(&recovered, 0)?;
    let recovered_trace = recovery_server
        .join()
        .map_err(|_| "recovery provider fixture panicked")?
        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
    assert_eq!(recovered["status"], "sealed", "{recovered}");
    assert_eq!(recovered["outcome"], "completed");
    assert_eq!(
        recovered["result"]["provider_operation"]["data"]["provider"],
        provider_a
    );
    assert_eq!(
        ambiguous_trace.idempotency_key, recovered_trace.idempotency_key,
        "recovery must preserve the original mutation key"
    );
    let receipt_id = json_string(&recovered, "receipt_id")?;
    assert_receipt_verifies(&root, &receipt_dir, receipt_id)?;
    Ok(())
}

fn send_apply_inputs(provider: &str) -> Value {
    serde_json::json!({
        "send_plan": send_plan(provider),
        "connector": {
            "provider": provider,
            "target": "account:acct_release/channel:release-subscribers"
        }
    })
}

fn send_plan(provider: &str) -> Value {
    serde_json::json!({
        "decision": "ready",
        "action_family": "send-as",
        "principal": {"type": "account", "ref": "account:release-bot"},
        "provider": {"name": provider, "account_ref": "acct_release", "runtime_path": "provider.send"},
        "send_class": "status",
        "channel": "email",
        "audience": {"type": "channel", "ref": "release-subscribers", "requires_reconfirmation": false},
        "content": {
            "draft_ref": "message:release-notice",
            "digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "subject_or_title": "Release notice"
        },
        "gates": {"preflight_required": true, "human_approval_required": true, "approval_ref": "send-as.live-send.approval"},
        "blockers": [],
        "provider_actions": ["message.send"],
        "evidence_refs": ["provider_context:provider-send-demo"],
        "success_checkpoint": {
            "milestone": "send_ready_for_approval",
            "description": "The exact digest-bound release notice awaits live-send approval."
        }
    })
}

#[test]
fn business_ops_durable_route_replays_once_and_returns_reusable_state() -> TestResult {
    let root = crate::support::temp_root("runx-business-ops-durable-journey");
    let repo_root = crate::support::repo_root()?;
    let receipt_dir = root.join(".runx/receipts");
    fs::create_dir_all(root.join(".runx/data"))?;
    let data_sources = serde_json::json!({
        "data_sources": {
            "tenant://journey/business-ops": {
                "adapter": "data.sqlite",
                "database_path": ".runx/data/business-ops.sqlite",
                "resources": {
                    "ops_routes": {
                        "kind": "event_stream",
                        "partition_key": "aggregate_id"
                    }
                }
            }
        }
    })
    .to_string();

    let run = || -> TestResult<Value> {
        let output = command(&root)
            .env("RUNX_DATA_SOURCES", &data_sources)
            .arg("skill")
            .arg(repo_root.join("skills/business-ops"))
            .arg("route_and_append")
            .args([
                "--input",
                "data_source_ref=tenant://journey/business-ops",
                "--input",
                "resource=ops_routes",
                "--input",
                "aggregate_id=launch-readiness",
                "--input",
                "expected_version=0",
                "--input",
                "idempotency_key=launch-readiness:classify:v1",
                "--input",
                "signal=Launch readiness needs incident, publication, and payment coordination.",
                "--input",
                "operator_context=Reuse this route; consequential effects remain in their owning skills.",
            ])
            .arg("--receipt-dir")
            .arg(&receipt_dir)
            .arg("--json")
            .output()?;
        assert_json(&output, 0)
    };

    let committed = run()?;
    assert_eq!(committed["status"], "sealed");
    assert_eq!(
        committed["result"]["route_persistence"]["data"]["append_status"],
        "committed"
    );
    assert_eq!(
        committed["result"]["route_persistence"]["data"]["projection"]["event_count"],
        1
    );
    assert_eq!(
        committed["result"]["lane_packet"]["data"]["lane"],
        "classify"
    );

    let replayed = run()?;
    assert_eq!(replayed["status"], "sealed");
    assert_eq!(
        replayed["result"]["route_persistence"]["data"]["append_status"],
        "idempotent_replay"
    );
    assert_eq!(
        replayed["result"]["route_persistence"]["data"]["projection"]["event_count"], 1,
        "replaying the same route must not append another event"
    );
    assert_eq!(
        replayed["result"]["route_persistence"]["data"]["projection"]["version"],
        1
    );

    for result in [&committed, &replayed] {
        let receipt_id = json_string(result, "receipt_id")?;
        assert_receipt_verifies(&root, &receipt_dir, receipt_id)?;
    }
    Ok(())
}

#[test]
fn incident_turn_reuses_case_approval_across_agent_resume_without_claiming_delivery() -> TestResult
{
    let root = crate::support::temp_root("runx-incident-resume-journey");
    let repo_root = crate::support::repo_root()?;
    let receipt_dir = root.join(".runx/receipts");
    let inputs = root.join("incident-inputs.json");
    fs::create_dir_all(&root)?;
    fs::write(
        &inputs,
        serde_json::json!({
            "case_id": "inc-sev2-checkout",
            "driver_id": "driver-primary",
            "incident_objective": "send",
            "case_state": {
                "declared": true,
                "severity": "SEV-2",
                "scope": "checkout-api",
                "turn": 4,
                "pending_escalation": {
                    "status": "awaiting_approval",
                    "lane": "human:incident-reviewer",
                    "proposed_handoff": {
                        "skill": "send-as",
                        "runner": "plan",
                        "principal": "incident:comms:morgan",
                        "channel": "email",
                        "audience": {
                            "list_ref": "stakeholders:checkout-api",
                            "classification": "incident-stakeholders"
                        },
                        "content_digest": "sha256:4e44f31f628799267f0957c554b8c47d90d2eabf41e5a84248941d28c45955ae"
                    }
                }
            },
            "roster": [
                {"role": "commander", "principal": "incident:commander:alex", "skill": "ops-desk", "scope": ["incident.command"]},
                {"role": "responder_lead", "principal": "incident:responder:rio", "skill": "incident-response", "scope": ["incident.respond"]},
                {"role": "comms_lead", "principal": "incident:comms:morgan", "skill": "send-as", "scope": ["stakeholder.send"]}
            ],
            "approval": {
                "principal": "incident:comms:morgan",
                "reason": "Approve this exact audience and content digest for send planning."
            }
        })
        .to_string(),
    )?;

    let pause = command(&root)
        .arg("skill")
        .arg(repo_root.join("skills/incident-commander"))
        .arg("advance")
        .arg("--inputs")
        .arg("incident-inputs.json")
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .args(["--json"])
        .output()?;
    let pause = assert_json(&pause, 2)?;
    assert_eq!(pause["status"], "needs_agent");
    let run_id = json_string(&pause, "run_id")?;
    let request_id = pause["requests"]
        .as_array()
        .and_then(|requests| requests.first())
        .and_then(|request| request["id"].as_str())
        .ok_or("incident pause omitted its agent request")?;

    let answer = serde_json::json!({
        "answers": {
            (request_id): {
                "decision": "dispatch",
                "reason": "The existing comms-lead approval permits a separate send-as planning run.",
                "dispatch": {
                    "member": "comms_lead",
                    "skill": "send-as",
                    "task": "Plan the approved stakeholder update from the bound audience and content digest.",
                    "needed_scope": ["stakeholder.send"],
                    "consequence": "stakeholder_send_handoff",
                    "verification": {
                        "expected_receipt": "runx.receipt.v1",
                        "readback": "Return provider-backed send evidence before claiming delivery."
                    }
                }
            }
        }
    })
    .to_string();
    let mut resume = command(&root);
    resume
        .arg("resume")
        .arg(run_id)
        .arg("-")
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json");
    let resumed = output_with_stdin(&mut resume, &answer)?;
    let resumed = assert_json(&resumed, 0)?;
    assert_eq!(resumed["status"], "sealed");
    assert_eq!(resumed["run_id"], run_id);
    let turn = &resumed["result"]["incident_turn"]["data"];
    assert_eq!(turn["decision"], "advanced");
    assert_eq!(turn["downstream_handoff"]["skill"], "send-as");
    assert_eq!(turn["downstream_handoff"]["state"], "ready_for_planning");
    assert_eq!(turn["delivery_status"], "not_sent");
    assert_eq!(turn["effect_state"]["provider_delivery"], "not_executed");
    assert_eq!(turn["validation"]["status"], "pass");
    let receipt_id = json_string(&resumed, "receipt_id")?;
    assert_receipt_verifies(&root, &receipt_dir, receipt_id)?;
    let history = assert_history_contains_local_receipt(&root, &receipt_dir, receipt_id)?;
    assert!(
        history["pendingRuns"]
            .as_array()
            .is_some_and(|runs| runs.iter().all(|run| run["id"] != run_id))
    );
    Ok(())
}
