use std::fs;

use runx_contracts::{JsonNumber, JsonObject, JsonValue};

use crate::javascript_worker_support::{JavaScriptPackage, success_json};

const RECORD_COUNT: usize = 12_000;
const OLD_ARCHIVE_LIMIT: usize = 8 * 1024 * 1024;

#[test]
fn archive_volume_independent_twitter_selection_is_identical_across_page_sizes()
-> Result<(), Box<dyn std::error::Error>> {
    let module = fs::read_to_string("../../skills/twitter/twitter-selection.mjs")?;
    let archive = twitter_archive(RECORD_COUNT);
    assert!(archive.len() > OLD_ARCHIVE_LIMIT);

    let small = run_selection(&module, &archive, 64 * 1024)?;
    let regular = run_selection(&module, &archive, 512 * 1024)?;
    assert_eq!(selection_summary(&small)?, selection_summary(&regular)?);

    let summary = selection_summary(&small)?;
    assert_eq!(summary.scanned, RECORD_COUNT as u64);
    assert_eq!(summary.matched, 6);
    assert_eq!(
        summary.act_ids,
        [0, 2_000, 4_000, 6_000, 8_000, 10_000].map(|index| format!("act-del-{index}"))
    );
    Ok(())
}

fn run_selection(
    module: &str,
    archive: &str,
    page_bytes: u64,
) -> Result<JsonValue, Box<dyn std::error::Error>> {
    let package = JavaScriptPackage::new(module)?;
    let predicate = JsonObject::from([
        ("is_retweet".to_owned(), JsonValue::Bool(true)),
        (
            "rt_of".to_owned(),
            JsonValue::String("RunxProof".to_owned()),
        ),
    ]);
    let output = package.invoke_paged_export(
        "fixtures/data/tweets.js",
        archive,
        page_bytes,
        "selectArchivePage",
        JsonObject::from([
            (
                "objective".to_owned(),
                JsonValue::String("Select the exact governed archive predicate.".to_owned()),
            ),
            (
                "principal".to_owned(),
                JsonValue::String("account:@volume-proof".to_owned()),
            ),
            ("predicate".to_owned(), JsonValue::Object(predicate.clone())),
            (
                "max_acts".to_owned(),
                JsonValue::Number(JsonNumber::U64(100)),
            ),
            (
                "selection_plan".to_owned(),
                JsonValue::Object(JsonObject::from([
                    ("decision".to_owned(), JsonValue::String("ready".to_owned())),
                    ("target".to_owned(), JsonValue::String("posts".to_owned())),
                    ("predicate".to_owned(), JsonValue::Object(predicate)),
                    ("blockers".to_owned(), JsonValue::Array(Vec::new())),
                ])),
            ),
        ]),
    )?;
    success_json(&output)
}

#[derive(Debug, Eq, PartialEq)]
struct SelectionSummary {
    scanned: u64,
    matched: u64,
    act_ids: Vec<String>,
}

fn selection_summary(value: &JsonValue) -> Result<SelectionSummary, Box<dyn std::error::Error>> {
    let draft = object_field(value, "twitter_selection_draft")?;
    let plan = object_field_value(draft, "twitter_plan")?;
    let acts = array_field(plan, "acts")?;
    Ok(SelectionSummary {
        scanned: u64_field(draft, "scanned")?,
        matched: u64_field(draft, "matched")?,
        act_ids: acts
            .iter()
            .map(|act| {
                act.as_object()
                    .and_then(|act| act.get("act_id"))
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| "selected act omitted act_id".into())
            })
            .collect::<Result<_, Box<dyn std::error::Error>>>()?,
    })
}

fn object_field<'a>(
    value: &'a JsonValue,
    field: &str,
) -> Result<&'a JsonObject, Box<dyn std::error::Error>> {
    value
        .as_object()
        .and_then(|value| value.get(field))
        .and_then(JsonValue::as_object)
        .ok_or_else(|| format!("output omitted object field {field}").into())
}

fn object_field_value<'a>(
    value: &'a JsonObject,
    field: &str,
) -> Result<&'a JsonObject, Box<dyn std::error::Error>> {
    value
        .get(field)
        .and_then(JsonValue::as_object)
        .ok_or_else(|| format!("output omitted object field {field}").into())
}

fn array_field<'a>(
    value: &'a JsonObject,
    field: &str,
) -> Result<&'a [JsonValue], Box<dyn std::error::Error>> {
    value
        .get(field)
        .and_then(JsonValue::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("output omitted array field {field}").into())
}

fn u64_field(value: &JsonObject, field: &str) -> Result<u64, Box<dyn std::error::Error>> {
    match value.get(field) {
        Some(JsonValue::Number(JsonNumber::U64(value))) => Ok(*value),
        Some(JsonValue::Number(JsonNumber::I64(value))) => Ok(u64::try_from(*value)?),
        _ => Err(format!("output omitted numeric field {field}").into()),
    }
}

fn twitter_archive(count: usize) -> String {
    let padding = "x".repeat(720);
    let mut archive = String::with_capacity(count * 900);
    archive.push_str("window.YTD.tweets.part0 = [\n");
    for index in 0..count {
        if index > 0 {
            archive.push_str(",\n");
        }
        let text = if index % 2_000 == 0 {
            format!("RT @RunxProof: selected-{index} {padding}")
        } else {
            format!("ordinary-{index} {padding}")
        };
        archive.push_str(
            &serde_json::json!({
                "tweet": {
                    "id_str": index.to_string(),
                    "full_text": text,
                    "favorite_count": "0",
                    "retweet_count": "0",
                    "created_at": "Mon Jan 01 00:00:00 +0000 2024"
                }
            })
            .to_string(),
        );
    }
    archive.push_str("\n];\n");
    archive
}
