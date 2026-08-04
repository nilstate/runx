use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

use runx_contracts::{ClosureDisposition, JsonObject, JsonValue};

pub(super) fn write_skill_output(
    value: &JsonValue,
    json: bool,
    exit_code: ExitCode,
    resume: ResumeHint<'_>,
) -> ExitCode {
    if !json {
        return write_text_with_exit(value, exit_code, resume);
    }
    write_json_with_exit(value, exit_code)
}

#[derive(Clone, Copy)]
pub(super) struct ResumeHint<'a> {
    pub(super) receipt_dir: Option<&'a Path>,
    pub(super) answers_path: Option<&'a Path>,
}

pub(super) fn skill_result_exit_code(value: &JsonValue) -> ExitCode {
    match value {
        JsonValue::Object(object)
            if object.get("status").and_then(JsonValue::as_str) == Some("needs_agent") =>
        {
            ExitCode::from(2)
        }
        JsonValue::Object(object) => match object
            .get("closure")
            .and_then(JsonValue::as_object)
            .and_then(|closure| closure.get("disposition"))
            .cloned()
            .map(JsonValue::deserialize_into::<ClosureDisposition>)
        {
            Some(Ok(disposition)) => closure_disposition_exit_code(disposition),
            None => ExitCode::SUCCESS,
            Some(Err(_)) => ExitCode::from(1),
        },
        _ => ExitCode::SUCCESS,
    }
}

fn closure_disposition_exit_code(disposition: ClosureDisposition) -> ExitCode {
    match disposition {
        ClosureDisposition::Closed => ExitCode::SUCCESS,
        ClosureDisposition::Deferred => ExitCode::from(2),
        ClosureDisposition::Superseded
        | ClosureDisposition::Declined
        | ClosureDisposition::Blocked
        | ClosureDisposition::Failed
        | ClosureDisposition::Killed
        | ClosureDisposition::TimedOut => ExitCode::from(1),
    }
}

fn write_json_with_exit(value: &JsonValue, exit_code: ExitCode) -> ExitCode {
    match serialize_json_output(value) {
        Ok(json) => {
            let mut stdout = io::stdout().lock();
            let result = stdout
                .write_all(json.as_bytes())
                .and_then(|_| stdout.write_all(b"\n"));
            match result {
                Ok(()) => exit_code,
                Err(_) => ExitCode::from(1),
            }
        }
        Err(error) => {
            let _ignored = writeln!(
                io::stderr(),
                "runx: failed to serialize skill result: {error}"
            );
            ExitCode::from(1)
        }
    }
}

fn serialize_json_output(value: &JsonValue) -> Result<String, serde_json::Error> {
    serde_json::to_string(&project_json_output(value))
}

fn project_json_output(value: &JsonValue) -> JsonValue {
    let mut output = value.clone();
    let JsonValue::Object(object) = &mut output else {
        return output;
    };
    let Some(result) = object.get("result").and_then(JsonValue::as_object).cloned() else {
        return output;
    };

    let mut remove_context = false;
    if let Some(JsonValue::Object(context)) = object.get_mut("context") {
        if let Some(JsonValue::Object(step_outputs)) = context.get_mut("step_outputs") {
            step_outputs.retain(|_, value| value.as_object() != Some(&result));
            if step_outputs.is_empty() {
                context.remove("step_outputs");
            }
        }
        remove_context = context.is_empty();
    }
    if remove_context {
        object.remove("context");
    }
    output
}

fn write_text_with_exit(
    value: &JsonValue,
    exit_code: ExitCode,
    resume: ResumeHint<'_>,
) -> ExitCode {
    let mut stdout = io::stdout().lock();
    let result = write_skill_text(&mut stdout, value, resume);
    match result {
        Ok(()) => exit_code,
        Err(_) => ExitCode::from(1),
    }
}

