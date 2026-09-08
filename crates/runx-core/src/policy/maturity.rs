use runx_contracts::maturity::{MaturitySignals, MaturityTier};

/// Compute a skill's maturity tier from its harness signals.
///
/// Pure and deterministic; callers extract [`MaturitySignals`] at an event
/// point (publish, harness seal, graph republish) and store the result.
///
/// - `Alpha` is the floor: no declared cases, or any declared case not passing.
/// - `Beta`: every declared case passes.
/// - `Stable`: every declared case passes and at least one passing case proves
///   the skill runs inside a graph.
#[must_use]
pub fn compute_maturity(signals: &MaturitySignals) -> MaturityTier {
    if signals.declared_case_count == 0 || !signals.all_declared_cases_passed {
        return MaturityTier::Alpha;
    }
    if signals.has_passing_graph_case {
        MaturityTier::Stable
    } else {
        MaturityTier::Beta
    }
}

#[cfg(test)]
mod tests {
    use super::compute_maturity;
    use runx_contracts::maturity::{MaturitySignals, MaturityTier};

    #[test]
    fn no_declared_cases_is_alpha() {
        let tier = compute_maturity(&MaturitySignals {
            declared_case_count: 0,
            all_declared_cases_passed: true,
            has_passing_graph_case: true,
        });
        assert_eq!(tier, MaturityTier::Alpha);
    }

    #[test]
    fn any_failing_case_is_alpha() {
        let tier = compute_maturity(&MaturitySignals {
            declared_case_count: 3,
            all_declared_cases_passed: false,
            has_passing_graph_case: true,
        });
        assert_eq!(tier, MaturityTier::Alpha);
    }

    #[test]
    fn all_passing_without_graph_case_is_beta() {
        let tier = compute_maturity(&MaturitySignals {
            declared_case_count: 3,
            all_declared_cases_passed: true,
            has_passing_graph_case: false,
        });
        assert_eq!(tier, MaturityTier::Beta);
    }

    #[test]
    fn all_passing_with_graph_case_is_stable() {
        let tier = compute_maturity(&MaturitySignals {
            declared_case_count: 3,
            all_declared_cases_passed: true,
            has_passing_graph_case: true,
        });
        assert_eq!(tier, MaturityTier::Stable);
    }
}
