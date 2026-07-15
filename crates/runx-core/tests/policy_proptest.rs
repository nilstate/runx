use proptest::prelude::*;
use runx_core::policy::authority_algebra::{items_subset, optional_bound_subset};
use runx_core::policy::{
    GraphScopeAdmissionDecision, GraphScopeAdmissionRequest, GraphScopeGrant,
    admit_graph_step_scopes,
};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn graph_scope_deduplication_is_idempotent(
        request in graph_scope_request(),
    ) {
        let first = admit_graph_step_scopes(&request);
        let normalized = request_from_decision(&first);
        let second = admit_graph_step_scopes(&normalized);

        prop_assert_eq!(first, second);
    }

    #[test]
    fn authority_item_subset_is_reflexive(
        values in prop::collection::vec(any::<u8>(), 0..24),
    ) {
        prop_assert!(items_subset(&values, &values));
    }

    #[test]
    fn authority_item_subset_is_transitive(
        parent in prop::collection::vec(any::<u8>(), 0..24),
        middle in prop::collection::vec(any::<u8>(), 0..24),
        child in prop::collection::vec(any::<u8>(), 0..24),
    ) {
        let middle_subset_parent = items_subset(&middle, &parent);
        let child_subset_middle = items_subset(&child, &middle);

        prop_assert!(
            !middle_subset_parent || !child_subset_middle || items_subset(&child, &parent)
        );
    }

    #[test]
    fn authority_item_subset_denies_widening(
        parent in prop::collection::vec(any::<u8>(), 0..24),
        missing in any::<u8>(),
    ) {
        prop_assume!(!parent.contains(&missing));

        let mut child = parent.clone();
        child.push(missing);

        prop_assert!(!items_subset(&child, &parent));
    }

    #[test]
    fn authority_optional_bounds_are_reflexive(
        value in any::<u64>(),
    ) {
        prop_assert!(optional_bound_subset(Some(value), Some(value)));
        prop_assert!(optional_bound_subset::<u64>(None, None));
    }

    #[test]
    fn authority_optional_bounds_allow_stricter_child_bounds(
        parent in any::<u64>(),
    ) {
        let child = parent / 2;

        prop_assert!(optional_bound_subset(Some(child), Some(parent)));
    }

    #[test]
    fn authority_optional_bounds_deny_missing_child_bound(
        parent in any::<u64>(),
    ) {
        prop_assert!(!optional_bound_subset::<u64>(None, Some(parent)));
    }

    #[test]
    fn authority_optional_bounds_allow_parent_unbounded(
        child in any::<u64>(),
    ) {
        prop_assert!(optional_bound_subset(Some(child), None));
    }

    #[test]
    fn authority_optional_bounds_deny_widening(
        (child, parent) in (1_u64..100_000).prop_flat_map(|child| (Just(child), 0_u64..child)),
    ) {
        prop_assert!(!optional_bound_subset(Some(child), Some(parent)));
    }
}

fn request_from_decision(decision: &GraphScopeAdmissionDecision) -> GraphScopeAdmissionRequest {
    match decision {
        GraphScopeAdmissionDecision::Allow {
            step_id,
            requested_scopes,
            granted_scopes,
            grant_id,
            ..
        }
        | GraphScopeAdmissionDecision::Deny {
            step_id,
            requested_scopes,
            granted_scopes,
            grant_id,
            ..
        } => GraphScopeAdmissionRequest {
            step_id: step_id.clone(),
            requested_scopes: requested_scopes.clone(),
            grant: GraphScopeGrant {
                grant_id: grant_id.clone(),
                scopes: granted_scopes.clone(),
            },
        },
    }
}

fn graph_scope_request() -> impl Strategy<Value = GraphScopeAdmissionRequest> {
    (
        safe_id(),
        prop::collection::vec(scope(), 0..6),
        prop::collection::vec(scope(), 0..6),
        prop::option::of(safe_id()),
    )
        .prop_map(|(step_id, requested_scopes, granted_scopes, grant_id)| {
            GraphScopeAdmissionRequest {
                step_id,
                requested_scopes,
                grant: GraphScopeGrant {
                    grant_id,
                    scopes: granted_scopes,
                },
            }
        })
}

fn scope() -> impl Strategy<Value = String> {
    prop::sample::select(&[
        "*",
        "repo:read",
        "repo:write",
        "repo:*",
        "repository:read",
        "repos:list",
        "checks:read",
        "checks:*",
        "checks2:read",
        "deploy:prod",
    ])
    .prop_map(str::to_owned)
}

fn safe_id() -> impl Strategy<Value = String> {
    prop::sample::select(&["read", "write", "deploy", "checks", "graph", "step"])
        .prop_map(str::to_owned)
}
