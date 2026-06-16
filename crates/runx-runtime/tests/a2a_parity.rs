#![cfg(feature = "a2a")]

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use runx_contracts::{JsonNumber, JsonObject, JsonValue};
use runx_parser::SkillSource;
use runx_runtime::adapters::a2a::{
    A2aAdapter, A2aGetTaskRequest, A2aSendMessageRequest, A2aTask, A2aTaskStatus, A2aTransport,
    A2aTransportError, FixtureA2aTransport,
};
use runx_runtime::{
    InvocationStatus, RuntimeOptions, SkillAdapter, SkillInvocation,
    run_harness_fixture_with_adapter,
};

const FIXTURE_CREATED_AT: &str = "2026-05-18T00:00:00Z";

#[test]
fn a2a_fixture_transport_submits_completed_task() -> Result<(), Box<dyn std::error::Error>> {
    let mut inputs = JsonObject::new();
    inputs.insert("message".to_owned(), JsonValue::String("hi".to_owned()));

    let output = A2aAdapter::new(FixtureA2aTransport::new()).invoke(invocation(
        source(
            Some("fixture://echo-agent"),
            Some("echo"),
            Some(template_message()),
        ),
        inputs,
    ))?;

    assert_eq!(output.status, InvocationStatus::Success);
    assert_eq!(output.stdout, "hi");
    assert_eq!(output.stderr, "");
    assert_eq!(output.exit_code, Some(0));
    let a2a = metadata_a2a(&output.metadata)?;
    assert_eq!(a2a.get("agent_identity"), Some(&string("echo-agent")));
    assert_eq!(a2a.get("task"), Some(&string("echo")));
    assert_eq!(a2a.get("task_status"), Some(&string("completed")));
    assert_hash(a2a.get("agent_card_url_hash"))?;
    assert_hash(a2a.get("message_hash"))?;
    assert_hash(a2a.get("output_hash"))?;
    Ok(())
}

#[test]
fn a2a_fixture_transport_sanitizes_failed_tasks() -> Result<(), Box<dyn std::error::Error>> {
    let mut inputs = JsonObject::new();
    inputs.insert(
        "message".to_owned(),
        JsonValue::String("super-secret-value".to_owned()),
    );

    let output = A2aAdapter::new(FixtureA2aTransport::new()).invoke(invocation(
        source(
            Some("fixture://echo-agent"),
            Some("fail"),
            Some(template_message()),
        ),
        inputs,
    ))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stdout, "");
    assert_eq!(output.stderr, "A2A task failed.");
    assert!(!format!("{output:?}").contains("super-secret-value"));
    let a2a = metadata_a2a(&output.metadata)?;
    assert_eq!(a2a.get("task_status"), Some(&string("failed")));
    assert_eq!(a2a.get("output_hash"), None);
    Ok(())
}

#[test]
fn a2a_reports_missing_metadata_as_user_failure() -> Result<(), Box<dyn std::error::Error>> {
    let output = A2aAdapter::new(FixtureA2aTransport::new())
        .invoke(invocation(source(None, None, None), JsonObject::new()))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(
        output.stderr,
        "A2A source requires agent_card_url and task metadata."
    );
    assert!(output.metadata.is_empty());
    Ok(())
}

#[test]
fn a2a_embedded_templates_stringify_inputs() -> Result<(), Box<dyn std::error::Error>> {
    let transport = RecordingTransport::completed(JsonValue::String("ok".to_owned()));
    let mut template = JsonObject::new();
    template.insert(
        "message".to_owned(),
        JsonValue::String("count={{ count }} payload={{ payload }}".to_owned()),
    );
    let mut inputs = JsonObject::new();
    inputs.insert("count".to_owned(), JsonValue::Number(JsonNumber::I64(3)));
    inputs.insert(
        "payload".to_owned(),
        JsonValue::Object([("ok".to_owned(), JsonValue::Bool(true))].into()),
    );

    let output = A2aAdapter::new(&transport).invoke(invocation(
        source(Some("fixture://echo-agent"), Some("echo"), Some(template)),
        inputs,
    ))?;

    assert_eq!(output.status, InvocationStatus::Success);
    let requests = transport.sent.borrow();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].message.get("message"),
        Some(&string(r#"count=3 payload={"ok":true}"#))
    );
    Ok(())
}

#[test]
fn a2a_preserves_exact_template_values() -> Result<(), Box<dyn std::error::Error>> {
    let transport = RecordingTransport::completed(JsonValue::String("ok".to_owned()));
    let mut template = JsonObject::new();
    template.insert(
        "message".to_owned(),
        JsonValue::String("{{ payload }}".to_owned()),
    );
    let mut inputs = JsonObject::new();
    inputs.insert(
        "payload".to_owned(),
        JsonValue::Object([("ok".to_owned(), JsonValue::Bool(true))].into()),
    );

    let output = A2aAdapter::new(&transport).invoke(invocation(
        source(Some("fixture://echo-agent"), Some("echo"), Some(template)),
        inputs,
    ))?;

    assert_eq!(output.status, InvocationStatus::Success);
    let requests = transport.sent.borrow();
    assert_eq!(
        requests[0].message.get("message"),
        Some(&JsonValue::Object(
            [("ok".to_owned(), JsonValue::Bool(true))].into()
        ))
    );
    Ok(())
}

