use std::fs;

use runx_contracts::{JsonObject, JsonValue};
use serde_json::{Value, json};

use crate::javascript_worker_support::{JavaScriptPackage, expected_json, success_json};

const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn twitter_execution_progress_is_a_compact_contiguous_cursor()
-> Result<(), Box<dyn std::error::Error>> {
    let prepare = execution_package("twitter-execution.mjs")?;
    let finalize = execution_package("twitter-execution-result.mjs")?;
    let plan = delete_plan(120);
    let first = prepare_plan(&prepare, &plan, 0, empty_ledger())?;

    assert_eq!(field(&first, "decision"), Some(&json!("ready")));
    assert_eq!(array_field(&first, "act_groups")?.len(), 50);
    assert!(first.get("plan_acts").is_none());
    assert!(first.get("remaining_act_ids").is_none());

    let completed = finalize_plan(&finalize, &first, successful_responses(&first)?)?;
    assert_eq!(field(&completed, "next_act_index"), Some(&json!(50)));
    assert_eq!(field(&completed, "remaining_count"), Some(&json!(70)));
    assert!(completed.get("executed_act_ids").is_none());
    assert!(completed.get("remaining_act_ids").is_none());
    let progress = object_field(&completed, "ledger_delta")?;
    assert_eq!(field(progress, "next_act_index"), Some(&json!(50)));
    assert!(serde_json::to_vec(progress)?.len() < 1_024);

    let second = prepare_plan(&prepare, &plan, 1, ledger(1, progress.clone()))?;
    assert_eq!(field(&second, "start_act_index"), Some(&json!(50)));
    assert_eq!(
        field(&array_field(&second, "act_groups")?[0], "act_index"),
        Some(&json!(50)),
    );
    assert!(serde_json::to_vec(&second)?.len() < 100_000);
    Ok(())
}

#[test]
fn twitter_execution_stops_at_the_first_failed_act() -> Result<(), Box<dyn std::error::Error>> {
    let prepare = execution_package("twitter-execution.mjs")?;
    let finalize = execution_package("twitter-execution-result.mjs")?;
    let plan = delete_plan(3);
    let prepared = prepare_plan(&prepare, &plan, 0, empty_ledger())?;
    let responses = json!([
        success_response("act:delete-0", json!({ "deleted": true })),
        failure_response("act:delete-1", 500, "provider failed")
    ]);
    let completed = finalize_plan(&finalize, &prepared, responses)?;

    assert_eq!(field(&completed, "decision"), Some(&json!("partial")));
    assert_eq!(field(&completed, "next_act_index"), Some(&json!(1)));
    assert_eq!(field(&completed, "remaining_count"), Some(&json!(2)));
    assert_eq!(array_field(&completed, "results")?.len(), 2);
    assert_eq!(
        field(object_field(&completed, "ledger_delta")?, "next_act_index"),
        Some(&json!(1)),
    );
    Ok(())
}

#[test]
fn twitter_thread_progress_resumes_after_the_last_confirmed_segment()
-> Result<(), Box<dyn std::error::Error>> {
    let prepare = execution_package("twitter-execution.mjs")?;
    let finalize = execution_package("twitter-execution-result.mjs")?;
    let plan = json!({
        "decision": "ready",
        "principal": "account:@example",
        "acts": [
            {
                "act_id": "thread-1",
                "kind": "thread",
                "params": { "texts": ["one", "two", "three"] }
            },
            {
                "act_id": "post-2",
                "kind": "post",
                "params": { "text": "after" }
            }
        ],
        "gates": { "human_approval_required": true }
    });
    let prepared = prepare_plan(&prepare, &plan, 0, empty_ledger())?;
    let responses = json!([
        success_response("act:thread-1:segment:0", json!({ "id": "tweet-1" })),
        failure_response("act:thread-1:segment:1", 503, "retry later")
    ]);
    let completed = finalize_plan(&finalize, &prepared, responses)?;
    let progress = object_field(&completed, "ledger_delta")?.clone();
    let active = object_field(&progress, "active_thread")?;
    assert_eq!(field(active, "next_segment_index"), Some(&json!(1)));
    assert_eq!(field(active, "in_reply_to"), Some(&json!("tweet-1")));

    let resumed = prepare_plan(&prepare, &plan, 1, ledger(1, progress))?;
    let requests = array_field(&resumed, "requests")?;
    assert_eq!(
        field(&requests[0], "id"),
        Some(&json!("act:thread-1:segment:1"))
    );
    assert_eq!(
        requests[0].pointer("/body/reply/in_reply_to_tweet_id"),
        Some(&json!("tweet-1")),
    );
    assert!(
        requests
            .iter()
            .all(|request| { field(request, "id") != Some(&json!("act:thread-1:segment:0")) })
    );
    Ok(())
}

