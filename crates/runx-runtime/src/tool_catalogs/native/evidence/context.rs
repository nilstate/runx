use std::collections::{BTreeMap, BTreeSet};

use runx_contracts::JsonValue;

use super::{Finding, is_sha256, object, strings, text};

pub(super) fn verify(
    requirements: &[JsonValue],
    bindings: &[JsonValue],
    require_all: bool,
    findings: &mut Vec<Finding>,
) {
    let required = requirements
        .iter()
        .filter_map(|raw| {
            let requirement = object(Some(raw));
            let digest = text(requirement.get("packet_digest"));
            is_sha256(&digest).then_some((digest, requirement))
        })
        .collect::<BTreeMap<_, _>>();
    let mut seen = BTreeSet::new();

    for (index, raw) in bindings.iter().enumerate() {
        let binding = object(Some(raw));
        let packet_digest = text(binding.get("packet_digest"));
        let Some(requirement) = required.get(&packet_digest) else {
            findings.push(Finding::new(
                "artifact.context.unknown",
                "context binding cites an unadmitted packet digest",
                Some(format!("context_bindings[{index}].packet_digest")),
            ));
            continue;
        };
        let allowed_rules = strings(requirement.get("rules"))
            .into_iter()
            .collect::<BTreeSet<_>>();
        let applied_rules = strings(binding.get("applied_rules"));
        if applied_rules.is_empty()
            || applied_rules
                .iter()
                .any(|rule| !allowed_rules.contains(rule))
        {
            findings.push(Finding::new(
                "artifact.context.unbound",
                "applied context rules must come from the admitted packet",
                Some(format!("context_bindings[{index}].applied_rules")),
            ));
        }
        seen.insert(packet_digest);
    }

    if require_all {
        for packet_digest in required.keys() {
            if !seen.contains(packet_digest) {
                findings.push(Finding::new(
                    "artifact.context.missing",
                    "an admitted context packet was not bound",
                    Some("context_bindings".to_owned()),
                ));
            }
        }
    }
}