#[test]
fn a2a_resolved_inputs_take_precedence() -> Result<(), Box<dyn std::error::Error>> {
    let transport = RecordingTransport::completed(JsonValue::String("ok".to_owned()));
    let mut template = JsonObject::new();
    template.insert(
        "exact".to_owned(),
        JsonValue::String("{{ payload }}".to_owned()),
    );
    template.insert(
        "embedded".to_owned(),
        JsonValue::String("message={{ message }}".to_owned()),
    );
    let mut inputs = JsonObject::new();
    inputs.insert("payload".to_owned(), JsonValue::String("raw".to_owned()));
    inputs.insert("message".to_owned(), JsonValue::String("raw".to_owned()));
    let mut invocation = invocation(
        source(Some("fixture://echo-agent"), Some("echo"), Some(template)),
        inputs,
    );
    invocation.resolved_inputs.insert(
        "payload".to_owned(),
        JsonValue::String("resolved".to_owned()),
    );
    invocation.resolved_inputs.insert(
        "message".to_owned(),
        JsonValue::String("resolved".to_owned()),
    );

    let output = A2aAdapter::new(&transport).invoke(invocation)?;

    assert_eq!(output.status, InvocationStatus::Success);
    let requests = transport.sent.borrow();
    assert_eq!(requests[0].message.get("exact"), Some(&string("resolved")));
    assert_eq!(
        requests[0].message.get("embedded"),
        Some(&string("message=resolved"))
    );
    Ok(())
}

#[test]
fn a2a_without_argument_template_merges_resolved_inputs() -> Result<(), Box<dyn std::error::Error>>
{
    let transport = RecordingTransport::completed(JsonValue::String("ok".to_owned()));
    let mut inputs = JsonObject::new();
    inputs.insert("raw".to_owned(), JsonValue::String("raw-value".to_owned()));
    inputs.insert(
        "shared".to_owned(),
        JsonValue::String("raw-shared".to_owned()),
    );
    let mut invocation = invocation(
        source(Some("fixture://echo-agent"), Some("echo"), None),
        inputs,
    );
    invocation.resolved_inputs.insert(
        "shared".to_owned(),
        JsonValue::String("resolved-shared".to_owned()),
    );
    invocation.resolved_inputs.insert(
        "resolved".to_owned(),
        JsonValue::String("resolved-value".to_owned()),
    );

    let output = A2aAdapter::new(&transport).invoke(invocation)?;

    assert_eq!(output.status, InvocationStatus::Success);
    let requests = transport.sent.borrow();
    assert_eq!(requests[0].message.get("raw"), Some(&string("raw-value")));
    assert_eq!(
        requests[0].message.get("shared"),
        Some(&string("resolved-shared"))
    );
    assert_eq!(
        requests[0].message.get("resolved"),
        Some(&string("resolved-value"))
    );
    Ok(())
}

#[test]
fn a2a_timeout_cancels_when_transport_supports_cancellation()
-> Result<(), Box<dyn std::error::Error>> {
    let transport = HangingTransport::default();

    let output = A2aAdapter::new(&transport).invoke(invocation(
        source(
            Some("fixture://echo-agent"),
            Some("echo"),
            Some(template_message()),
        ),
        [("message".to_owned(), string("hi"))].into(),
    ))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stderr, "A2A task timed out after 50ms.");
    assert_eq!(transport.cancel_count.get(), 1);
    let a2a = metadata_a2a(&output.metadata)?;
    assert_eq!(a2a.get("task_id"), Some(&string("a2a_hanging")));
    assert_eq!(a2a.get("task_status"), Some(&string("failed")));
    Ok(())
}

#[test]
fn a2a_cancel_failure_is_sanitized_in_metadata() -> Result<(), Box<dyn std::error::Error>> {
    let transport = HangingTransport {
        cancel_fails: true,
        ..HangingTransport::default()
    };

    let output = A2aAdapter::new(&transport).invoke(invocation(
        source(
            Some("fixture://echo-agent"),
            Some("echo"),
            Some(template_message()),
        ),
        [("message".to_owned(), string("hi"))].into(),
    ))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    let output_debug = format!("{output:?}");
    assert!(!output_debug.contains("super-secret-cancel-token"));
    let a2a = metadata_a2a(&output.metadata)?;
    assert_eq!(
        a2a.get("cancel_error"),
        Some(&string("A2A task cancellation failed."))
    );
    Ok(())
}

