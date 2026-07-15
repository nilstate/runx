use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

use runx_contracts::{JsonObject, JsonValue};

pub(super) fn write_skill_output(
    value: &JsonValue,
    json: bool,
    exit_code: ExitCode,
    resume: SkillOutputResume<'_>,
) -> ExitCode {
    if !json {
        return write_text_with_exit(value, exit_code, resume);
    }
    write_json_with_exit(value, exit_code)
}

#[derive(Clone, Copy)]
pub(super) struct SkillOutputResume<'a> {
    pub(super) skill_ref: Option<&'a str>,
    pub(super) selected_runner: Option<&'a str>,
    pub(super) receipt_dir: Option<&'a Path>,
    pub(super) answers_path: Option<&'a Path>,
}

pub(super) fn skill_result_exit_code(value: &JsonValue) -> ExitCode {
    match value {
        JsonValue::Object(object) => match object.get("status") {
            Some(JsonValue::String(status)) if status == "needs_agent" => ExitCode::from(2),
            _ => ExitCode::SUCCESS,
        },
        _ => ExitCode::SUCCESS,
    }
}

fn write_json_with_exit(value: &JsonValue, exit_code: ExitCode) -> ExitCode {
    match serde_json::to_string_pretty(value) {
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

fn write_text_with_exit(
    value: &JsonValue,
    exit_code: ExitCode,
    resume: SkillOutputResume<'_>,
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
    resume: SkillOutputResume<'_>,
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
    if let Some(summary) = summary_from_payload(object).or_else(|| closure_summary(object)) {
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
    resume: SkillOutputResume<'_>,
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
                skill_ref: resume
                    .skill_ref
                    .or_else(|| object_string(object, "skill_name")),
                run_id,
                selected_runner: resume.selected_runner,
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

fn summary_from_payload(object: &JsonObject) -> Option<&str> {
    object
        .get("payload")
        .and_then(JsonValue::as_object)
        .and_then(summary_from_object)
        .or_else(|| {
            object
                .get("execution")
                .and_then(JsonValue::as_object)
                .and_then(|execution| execution.get("structured_output"))
                .and_then(JsonValue::as_object)
                .and_then(summary_from_object)
        })
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

    use runx_contracts::{JsonObject, JsonValue};

    use super::{SkillOutputResume, write_skill_text};

    #[test]
    fn text_output_prefers_operator_payload_summary_over_receipt_closure() {
        let mut payload = JsonObject::new();
        payload.insert(
            "summary".to_owned(),
            JsonValue::String("Forecast: wet morning, dry commute home.".to_owned()),
        );
        let mut closure = JsonObject::new();
        closure.insert(
            "summary".to_owned(),
            JsonValue::String("agent act closed with closed".to_owned()),
        );
        let mut value = base_result();
        value.insert("payload".to_owned(), JsonValue::Object(payload));
        value.insert("closure".to_owned(), JsonValue::Object(closure));

        let output = render(value);

        assert!(output.contains("summary: Forecast: wet morning, dry commute home."));
        assert!(!output.contains("summary: agent act closed with closed"));
    }

    #[test]
    fn text_output_uses_closure_summary_when_payload_has_no_summary() {
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
            SkillOutputResume {
                skill_ref: Some("registry/weather"),
                selected_runner: Some("operator runner"),
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
            SkillOutputResume {
                skill_ref: None,
                selected_runner: None,
                receipt_dir: None,
                answers_path: None,
            },
        )
    }

    fn render_with_resume(value: JsonObject, resume: SkillOutputResume<'_>) -> String {
        let mut output = Vec::new();
        let write_result = write_skill_text(&mut output, &JsonValue::Object(value), resume);
        assert!(write_result.is_ok(), "text output renders");
        let rendered = String::from_utf8(output);
        assert!(rendered.is_ok(), "text output is utf8");
        rendered.unwrap_or_default()
    }
}
