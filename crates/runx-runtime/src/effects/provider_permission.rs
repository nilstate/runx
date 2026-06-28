// rust-style-allow: large-file -- provider permission admission keeps effect
// parsing, operator-grant validation, witness projection, and tests together so
// self-attested scope grants remain audited in one place.
use std::collections::{BTreeMap, BTreeSet};

use runx_contracts::{AuthorityVerb, JsonObject, JsonValue, Reference, ReferenceType};
use runx_core::state_machine::AuthorityAdmissionWitness;

use super::{EffectAdmission, EffectStepRequest, RuntimeEffect, RuntimeEffectError};

pub const PROVIDER_PERMISSION_EFFECT_FAMILY: &str = "provider_permission";
pub const PROVIDER_PERMISSION_GRANT_ID_ENV: &str = "RUNX_PROVIDER_PERMISSION_GRANT_ID";
pub const PROVIDER_PERMISSION_GRANTED_SCOPES_ENV: &str = "RUNX_PROVIDER_PERMISSION_GRANTED_SCOPES";

#[derive(Clone, Debug, Default)]
pub struct ProviderPermissionEffect;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderPermissionAdmission {
    pub grant_id: String,
    pub required_scopes: Vec<String>,
    pub granted_scopes: Vec<String>,
}

impl RuntimeEffect for ProviderPermissionEffect {
    fn family(&self) -> &'static str {
        PROVIDER_PERMISSION_EFFECT_FAMILY
    }

    fn admit(
        &self,
        request: EffectStepRequest<'_>,
    ) -> Result<Option<EffectAdmission>, RuntimeEffectError> {
        let Some(policy) = provider_permission_policy(request.step.policy.as_ref()) else {
            return Ok(None);
        };
        let Some(plan) = provider_permission_plan(&request, policy)? else {
            return Ok(None);
        };
        if !plan.missing_scopes.is_empty() {
            return Err(provider_permission_denial(&request, &plan));
        }

        let witness = provider_permission_witness(&request, &plan);
        Ok(Some(EffectAdmission::new(
            PROVIDER_PERMISSION_EFFECT_FAMILY,
            plan.verb.clone(),
            witness,
            ProviderPermissionAdmission {
                grant_id: plan.grant_id,
                required_scopes: plan.required_scopes,
                granted_scopes: plan.granted_scopes,
            },
        )))
    }

    fn authority_grant_refs(
        &self,
        admission: &EffectAdmission,
    ) -> Result<Vec<Reference>, RuntimeEffectError> {
        let context = admission
            .context::<ProviderPermissionAdmission>()
            .ok_or_else(|| RuntimeEffectError::Failed {
                family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
                operation: "authority grant evidence",
                message: "provider permission admission context is missing".to_owned(),
            })?;
        Ok(vec![Reference::runx(
            ReferenceType::Grant,
            &context.grant_id,
        )])
    }
}

#[derive(Debug)]
struct ProviderPermissionPlan {
    grant_id: String,
    required_scopes: Vec<String>,
    granted_scopes: Vec<String>,
    missing_scopes: Vec<String>,
    verb: AuthorityVerb,
}

fn provider_permission_plan(
    request: &EffectStepRequest<'_>,
    policy: &JsonObject,
) -> Result<Option<ProviderPermissionPlan>, RuntimeEffectError> {
    let verb = required_verb_field(policy)?;
    if policy.contains_key("granted_scopes") {
        return Err(RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb,
            message: "provider_permission.granted_scopes is self-attested by the graph policy; provide granted scopes through the operator grant environment instead".to_owned(),
        });
    }
    let required_scopes = string_array_field(policy, "required_scopes")?
        .unwrap_or_else(|| request.step.scopes.clone());
    if required_scopes.is_empty() {
        return Ok(None);
    }
    let granted_scopes = granted_scopes_from_env(request.env);
    let missing_scopes = missing_scopes(&required_scopes, &granted_scopes);
    let expected_grant_id = string_field(policy, "grant_id");
    let grant_id = provider_grant_id(request.env, &verb)?;
    if let Some(expected) = expected_grant_id
        && expected != grant_id
    {
        return Err(RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb,
            message: format!(
                "step '{}' requires provider grant '{}', but operator grant '{}' was supplied",
                request.step.id, expected, grant_id
            ),
        });
    }

    Ok(Some(ProviderPermissionPlan {
        grant_id,
        required_scopes,
        granted_scopes,
        missing_scopes,
        verb,
    }))
}

