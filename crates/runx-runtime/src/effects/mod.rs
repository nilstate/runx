mod error;
mod metadata;
mod provider_permission;
mod registry;
mod types;

pub use error::RuntimeEffectError;
pub(crate) use metadata::effect_verification_refs;
pub use metadata::{EFFECT_VERIFICATION_REFS_METADATA, insert_effect_verification_ref};
pub use provider_permission::{
    PROVIDER_PERMISSION_EFFECT_FAMILY, PROVIDER_PERMISSION_GRANT_ID_ENV,
    PROVIDER_PERMISSION_GRANTED_SCOPES_ENV, ProviderPermissionAdmission, ProviderPermissionEffect,
};
pub use registry::RuntimeEffectRegistry;
pub use types::{
    EffectAdmission, EffectMetadataRefreshRequest, EffectOutputRequest, EffectReceiptRequest,
    EffectReplay, EffectReplayOutputRequest, EffectReplayReceiptRequest, EffectStepRequest,
    RuntimeEffect,
};

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::Path;

    use runx_contracts::{AuthorityVerb, JsonObject, Reference};
    use runx_core::state_machine::AuthorityAdmissionWitness;
    use runx_parser::GraphStep;

    use super::*;
    use crate::adapter::{InvocationStatus, SkillOutput};

    struct MockEffect;

    impl RuntimeEffect for MockEffect {
        fn family(&self) -> &'static str {
            "deploy"
        }

        fn admit(
            &self,
            request: EffectStepRequest<'_>,
        ) -> Result<Option<EffectAdmission>, RuntimeEffectError> {
            let _ = request;
            Ok(Some(EffectAdmission::new(
                "deploy",
                AuthorityVerb::Write,
                AuthorityAdmissionWitness {
                    verb: AuthorityVerb::Write,
                    parent_term_id: "parent".to_owned(),
                    child_term_id: "child".to_owned(),
                    idempotency_key: Some("deploy-key".to_owned()),
                    capability_ref: None,
                },
                (),
            )))
        }
    }

    #[test]
    fn registry_dispatches_effect_family() {
        let registry = RuntimeEffectRegistry::with_effect(MockEffect);
        let step = test_step();
        let inputs = JsonObject::new();
        let env = BTreeMap::new();
        let result = registry.admit(EffectStepRequest {
            step: &step,
            inputs: &inputs,
            env: &env,
            graph_dir: Path::new("."),
        });
        assert!(
            matches!(
                &result,
                Ok(Some(admission))
                    if admission.family() == "deploy" && admission.verb() == AuthorityVerb::Write
            ),
            "unexpected admission result: {result:?}"
        );
    }

    #[test]
    fn registry_rejects_missing_effect_family_after_admission() {
        let registry = RuntimeEffectRegistry::empty();
        let step = test_step();
        let admission = EffectAdmission::new(
            "absent",
            AuthorityVerb::Write,
            AuthorityAdmissionWitness {
                verb: AuthorityVerb::Write,
                parent_term_id: "parent".to_owned(),
                child_term_id: "child".to_owned(),
                idempotency_key: None,
                capability_ref: None,
            },
            (),
        );
        let claim = JsonObject::new();
        let mut output = SkillOutput {
            status: InvocationStatus::Success,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 0,
            metadata: JsonObject::new(),
        };

        let result = registry.prepare_output(EffectOutputRequest {
            step: &step,
            admission: &admission,
            claim: &claim,
            output: &mut output,
        });

        assert!(
            matches!(result, Err(RuntimeEffectError::MissingFamily { ref family }) if family == "absent"),
            "unexpected missing-family result: {result:?}"
        );
    }

    #[test]
    fn verification_refs_round_trip_through_metadata() {
        let mut metadata = JsonObject::new();
        let reference = Reference::runx(runx_contracts::ReferenceType::Verification, "proof:1");
        let insert = insert_effect_verification_ref(&mut metadata, reference.clone());
        assert!(insert.is_ok(), "unexpected insert result: {insert:?}");
        assert_eq!(effect_verification_refs(&metadata), Ok(vec![reference]));
    }

    fn test_step() -> GraphStep {
        GraphStep {
            id: "ship".to_owned(),
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
            scopes: Vec::new(),
            allowed_tools: None,
            retry: None,
            policy: None,
            fanout_group: None,
            when: None,
            mutating: false,
            idempotency_key: None,
        }
    }
}