fn write_skill_text(
    writer: &mut dyn Write,
    value: &JsonValue,
    resume: ResumeHint<'_>,
) -> io::Result<()> {
    let Some(object) = value.as_object() else {
        let text = serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned());
        return writeln!(writer, "{text}");
    };
    writeln!(
        writer,
        "status: {}",
        object_string(object, "status").unwrap_or("unknown")
    )?;
    if let Some(skill_name) = object_string(object, "skill_name") {
        writeln!(writer, "skill: {skill_name}")?;
    }
    if let Some(run_id) = object_string(object, "run_id") {
        writeln!(writer, "run_id: {run_id}")?;
    }
    if let Some(receipt_id) = object_string(object, "receipt_id") {
        writeln!(writer, "receipt_id: {receipt_id}")?;
    }
    if let Some(provenance) = object
        .get("registry_provenance")
        .and_then(JsonValue::as_object)
    {
        writeln!(writer, "registry:")?;
        write_registry_provenance(writer, provenance)?;
    }
    if let Some(summary) = summary_from_result(object).or_else(|| closure_summary(object)) {
        writeln!(writer, "summary: {summary}")?;
    }
    if let Some(requests) = object.get("requests").and_then(JsonValue::as_array) {
        write_pending_requests(writer, object, requests, resume)?;
    }
    Ok(())
}

fn write_pending_requests(
    writer: &mut dyn Write,
    object: &JsonObject,
    requests: &[JsonValue],
    resume: ResumeHint<'_>,
) -> io::Result<()> {
    writeln!(writer, "pending_requests: {}", requests.len())?;
    for request in requests {
        if let Some(request) = request.as_object() {
            let id = object_string(request, "id").unwrap_or("<unknown>");
            let kind = object_string(request, "kind").unwrap_or("<unknown>");
            writeln!(writer, "- {kind}: {id}")?;
        }
    }
    if let Some(template) = answers_template(requests) {
        writeln!(writer, "answers_template:")?;
        write_indented_json(writer, &template)?;
    }
    if let Some(run_id) = object_string(object, "run_id") {
        let command =
            crate::resume::render_skill_resume_command(crate::resume::SkillResumeCommand {
                run_id,
                receipt_dir: resume.receipt_dir,
                answers_path: resume.answers_path,
            });
        writeln!(writer, "next: resolve the request, then rerun: {command}")?;
    }
    Ok(())
}

fn answers_template(requests: &[JsonValue]) -> Option<JsonValue> {
    let mut answers = JsonObject::new();
    let mut approvals = JsonObject::new();
    for request in requests {
        let Some(request) = request.as_object() else {
            continue;
        };
        let Some(id) = object_string(request, "id") else {
            continue;
        };
        if object_string(request, "kind") == Some("approval") {
            approvals.insert(id.to_owned(), JsonValue::Bool(false));
        } else {
            answers.insert(id.to_owned(), JsonValue::Object(JsonObject::new()));
        }
    }
    if answers.is_empty() && approvals.is_empty() {
        return None;
    }
    let mut template = JsonObject::new();
    if !answers.is_empty() {
        template.insert("answers".to_owned(), JsonValue::Object(answers));
    }
    if !approvals.is_empty() {
        template.insert("approvals".to_owned(), JsonValue::Object(approvals));
    }
    Some(JsonValue::Object(template))
}

fn write_indented_json(writer: &mut dyn Write, value: &JsonValue) -> io::Result<()> {
    let json = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_owned());
    for line in json.lines() {
        writeln!(writer, "  {line}")?;
    }
    Ok(())
}

fn write_registry_provenance(writer: &mut dyn Write, object: &JsonObject) -> io::Result<()> {
    for key in [
        "skill_id",
        "version",
        "digest",
        "profile_digest",
        "registry_source",
        "registry_source_fingerprint",
        "trust_tier",
        "registry_key_id",
        "trust_state",
    ] {
        if let Some(value) = object_string(object, key) {
            writeln!(writer, "  {key}: {value}")?;
        }
    }
    Ok(())
}

fn summary_from_result(object: &JsonObject) -> Option<&str> {
    object
        .get("result")
        .and_then(JsonValue::as_object)
        .and_then(summary_from_object)
}

fn closure_summary(object: &JsonObject) -> Option<&str> {
    object
        .get("closure")
        .and_then(JsonValue::as_object)
        .and_then(|closure| object_string(closure, "summary"))
}