fn provider_permission_denial(
    request: &EffectStepRequest<'_>,
    plan: &ProviderPermissionPlan,
) -> RuntimeEffectError {
    RuntimeEffectError::Denied {
        family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
        verb: plan.verb.clone(),
        message: format!(
            "step '{}' requires scopes [{}], but grant '{}' only provides [{}]",
            request.step.id,
            plan.required_scopes.join(", "),
            plan.grant_id,
            plan.granted_scopes.join(", ")
        ),
    }
}

fn provider_permission_witness(
    request: &EffectStepRequest<'_>,
    plan: &ProviderPermissionPlan,
) -> AuthorityAdmissionWitness {
    AuthorityAdmissionWitness {
        verb: plan.verb.clone(),
        parent_term_id: format!("provider-permission:{}", plan.grant_id),
        child_term_id: format!(
            "provider-permission:{}:{}",
            request.step.id,
            plan.required_scopes.join("+")
        ),
        idempotency_key: request.step.idempotency_key.clone(),
        capability_ref: None,
    }
}

fn provider_permission_policy(policy: Option<&JsonObject>) -> Option<&JsonObject> {
    policy?
        .get(PROVIDER_PERMISSION_EFFECT_FAMILY)
        .and_then(JsonValue::as_object)
}

fn string_field<'a>(object: &'a JsonObject, key: &str) -> Option<&'a str> {
    object.get(key).and_then(JsonValue::as_str)
}

fn string_array_field(
    object: &JsonObject,
    key: &str,
) -> Result<Option<Vec<String>>, RuntimeEffectError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let Some(values) = value.as_array() else {
        return Err(provider_permission_policy_error(format!(
            "{key} must be an array"
        )));
    };
    values
        .iter()
        .enumerate()
        .map(|(index, value)| match value {
            JsonValue::String(scope) if !scope.trim().is_empty() => Ok(scope.trim().to_owned()),
            JsonValue::String(_) => Err(provider_permission_policy_error(format!(
                "{key}[{index}] must be a non-empty string"
            ))),
            _ => Err(provider_permission_policy_error(format!(
                "{key}[{index}] must be a string"
            ))),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn provider_grant_id(
    env: &BTreeMap<String, String>,
    verb: &AuthorityVerb,
) -> Result<String, RuntimeEffectError> {
    env.get(PROVIDER_PERMISSION_GRANT_ID_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb: verb.clone(),
            message: format!(
                "provider permission requires explicit operator grant id in {PROVIDER_PERMISSION_GRANT_ID_ENV}"
            ),
        })
}

fn granted_scopes_from_env(env: &BTreeMap<String, String>) -> Vec<String> {
    env.get(PROVIDER_PERMISSION_GRANTED_SCOPES_ENV)
        .map(|value| parse_scope_list(value))
        .unwrap_or_default()
}

fn parse_scope_list(value: &str) -> Vec<String> {
    value
        .split([',', '\n', '\t', ' '])
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_owned)
        .collect()
}

fn required_verb_field(object: &JsonObject) -> Result<AuthorityVerb, RuntimeEffectError> {
    let Some(value) = object.get("verb") else {
        return Err(provider_permission_policy_error(
            "verb is required".to_owned(),
        ));
    };
    let Some(verb) = value.as_str() else {
        return Err(provider_permission_policy_error(
            "verb must be a string".to_owned(),
        ));
    };
    match verb {
        "read" => Ok(AuthorityVerb::Read),
        "write" => Ok(AuthorityVerb::Write),
        "comment" => Ok(AuthorityVerb::Comment),
        "review" => Ok(AuthorityVerb::Review),
        "merge" => Ok(AuthorityVerb::Merge),
        "create" => Ok(AuthorityVerb::Create),
        "update" => Ok(AuthorityVerb::Update),
        "delete" => Ok(AuthorityVerb::Delete),
        "execute" => Ok(AuthorityVerb::Execute),
        "revoke" => Ok(AuthorityVerb::Revoke),
        _ => Err(provider_permission_policy_error(format!(
            "verb {verb:?} is not supported"
        ))),
    }
}

