use runx_contracts::JsonValue;
use runx_parser::SkillArtifactContract;

use crate::adapter::InvocationOutput;
use crate::output_contract::project_artifact_outputs;

pub(super) fn apply(output: &mut InvocationOutput, artifacts: Option<&SkillArtifactContract>) {
    apply_value(&mut output.value, artifacts);
}

pub(super) fn apply_value(value: &mut JsonValue, artifacts: Option<&SkillArtifactContract>) {
    let projected = project_artifact_outputs(value, artifacts);
    let JsonValue::Object(object) = value else {
        return;
    };
    object.extend(projected);
}
