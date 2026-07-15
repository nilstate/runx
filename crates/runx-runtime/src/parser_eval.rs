use std::fmt;

use runx_contracts::{JsonObject, JsonValue, json_string_field};
use runx_parser::{
    ParseError, SkillInstallError, SkillInstallOrigin, ValidateSkillMode, ValidateSkillOptions,
    ValidationError, parse_graph_yaml, parse_runner_manifest_yaml, parse_skill_markdown,
    parse_tool_manifest_json, parse_tool_manifest_yaml, runner::resolve_post_run_reflect_policy,
    validate_graph, validate_runner_manifest, validate_skill_artifact_contract,
    validate_skill_install, validate_skill_source, validate_skill_with_options,
    validate_tool_manifest,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ParserEvalOutput {
    Output { value: JsonValue },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParserEvalError {
    InvalidDocument(String),
    InvalidInput(String),
    Parse(String),
    Validation(String),
    SerializeOutput(String),
}

impl ParserEvalError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidDocument(_) => "invalid_document",
            Self::InvalidInput(_) => "invalid_input",
            Self::Parse(_) => "parse_error",
            Self::Validation(_) => "validation_error",
            Self::SerializeOutput(_) => "serialize_output",
        }
    }
}

impl fmt::Display for ParserEvalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDocument(message)
            | Self::InvalidInput(message)
            | Self::Parse(message)
            | Self::Validation(message)
            | Self::SerializeOutput(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ParserEvalError {}

impl From<ParseError> for ParserEvalError {
    fn from(error: ParseError) -> Self {
        Self::Parse(error.to_string())
    }
}

impl From<ValidationError> for ParserEvalError {
    fn from(error: ValidationError) -> Self {
        Self::Validation(error.to_string())
    }
}

impl From<SkillInstallError> for ParserEvalError {
    fn from(error: SkillInstallError) -> Self {
        Self::Validation(error.to_string())
    }
}

pub fn evaluate_parser_document_str(source: &str) -> Result<ParserEvalOutput, ParserEvalError> {
    let document = serde_json::from_str::<JsonValue>(source)
        .map_err(|error| ParserEvalError::InvalidDocument(error.to_string()))?;
    if let Some(kind) = parser_document_kind(&document)
        && !is_supported_parser_kind(kind)
    {
        return Err(ParserEvalError::InvalidInput(format!(
            "unsupported parser input kind '{kind}'"
        )));
    }
    let input = serde_json::from_str::<ParserDocument>(source)
        .map_err(|error| ParserEvalError::InvalidInput(error.to_string()))?;
    Ok(ParserEvalOutput::Output {
        value: evaluate_parser_input(input)?,
    })
}

fn parser_document_kind(document: &JsonValue) -> Option<&str> {
    let JsonValue::Object(fields) = document else {
        return None;
    };
    match fields.get("input") {
        Some(JsonValue::Object(input)) => json_string_field(input, "kind"),
        _ => json_string_field(fields, "kind"),
    }
}

fn is_supported_parser_kind(kind: &str) -> bool {
    matches!(
        kind,
        "parser.validateSkillMarkdown"
            | "parser.validateRunnerManifestYaml"
            | "parser.validateGraphYaml"
            | "parser.validateToolManifestYaml"
            | "parser.validateToolManifestJson"
            | "parser.validateSkillSource"
            | "parser.validateSkillArtifactContract"
            | "parser.resolvePostRunReflectPolicy"
            | "parser.validateSkillInstall"
    )
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ParserDocument {
    Envelope { input: ParserInput },
    Input(ParserInput),
}

impl From<ParserDocument> for ParserInput {
    fn from(document: ParserDocument) -> Self {
        match document {
            ParserDocument::Envelope { input } | ParserDocument::Input(input) => input,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
enum ParserInput {
    #[serde(rename = "parser.validateSkillMarkdown")]
    ValidateSkillMarkdown {
        markdown: String,
        #[serde(default)]
        mode: ParserSkillMode,
    },
    #[serde(rename = "parser.validateRunnerManifestYaml")]
    ValidateRunnerManifestYaml { yaml: String },
    #[serde(rename = "parser.validateGraphYaml")]
    ValidateGraphYaml { yaml: String },
    #[serde(rename = "parser.validateToolManifestYaml")]
    ValidateToolManifestYaml { yaml: String },
    #[serde(rename = "parser.validateToolManifestJson")]
    ValidateToolManifestJson { json: String },
    #[serde(rename = "parser.validateSkillSource")]
    ValidateSkillSource {
        source: JsonObject,
        #[serde(default)]
        runx: Option<JsonObject>,
    },
    #[serde(rename = "parser.validateSkillArtifactContract")]
    ValidateSkillArtifactContract {
        #[serde(default)]
        artifacts: Option<JsonValue>,
        #[serde(default = "default_artifact_field")]
        field: String,
    },
    #[serde(rename = "parser.resolvePostRunReflectPolicy")]
    ResolvePostRunReflectPolicy {
        #[serde(default)]
        runx: Option<JsonObject>,
        #[serde(default = "default_runx_field")]
        field: String,
    },
    #[serde(rename = "parser.validateSkillInstall")]
    ValidateSkillInstall {
        markdown: String,
        origin: SkillInstallOrigin,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ParserSkillMode {
    #[default]
    Strict,
    Lenient,
}

impl From<ParserSkillMode> for ValidateSkillOptions {
    fn from(mode: ParserSkillMode) -> Self {
        match mode {
            ParserSkillMode::Strict => Self {
                mode: ValidateSkillMode::Strict,
            },
            ParserSkillMode::Lenient => Self {
                mode: ValidateSkillMode::Lenient,
            },
        }
    }
}

fn evaluate_parser_input(input: ParserDocument) -> Result<JsonValue, ParserEvalError> {
    match ParserInput::from(input) {
        ParserInput::ValidateSkillMarkdown { markdown, mode } => {
            let raw = parse_skill_markdown(&markdown)?;
            to_json_value(validate_skill_with_options(raw, mode.into())?)
        }
        ParserInput::ValidateRunnerManifestYaml { yaml } => {
            let raw = parse_runner_manifest_yaml(&yaml)?;
            to_json_value(validate_runner_manifest(raw)?)
        }
        ParserInput::ValidateGraphYaml { yaml } => {
            let raw = parse_graph_yaml(&yaml)?;
            to_json_value(validate_graph(raw)?)
        }
        ParserInput::ValidateToolManifestYaml { yaml } => {
            let raw = parse_tool_manifest_yaml(&yaml)?;
            to_json_value(validate_tool_manifest(raw)?)
        }
        ParserInput::ValidateToolManifestJson { json } => {
            let raw = parse_tool_manifest_json(&json)?;
            to_json_value(validate_tool_manifest(raw)?)
        }
        ParserInput::ValidateSkillSource { source, runx } => {
            to_json_value(validate_skill_source(&source, runx.as_ref())?)
        }
        ParserInput::ValidateSkillArtifactContract { artifacts, field } => to_json_value(
            validate_skill_artifact_contract(artifacts.as_ref(), &field)?,
        ),
        ParserInput::ResolvePostRunReflectPolicy { runx, field } => {
            to_json_value(resolve_post_run_reflect_policy(runx.as_ref(), &field)?)
        }
        ParserInput::ValidateSkillInstall { markdown, origin } => {
            to_json_value(validate_skill_install(&markdown, origin)?)
        }
    }
}

fn to_json_value<T: Serialize>(value: T) -> Result<JsonValue, ParserEvalError> {
    let serialized = serde_json::to_value(value)
        .map_err(|error| ParserEvalError::SerializeOutput(error.to_string()))?;
    serde_json::from_value(serialized)
        .map_err(|error| ParserEvalError::SerializeOutput(error.to_string()))
}

fn default_artifact_field() -> String {
    "runx.artifacts".to_owned()
}

fn default_runx_field() -> String {
    "runx".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_skill_markdown_validation() -> Result<(), String> {
        let output = evaluate_parser_document_str(
            r#"{
              "kind": "parser.validateSkillMarkdown",
              "markdown": "---\nname: parser-demo\n---\n# Parser Demo\n",
              "mode": "strict"
            }"#,
        )
        .map_err(|error| error.to_string())?;
        let ParserEvalOutput::Output { value } = output;
        let JsonValue::Object(skill) = value else {
            return Err("expected validated skill object".into());
        };
        assert_eq!(
            skill.get("name"),
            Some(&JsonValue::String("parser-demo".to_owned()))
        );
        Ok(())
    }

    #[test]
    fn rejects_unsupported_parser_kind_before_deserializing() -> Result<(), String> {
        let error = match evaluate_parser_document_str(r#"{"kind":"parser.unknown"}"#) {
            Ok(_) => return Err("unsupported parser kind must fail closed".into()),
            Err(error) => error,
        };
        assert_eq!(error.code(), "invalid_input");
        assert!(error.to_string().contains("unsupported parser input kind"));
        Ok(())
    }
}
