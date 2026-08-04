use serde_json::{Value, json};

use super::{
    SkillArchitectureDecision, SkillArchitecturePlan, SkillChangeBundle, SkillChangeDraft,
};
use crate::schema::RunxSchema;

#[test]
fn skill_authoring_contract_rejects_unknown_nested_fields() {
    let mut value = architecture_fixture();
    value["knowledge_contract"]["unowned"] = json!(true);
    assert!(serde_json::from_value::<SkillArchitectureDecision>(value).is_err());
}

#[test]
fn skill_authoring_contract_binds_closed_bundle_and_plan() {
    let value = json!({
        "schema": "runx.skill.change_bundle.v1",
        "decision": "write",
        "base_digest": digest('a'),
        "plan_digest": digest('b'),
        "architecture": architecture_fixture(),
        "summary": "Create the bounded package.",
        "non_goals": ["Do not add a provider adapter."],
        "writes": [
            { "path": "SKILL.md", "contents": "---\nname: demo\n---\n" },
            { "path": "X.yaml", "contents": "skill: demo\n" }
        ],
        "deletes": [],
        "expected_outputs": [
            { "name": "decision", "value_type": "object", "packet": "demo.decision.v1" }
        ]
    });
    assert!(serde_json::from_value::<SkillChangeBundle>(value.clone()).is_ok());

    let mut unknown = value;
    unknown["writes"][0]["mode"] = json!("executable");
    assert!(serde_json::from_value::<SkillChangeBundle>(unknown).is_err());
}

#[test]
fn skill_authoring_generated_objects_are_recursively_closed() {
    assert_closed_objects(&SkillArchitectureDecision::json_schema());
    assert_closed_objects(&SkillArchitecturePlan::json_schema());
    assert_closed_objects(&SkillChangeDraft::json_schema());
    assert_closed_objects(&SkillChangeBundle::json_schema());
}

fn architecture_fixture() -> Value {
    json!({
        "schema": "runx.skill.architecture_decision.v1",
        "disposition": "build",
        "objective": "Create a bounded decision skill.",
        "operator_value": "Turn supplied evidence into one reviewable decision.",
        "knowledge_contract": {
            "purpose": "Guide the operator through the bounded decision.",
            "evidence_required": ["A supplied objective."],
            "decision_logic": ["Preserve the objective exactly."],
            "stop_conditions": ["Stop when evidence is missing."],
            "recovery": ["Resume with the missing evidence."]
        },
        "required_behaviors": [{
            "id": "decide",
            "outcome": "Produce the decision packet.",
            "lane": "agent_task"
        }],
        "native_reuse": {
            "inspected_capabilities": ["runx.skill.inspect"],
            "selected_capabilities": [],
            "missing_capabilities": []
        },
        "effects": [{
            "effect": "none",
            "authority_scopes": [],
            "approval": "none",
            "provider_boundary": false
        }],
        "skill_chain": { "context_skills": [], "routes": [] },
        "resource_budget": {
            "max_files": 4,
            "max_executable_lines": 0,
            "max_fanout": 1,
            "max_process_spawns": 0,
            "network_allowed": false
        },
        "preservation_obligations": ["Keep the manual substantive."],
        "deletions": [],
        "proof_plan": [{
            "name": "bounded-harness",
            "kind": "harness",
            "expected": "The supplied-answer fixture seals."
        }]
    })
}

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn assert_closed_objects(value: &Value) {
    match value {
        Value::Object(object) => {
            if object.get("type") == Some(&Value::String("object".to_owned())) {
                assert_eq!(
                    object.get("additionalProperties"),
                    Some(&Value::Bool(false)),
                    "open object schema: {value}"
                );
            }
            for child in object.values() {
                assert_closed_objects(child);
            }
        }
        Value::Array(values) => values.iter().for_each(assert_closed_objects),
        _ => {}
    }
}
