use super::{
    GraphScopeAdmissionDecision, GraphScopeAdmissionRequest,
    scope::{ScopeGrantPolicy, scope_grant_allows, unique_strings},
};

#[must_use]
pub fn admit_graph_step_scopes(
    request: &GraphScopeAdmissionRequest,
) -> GraphScopeAdmissionDecision {
    let requested_scopes = unique_strings(&request.requested_scopes);
    let granted_scopes = unique_strings(&request.grant.scopes);
    let denied_scopes = denied_scopes(&requested_scopes, &granted_scopes);

    if denied_scopes.is_empty() {
        return GraphScopeAdmissionDecision::Allow {
            reasons: allow_reasons(&requested_scopes),
            step_id: request.step_id.clone(),
            requested_scopes,
            granted_scopes,
            grant_id: request.grant.grant_id.clone(),
        };
    }

    GraphScopeAdmissionDecision::Deny {
        reasons: vec![format!(
            "step '{}' requested scope(s) outside graph grant: {}",
            request.step_id,
            denied_scopes.join(", ")
        )],
        step_id: request.step_id.clone(),
        requested_scopes,
        granted_scopes,
        grant_id: request.grant.grant_id.clone(),
    }
}

fn denied_scopes(requested_scopes: &[String], granted_scopes: &[String]) -> Vec<String> {
    requested_scopes
        .iter()
        .filter(|scope| {
            !granted_scopes.iter().any(|granted_scope| {
                scope_grant_allows(granted_scope, scope, ScopeGrantPolicy::Trusted)
            })
        })
        .cloned()
        .collect()
}

fn allow_reasons(requested_scopes: &[String]) -> Vec<String> {
    if requested_scopes.is_empty() {
        vec!["graph step requested no scopes".to_owned()]
    } else {
        vec!["graph step scopes allowed".to_owned()]
    }
}
