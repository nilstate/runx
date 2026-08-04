//! Serde conventions for the Rust parity kernel.
//!
//! Public structs serialize with camelCase field names to match TypeScript
//! fixtures. Tagged unions use the same discriminator field as TypeScript,
//! usually `type` for state-machine events and plans. Optional fields are
//! omitted when absent. Serialized maps use deterministic key order.

#[cfg(test)]
mod tests {
    use crate::state_machine::{
        FanoutBranchPlan, FanoutSyncDecision, FanoutSyncStrategy, SequentialGraphPlan,
    };

    #[test]
    fn state_machine_plan_uses_type_tag_and_camel_case_fields() -> Result<(), serde_json::Error> {
        let plan = SequentialGraphPlan::RunFanout {
            group_id: "advisors".to_owned(),
            branches: vec![
                FanoutBranchPlan {
                    step_id: "market".to_owned(),
                    attempt: 1,
                    context_from: Vec::new(),
                },
                FanoutBranchPlan {
                    step_id: "risk".to_owned(),
                    attempt: 1,
                    context_from: Vec::new(),
                },
            ],
        };

        let json = serde_json::to_string(&plan)?;

        assert_eq!(
            json,
            r#"{"type":"run_fanout","groupId":"advisors","branches":[{"stepId":"market","attempt":1,"contextFrom":[]},{"stepId":"risk","attempt":1,"contextFrom":[]}]}"#,
        );
        Ok(())
    }

    #[test]
    fn optional_fields_are_omitted_when_absent() -> Result<(), serde_json::Error> {
        let decision = FanoutSyncDecision {
            group_id: "advisors".to_owned(),
            decision: crate::state_machine::FanoutSyncOutcome::Proceed,
            strategy: FanoutSyncStrategy::All,
            rule_fired: "all.min_success".to_owned(),
            reason: "2/2 branches succeeded; required 2".to_owned(),
            branch_count: 2,
            success_count: 2,
            failure_count: 0,
            required_successes: 2,
            gate: None,
        };

        let value = serde_json::to_value(decision)?;

        assert!(value.get("gate").is_none());
        Ok(())
    }
}