fn summary_from_object(object: &JsonObject) -> Option<&str> {
    object_string(object, "summary").or_else(|| {
        object
            .get("forecast_packet")
            .and_then(JsonValue::as_object)
            .and_then(|packet| object_string(packet, "summary"))
    })
}

fn object_string<'a>(object: &'a JsonObject, key: &str) -> Option<&'a str> {
    object.get(key).and_then(JsonValue::as_str)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::ExitCode;

    use runx_contracts::{JsonObject, JsonValue};

    use super::{
        ResumeHint, closure_disposition_exit_code, serialize_json_output, skill_result_exit_code,
        write_skill_text,
    };

    #[test]
    fn json_output_is_compact_and_omits_result_duplicates() -> Result<(), serde_json::Error> {
        let result = JsonValue::Object(JsonObject::from([
            ("message".to_owned(), JsonValue::String("ready".to_owned())),
            (
                "status".to_owned(),
                JsonValue::String("complete".to_owned()),
            ),
        ]));
        let value = JsonValue::Object(JsonObject::from([
            ("result".to_owned(), result.clone()),
            (
                "context".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "step_outputs".to_owned(),
                    JsonValue::Object(JsonObject::from([
                        ("final".to_owned(), result),
                        (
                            "prior".to_owned(),
                            JsonValue::Object(JsonObject::from([(
                                "evidence".to_owned(),
                                JsonValue::String("kept".to_owned()),
                            )])),
                        ),
                        (
                            "matching_subset".to_owned(),
                            JsonValue::Object(JsonObject::from([(
                                "message".to_owned(),
                                JsonValue::String("ready".to_owned()),
                            )])),
                        ),
                    ])),
                )])),
            ),
        ]));

        let serialized = serialize_json_output(&value)?;

        assert_eq!(
            serialized,
            r#"{"context":{"step_outputs":{"matching_subset":{"message":"ready"},"prior":{"evidence":"kept"}}},"result":{"message":"ready","status":"complete"}}"#
        );
        Ok(())
    }

    #[test]
    fn terminal_dispositions_have_exhaustive_exit_semantics() {
        let docs = include_str!("../../../../docs/cli-exit-codes.md");
        for (disposition, label, expected, numeric) in [
            (
                runx_contracts::ClosureDisposition::Closed,
                "closed",
                ExitCode::SUCCESS,
                0,
            ),
            (
                runx_contracts::ClosureDisposition::Deferred,
                "deferred",
                ExitCode::from(2),
                2,
            ),
            (
                runx_contracts::ClosureDisposition::Superseded,
                "superseded",
                ExitCode::from(1),
                1,
            ),
            (
                runx_contracts::ClosureDisposition::Declined,
                "declined",
                ExitCode::from(1),
                1,
            ),
            (
                runx_contracts::ClosureDisposition::Blocked,
                "blocked",
                ExitCode::from(1),
                1,
            ),
            (
                runx_contracts::ClosureDisposition::Failed,
                "failed",
                ExitCode::from(1),
                1,
            ),
            (
                runx_contracts::ClosureDisposition::Killed,
                "killed",
                ExitCode::from(1),
                1,
            ),
            (
                runx_contracts::ClosureDisposition::TimedOut,
                "timed_out",
                ExitCode::from(1),
                1,
            ),
        ] {
            assert_eq!(
                closure_disposition_exit_code(disposition),
                expected,
                "{label} typed exit code"
            );
            let value = JsonValue::Object(JsonObject::from([
                ("status".to_owned(), JsonValue::String("sealed".to_owned())),
                (
                    "closure".to_owned(),
                    JsonValue::Object(JsonObject::from([(
                        "disposition".to_owned(),
                        JsonValue::String(label.to_owned()),
                    )])),
                ),
            ]));

            assert_eq!(
                skill_result_exit_code(&value),
                expected,
                "{label} envelope exit code"
            );
            assert!(
                docs.contains(&format!("| `{label}` | {numeric} |")),
                "CLI exit-code documentation omitted {label}"
            );
        }

        let malformed = JsonValue::Object(JsonObject::from([(
            "closure".to_owned(),
            JsonValue::Object(JsonObject::from([(
                "disposition".to_owned(),
                JsonValue::String("not-a-disposition".to_owned()),
            )])),
        )]));
        assert_eq!(skill_result_exit_code(&malformed), ExitCode::from(1));
    }

    #[test]
    fn text_output_prefers_result_summary_over_receipt_closure() {
        let mut result = JsonObject::new();
        result.insert(
            "summary".to_owned(),
            JsonValue::String("Forecast: wet morning, dry commute home.".to_owned()),
        );
        let mut closure = JsonObject::new();
        closure.insert(
            "summary".to_owned(),
            JsonValue::String("agent act closed with closed".to_owned()),
        );
        let mut value = base_result();
        value.insert("result".to_owned(), JsonValue::Object(result));
        value.insert("closure".to_owned(), JsonValue::Object(closure));

        let output = render(value);

        assert!(output.contains("summary: Forecast: wet morning, dry commute home."));
        assert!(!output.contains("summary: agent act closed with closed"));
    }

    #[test]
    fn text_output_uses_closure_summary_when_result_has_no_summary() {
        let mut closure = JsonObject::new();
        closure.insert(
            "summary".to_owned(),
            JsonValue::String("graph nws-weather-forecast completed".to_owned()),
        );
        let mut value = base_result();
        value.insert("closure".to_owned(), JsonValue::Object(closure));

        let output = render(value);

        assert!(output.contains("summary: graph nws-weather-forecast completed"));
    }

    #[test]
    fn text_output_includes_resume_metadata_for_pending_requests() {
        let mut value = base_result();
        value.insert(
            "status".to_owned(),
            JsonValue::String("needs_agent".to_owned()),
        );
        value.insert(
            "requests".to_owned(),
            JsonValue::Array(vec![JsonValue::Object(JsonObject::from([
                ("id".to_owned(), JsonValue::String("request_1".to_owned())),
                ("kind".to_owned(), JsonValue::String("agent_act".to_owned())),
            ]))]),
        );

        let output = render_with_resume(
            value,
            ResumeHint {
                receipt_dir: Some(Path::new("custom receipts")),
                answers_path: Some(Path::new("operator answers.json")),
            },
        );

        assert!(output.contains(
            "runx resume run_weather 'operator answers.json' --receipt-dir 'custom receipts'"
        ));
        assert!(output.contains("answers_template:"));
        assert!(output.contains(r#""request_1": {}"#));
    }

    #[test]
    fn text_output_emits_fail_closed_approval_template() {
        let mut value = base_result();
        value.insert(
            "status".to_owned(),
            JsonValue::String("needs_agent".to_owned()),
        );
        value.insert(
            "requests".to_owned(),
            JsonValue::Array(vec![JsonValue::Object(JsonObject::from([
                (
                    "id".to_owned(),
                    JsonValue::String("sourcey.discovery.approval".to_owned()),
                ),
                ("kind".to_owned(), JsonValue::String("approval".to_owned())),
            ]))]),
        );

        let output = render(value);

        assert!(output.contains(r#""approvals""#));
        assert!(output.contains(r#""sourcey.discovery.approval": false"#));
        assert!(!output.contains(r#""sourcey.discovery.approval": {}"#));
    }

    fn base_result() -> JsonObject {
        JsonObject::from([
            ("status".to_owned(), JsonValue::String("sealed".to_owned())),
            (
                "skill_name".to_owned(),
                JsonValue::String("weather-forecast".to_owned()),
            ),
            (
                "run_id".to_owned(),
                JsonValue::String("run_weather".to_owned()),
            ),
            (
                "receipt_id".to_owned(),
                JsonValue::String("sha256:abc".to_owned()),
            ),
        ])
    }

    fn render(value: JsonObject) -> String {
        render_with_resume(
            value,
            ResumeHint {
                receipt_dir: None,
                answers_path: None,
            },
        )
    }

    fn render_with_resume(value: JsonObject, resume: ResumeHint<'_>) -> String {
        let mut output = Vec::new();
        let write_result = write_skill_text(&mut output, &JsonValue::Object(value), resume);
        assert!(write_result.is_ok(), "text output renders");
        let rendered = String::from_utf8(output);
        assert!(rendered.is_ok(), "text output is utf8");
        rendered.unwrap_or_default()
    }
}
