use runx_contracts::JsonValue;
use runx_parser::SkillArtifactContract;

use crate::adapter::InvocationOutput;
use crate::output_contract::project_artifact_outputs;

pub(super) fn apply(output: &mut InvocationOutput, artifacts: Option<&SkillArtifactContract>) {
    let projected = project_artifact_outputs(&output.value, artifacts);
    let JsonValue::Object(object) = &mut output.value else {
        return;
    };
    object.extend(projected);
}