fn execution_package(entry: &str) -> Result<JavaScriptPackage, Box<dyn std::error::Error>> {
    let root = "../../skills/twitter";
    let source = fs::read_to_string(format!("{root}/{entry}"))?;
    let values = fs::read_to_string(format!("{root}/twitter-execution-values.mjs"))?;
    if entry == "twitter-execution-result.mjs" {
        return JavaScriptPackage::with_modules(
            &source,
            [("twitter-execution-values.mjs", values.as_str())],
        );
    }
    let requests = fs::read_to_string(format!("{root}/twitter-execution-requests.mjs"))?;
    JavaScriptPackage::with_modules(
        &source,
        [
            ("twitter-execution-requests.mjs", requests.as_str()),
            ("twitter-execution-values.mjs", values.as_str()),
        ],
    )
}

fn prepare_plan(
    package: &JavaScriptPackage,
    plan: &Value,
    expected_version: u64,
    ledger: Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let output = package.invoke_export(
        "prepareExecution",
        object(json!({
            "plan_json": plan,
            "plan_digest": DIGEST,
            "digest_result": { "digest": DIGEST },
            "execution_ledger": ledger,
            "expected_version": expected_version,
            "idempotency_key": format!("twitter:{DIGEST}:v{}", expected_version + 1),
            "max_acts": 50
        }))?,
    )?;
    output_object(success_json(&output)?, "twitter_execution_plan")
}

fn finalize_plan(
    package: &JavaScriptPackage,
    plan: &Value,
    responses: Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let output = package.invoke_export(
        "finalizeExecution",
        object(json!({
            "execution_plan": plan,
            "http_execution": { "responses": responses }
        }))?,
    )?;
    output_object(success_json(&output)?, "twitter_execution")
}

fn delete_plan(count: usize) -> Value {
    let acts = (0..count)
        .map(|index| {
            json!({
                "act_id": format!("delete-{index}"),
                "kind": "delete_post",
                "params": { "post_id": index.to_string() }
            })
        })
        .collect::<Vec<_>>();
    json!({
        "decision": "ready",
        "principal": "account:@example",
        "acts": acts,
        "gates": { "human_approval_required": true }
    })
}

fn successful_responses(plan: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(Value::Array(
        array_field(plan, "requests")?
            .iter()
            .map(|request| {
                success_response(
                    request
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    json!({ "deleted": true }),
                )
            })
            .collect(),
    ))
}

fn success_response(id: &str, data: Value) -> Value {
    json!({ "id": id, "ok": true, "status": 200, "json": { "data": data }, "headers": {} })
}

fn failure_response(id: &str, status: u64, detail: &str) -> Value {
    json!({ "id": id, "ok": false, "status": status, "json": { "detail": detail }, "headers": {} })
}

fn empty_ledger() -> Value {
    json!({ "after_version": 0, "events": [] })
}

fn ledger(version: u64, event: Value) -> Value {
    json!({ "after_version": version, "events": [{ "version": version, "event": event }] })
}

fn object(value: Value) -> Result<JsonObject, Box<dyn std::error::Error>> {
    expected_json(value)
        .as_object()
        .cloned()
        .ok_or_else(|| "expected JSON object".into())
}

fn output_object(value: JsonValue, field_name: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let value = serde_json::to_value(value)?;
    value
        .get(field_name)
        .cloned()
        .ok_or_else(|| format!("output omitted {field_name}").into())
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value.get(name)
}

fn object_field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, Box<dyn std::error::Error>> {
    value
        .get(name)
        .filter(|value| value.is_object())
        .ok_or_else(|| format!("output omitted object field {name}").into())
}

fn array_field<'a>(
    value: &'a Value,
    name: &str,
) -> Result<&'a [Value], Box<dyn std::error::Error>> {
    value
        .get(name)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("output omitted array field {name}").into())
}