#[test]
fn harness_replay_runs_a2a_skill_fixture() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    std::fs::create_dir_all(&skill_dir)?;
    std::fs::write(
        skill_dir.join("SKILL.md"),
        r#"---
name: fixture-a2a
description: Fixture A2A skill.
source:
  type: a2a
  agent_card_url: fixture://echo-agent
  agent_identity: echo-agent
  task: echo
  arguments:
    message: "{{message}}"
inputs:
  message:
    type: string
    required: true
---
Echo through A2A.
"#,
    )?;
    let fixture_path = temp.path().join("harness.yaml");
    std::fs::write(
        &fixture_path,
        r#"
name: fixture-a2a
kind: a2a
target: skill
inputs:
  message: hello from harness
expect:
  status: sealed
"#,
    )?;

    let replay = run_harness_fixture_with_adapter(
        &fixture_path,
        A2aAdapter::new(FixtureA2aTransport::new()),
        fixture_runtime_options(),
    )?;

    assert_eq!(replay.status, runx_runtime::HarnessExpectedStatus::Sealed);
    let output = replay
        .skill_output
        .ok_or_else(|| std::io::Error::other("missing replay skill output"))?;
    assert_eq!(output.status, InvocationStatus::Success);
    assert_eq!(output.stdout, "hello from harness");
    Ok(())
}

fn fixture_runtime_options() -> RuntimeOptions {
    RuntimeOptions {
        created_at: FIXTURE_CREATED_AT.to_owned(),
        ..RuntimeOptions::local_development()
    }
}

#[derive(Default)]
struct HangingTransport {
    cancel_fails: bool,
    cancel_count: Cell<usize>,
}

impl A2aTransport for &HangingTransport {
    fn send_message(&self, _request: A2aSendMessageRequest) -> Result<A2aTask, A2aTransportError> {
        Ok(A2aTask {
            id: "a2a_hanging".to_owned(),
            status: A2aTaskStatus::Working,
            output: None,
            error: None,
        })
    }

    fn get_task(&self, request: A2aGetTaskRequest) -> Result<A2aTask, A2aTransportError> {
        Ok(A2aTask {
            id: request.task_id,
            status: A2aTaskStatus::Working,
            output: None,
            error: None,
        })
    }

    fn cancel_task(&self, request: A2aGetTaskRequest) -> Result<A2aTask, A2aTransportError> {
        self.cancel_count.set(self.cancel_count.get() + 1);
        if self.cancel_fails {
            return Err(A2aTransportError::failed("super-secret-cancel-token"));
        }
        Ok(A2aTask {
            id: request.task_id,
            status: A2aTaskStatus::Canceled,
            output: None,
            error: None,
        })
    }

    fn supports_cancel(&self) -> bool {
        true
    }
}

struct RecordingTransport {
    sent: RefCell<Vec<A2aSendMessageRequest>>,
    response: JsonValue,
}

impl RecordingTransport {
    fn completed(response: JsonValue) -> Self {
        Self {
            sent: RefCell::new(Vec::new()),
            response,
        }
    }
}

impl A2aTransport for &RecordingTransport {
    fn send_message(&self, request: A2aSendMessageRequest) -> Result<A2aTask, A2aTransportError> {
        self.sent.borrow_mut().push(request);
        Ok(A2aTask {
            id: "a2a_recorded".to_owned(),
            status: A2aTaskStatus::Completed,
            output: Some(self.response.clone()),
            error: None,
        })
    }

    fn get_task(&self, request: A2aGetTaskRequest) -> Result<A2aTask, A2aTransportError> {
        Ok(A2aTask {
            id: request.task_id,
            status: A2aTaskStatus::Completed,
            output: Some(self.response.clone()),
            error: None,
        })
    }
}

fn invocation(source: SkillSource, inputs: JsonObject) -> SkillInvocation {
    SkillInvocation {
        skill_name: "fixture.a2a".to_owned(),
        source,
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: ".".into(),
        env: BTreeMap::new(),
        credential_delivery: runx_runtime::CredentialDelivery::none(),
    }
}

fn source(
    agent_card_url: Option<&str>,
    task: Option<&str>,
    arguments: Option<JsonObject>,
) -> SkillSource {
    SkillSource {
        act: None,
        source_type: runx_parser::SourceKind::A2a,
        command: None,
        args: Vec::new(),
        cwd: None,
        timeout_seconds: Some(0),
        input_mode: None,
        sandbox: None,
        server: None,
        catalog_ref: None,
        tool: None,
        arguments,
        agent_card_url: agent_card_url.map(str::to_owned),
        agent_identity: Some("echo-agent".to_owned()),
        agent: None,
        task: task.map(str::to_owned),
        hook: None,
        outputs: None,
        graph: None,
        http: None,
        raw: JsonObject::new(),
    }
}

fn template_message() -> JsonObject {
    [(
        "message".to_owned(),
        JsonValue::String("{{message}}".to_owned()),
    )]
    .into()
}

fn metadata_a2a(metadata: &JsonObject) -> Result<&JsonObject, std::io::Error> {
    let Some(JsonValue::Object(a2a)) = metadata.get("a2a") else {
        return Err(std::io::Error::other("missing metadata.a2a"));
    };
    Ok(a2a)
}

fn assert_hash(value: Option<&JsonValue>) -> Result<(), std::io::Error> {
    let Some(JsonValue::String(hash)) = value else {
        return Err(std::io::Error::other("missing hash"));
    };
    assert_eq!(hash.len(), 64);
    assert!(hash.chars().all(|value| value.is_ascii_hexdigit()));
    Ok(())
}

fn string(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}