fn provider_permission_policy_error(message: String) -> RuntimeEffectError {
    RuntimeEffectError::Failed {
        family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
        operation: "parse provider permission policy",
        message,
    }
}

fn missing_scopes(required: &[String], granted: &[String]) -> Vec<String> {
    let granted = granted.iter().collect::<BTreeSet<_>>();
    required
        .iter()
        .filter(|scope| !granted.contains(scope))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io;
    use std::path::Path;

    use runx_contracts::{JsonObject, JsonValue, ReferenceType};
    use runx_parser::GraphStep;

    use super::*;

    #[test]
    fn admits_when_required_scopes_are_granted() -> Result<(), io::Error> {
        let effect = ProviderPermissionEffect;
        let step = test_step("read_issue", vec!["repo.read"], false, "read", false);
        let inputs = JsonObject::new();
        let env = provider_env("github-mcp-read", "repo.read");

        let result = effect.admit(EffectStepRequest {
            step: &step,
            inputs: &inputs,
            env: &env,
            graph_dir: Path::new("."),
        });
        let admission = match result {
            Ok(Some(admission)) => admission,
            other => {
                return Err(io::Error::other(format!(
                    "unexpected provider permission admission: {other:?}"
                )));
            }
        };

        assert_eq!(admission.family(), PROVIDER_PERMISSION_EFFECT_FAMILY);
        assert_eq!(admission.verb(), AuthorityVerb::Read);
        let context = match admission.context::<ProviderPermissionAdmission>() {
            Some(context) => context,
            None => {
                return Err(io::Error::other(
                    "missing provider permission admission context",
                ));
            }
        };
        assert_eq!(context.required_scopes, vec!["repo.read"]);
        assert_eq!(context.granted_scopes, vec!["repo.read"]);
        let grant_refs = effect
            .authority_grant_refs(&admission)
            .map_err(|error| io::Error::other(error.to_string()))?;
        assert_eq!(grant_refs.len(), 1);
        assert_eq!(grant_refs[0].reference_type, ReferenceType::Grant);
        assert_eq!(grant_refs[0].uri, "runx:grant:github-mcp-read");
        Ok(())
    }

    #[test]
    fn admits_revoke_verb_through_grant_ref_path() -> Result<(), io::Error> {
        let effect = ProviderPermissionEffect;
        let step = test_step("revoke_grant", vec!["repo.write"], true, "revoke", false);
        let inputs = JsonObject::new();
        let env = provider_env("github-mcp-read", "repo.write");

        let result = effect.admit(EffectStepRequest {
            step: &step,
            inputs: &inputs,
            env: &env,
            graph_dir: Path::new("."),
        });
        let admission = match result {
            Ok(Some(admission)) => admission,
            other => {
                return Err(io::Error::other(format!(
                    "unexpected provider permission admission: {other:?}"
                )));
            }
        };

        assert_eq!(admission.family(), PROVIDER_PERMISSION_EFFECT_FAMILY);
        assert_eq!(admission.verb(), AuthorityVerb::Revoke);
        let grant_refs = effect
            .authority_grant_refs(&admission)
            .map_err(|error| io::Error::other(error.to_string()))?;
        assert_eq!(grant_refs.len(), 1);
        assert_eq!(grant_refs[0].reference_type, ReferenceType::Grant);
        assert_eq!(grant_refs[0].uri, "runx:grant:github-mcp-read");
        Ok(())
    }

    #[test]
    fn denies_when_required_scope_is_not_granted() -> Result<(), io::Error> {
        let effect = ProviderPermissionEffect;
        let step = test_step("comment_issue", vec!["repo.write"], true, "write", false);
        let inputs = JsonObject::new();
        let env = provider_env("github-mcp-read", "repo.read");

        let result = effect.admit(EffectStepRequest {
            step: &step,
            inputs: &inputs,
            env: &env,
            graph_dir: Path::new("."),
        });
        let error = match result {
            Err(error) => error,
            other => {
                return Err(io::Error::other(format!(
                    "unexpected provider permission result: {other:?}"
                )));
            }
        };

        match error {
            RuntimeEffectError::Denied {
                family,
                verb: AuthorityVerb::Write,
                message,
            } if family == PROVIDER_PERMISSION_EFFECT_FAMILY
                && message.contains("repo.write")
                && message.contains("repo.read") =>
            {
                Ok(())
            }
            other => Err(io::Error::other(format!(
                "unexpected denial error: {other:?}"
            ))),
        }
    }

    #[test]
    fn denies_when_operator_grant_id_is_missing() -> Result<(), io::Error> {
        let effect = ProviderPermissionEffect;
        let step = test_step("read_issue", vec!["repo.read"], false, "read", false);
        let inputs = JsonObject::new();
        let env = scopes_only_env("repo.read");

        let result = effect.admit(EffectStepRequest {
            step: &step,
            inputs: &inputs,
            env: &env,
            graph_dir: Path::new("."),
        });
        let error = match result {
            Err(error) => error,
            other => {
                return Err(io::Error::other(format!(
                    "unexpected provider permission result: {other:?}"
                )));
            }
        };

        match error {
            RuntimeEffectError::Denied { message, .. }
                if message.contains(PROVIDER_PERMISSION_GRANT_ID_ENV) =>
            {
                Ok(())
            }
            other => Err(io::Error::other(format!(
                "unexpected missing-grant denial error: {other:?}"
            ))),
        }
    }

    #[test]
    fn rejects_self_attested_granted_scopes_in_policy() -> Result<(), io::Error> {
        let effect = ProviderPermissionEffect;
        let step = test_step("read_issue", vec!["repo.read"], false, "read", true);
        let inputs = JsonObject::new();
        let env = provider_env("github-mcp-read", "repo.read");

        let result = effect.admit(EffectStepRequest {
            step: &step,
            inputs: &inputs,
            env: &env,
            graph_dir: Path::new("."),
        });
        let error = match result {
            Err(error) => error,
            other => {
                return Err(io::Error::other(format!(
                    "unexpected provider permission result: {other:?}"
                )));
            }
        };

        match error {
            RuntimeEffectError::Denied { message, .. } if message.contains("self-attested") => {
                Ok(())
            }
            other => Err(io::Error::other(format!(
                "unexpected self-attested denial error: {other:?}"
            ))),
        }
    }

    #[test]
    fn rejects_missing_or_unknown_policy_verb() -> Result<(), io::Error> {
        let effect = ProviderPermissionEffect;
        let inputs = JsonObject::new();
        let env = provider_env("github-mcp-read", "repo.read");

        let mut missing_verb = test_step("read_issue", vec!["repo.read"], false, "read", false);
        provider_permission_policy_mut(&mut missing_verb)?.remove("verb");
        let error = match effect.admit(EffectStepRequest {
            step: &missing_verb,
            inputs: &inputs,
            env: &env,
            graph_dir: Path::new("."),
        }) {
            Ok(_) => {
                return Err(io::Error::other(
                    "missing provider permission verb should fail",
                ));
            }
            Err(error) => error,
        };
        assert_policy_error(error, "verb is required")?;

        let unknown_verb = test_step("read_issue", vec!["repo.read"], false, "publish", false);
        let error = match effect.admit(EffectStepRequest {
            step: &unknown_verb,
            inputs: &inputs,
            env: &env,
            graph_dir: Path::new("."),
        }) {
            Ok(_) => {
                return Err(io::Error::other(
                    "unknown provider permission verb should fail",
                ));
            }
            Err(error) => error,
        };
        assert_policy_error(error, "not supported")
    }

    #[test]
    fn rejects_malformed_required_scopes() -> Result<(), io::Error> {
        let effect = ProviderPermissionEffect;
        let mut step = test_step("read_issue", vec!["repo.read"], false, "read", false);
        provider_permission_policy_mut(&mut step)?.insert(
            "required_scopes".to_owned(),
            JsonValue::Array(vec![
                JsonValue::String("repo.read".to_owned()),
                JsonValue::Bool(false),
            ]),
        );
        let inputs = JsonObject::new();
        let env = provider_env("github-mcp-read", "repo.read");

        let error = match effect.admit(EffectStepRequest {
            step: &step,
            inputs: &inputs,
            env: &env,
            graph_dir: Path::new("."),
        }) {
            Ok(_) => {
                return Err(io::Error::other(
                    "malformed provider permission required_scopes should fail",
                ));
            }
            Err(error) => error,
        };

        assert_policy_error(error, "required_scopes[1] must be a string")
    }

    fn test_step(
        id: &str,
        required_scopes: Vec<&str>,
        mutating: bool,
        verb: &str,
        self_attested_granted_scopes: bool,
    ) -> GraphStep {
        let mut permission = JsonObject::new();
        permission.insert(
            "grant_id".to_owned(),
            JsonValue::String("github-mcp-read".to_owned()),
        );
        permission.insert("verb".to_owned(), JsonValue::String(verb.to_owned()));
        if self_attested_granted_scopes {
            permission.insert(
                "granted_scopes".to_owned(),
                JsonValue::Array(vec![JsonValue::String("repo.read".to_owned())]),
            );
        }
        let mut policy = JsonObject::new();
        policy.insert(
            PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            JsonValue::Object(permission),
        );
        GraphStep {
            id: id.to_owned(),
            label: None,
            skill: None,
            tool: None,
            run: None,
            instructions: None,
            artifacts: None,
            runner: None,
            inputs: JsonObject::new(),
            context: BTreeMap::new(),
            context_edges: Vec::new(),
            context_skills: Vec::new(),
            scopes: required_scopes
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>(),
            allowed_tools: None,
            retry: None,
            policy: Some(policy),
            fanout_group: None,
            when: None,
            mutating,
            idempotency_key: Some(format!("{id}-key")),
            mint_authority: None,
            requested_scope_from: None,
        }
    }

    fn provider_env(grant_id: &str, scopes: &str) -> BTreeMap<String, String> {
        [
            (
                PROVIDER_PERMISSION_GRANT_ID_ENV.to_owned(),
                grant_id.to_owned(),
            ),
            (
                PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
                scopes.to_owned(),
            ),
        ]
        .into_iter()
        .collect()
    }

    fn scopes_only_env(scopes: &str) -> BTreeMap<String, String> {
        [(
            PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
            scopes.to_owned(),
        )]
        .into_iter()
        .collect()
    }

    fn provider_permission_policy_mut(step: &mut GraphStep) -> Result<&mut JsonObject, io::Error> {
        let Some(value) = step
            .policy
            .as_mut()
            .and_then(|policy| policy.get_mut(PROVIDER_PERMISSION_EFFECT_FAMILY))
        else {
            return Err(io::Error::other(
                "test step should carry provider permission policy",
            ));
        };
        let JsonValue::Object(object) = value else {
            return Err(io::Error::other(
                "test step provider permission policy should be an object",
            ));
        };
        Ok(object)
    }

    fn assert_policy_error(error: RuntimeEffectError, needle: &str) -> Result<(), io::Error> {
        match error {
            RuntimeEffectError::Failed {
                family,
                operation: "parse provider permission policy",
                message,
            } if family == PROVIDER_PERMISSION_EFFECT_FAMILY && message.contains(needle) => Ok(()),
            other => Err(io::Error::other(format!(
                "unexpected provider permission policy error: {other:?}"
            ))),
        }
    }
}
