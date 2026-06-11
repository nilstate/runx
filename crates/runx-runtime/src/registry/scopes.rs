use runx_contracts::{JsonObject, JsonValue};
use runx_parser::{SkillRunnerManifest, ValidatedSkill};

pub(crate) fn required_scopes_from_skill(skill: &ValidatedSkill) -> Vec<String> {
    unique_strings(
        string_array_field(skill.auth.as_ref(), "scopes")
            .into_iter()
            .chain(string_array_field_from_object(
                skill.runx.as_ref(),
                "scopes",
            )),
    )
}

pub(super) fn required_scopes_from_skill_and_runner(
    skill: &ValidatedSkill,
    manifest: Option<&SkillRunnerManifest>,
) -> Vec<String> {
    unique_strings(
        required_scopes_from_skill(skill)
            .into_iter()
            .chain(required_scopes_from_runner_manifest(manifest)),
    )
}

fn required_scopes_from_runner_manifest(manifest: Option<&SkillRunnerManifest>) -> Vec<String> {
    unique_strings(
        manifest
            .into_iter()
            .flat_map(|manifest| manifest.runners.values())
            .flat_map(|runner| {
                string_array_field(runner.auth.as_ref(), "scopes")
                    .into_iter()
                    .chain(string_array_field_from_object(
                        runner.runx.as_ref(),
                        "scopes",
                    ))
            }),
    )
}

fn string_array_field(value: Option<&JsonValue>, field: &str) -> Vec<String> {
    let Some(JsonValue::Object(record)) = value else {
        return Vec::new();
    };
    string_array_field_from_object(Some(record), field)
}

fn string_array_field_from_object(value: Option<&JsonObject>, field: &str) -> Vec<String> {
    let Some(record) = value else {
        return Vec::new();
    };
    let Some(JsonValue::Array(values)) = record.get(field) else {
        return Vec::new();
    };
    values
        .iter()
        .filter_map(JsonValue::as_str)
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_owned)
        .collect()
}

fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut unique_values = Vec::new();
    for value in values {
        if !unique_values.contains(&value) {
            unique_values.push(value);
        }
    }
    unique_values
}
