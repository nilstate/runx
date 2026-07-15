use std::io::Write;

use runx_contracts::JsonValue;
use runx_runtime::skill_front::{
    PreparedSkillRunReport, SkillOperatorContextContextSkill, SkillOperatorContextDocument,
    SkillOperatorContextNode, SkillOperatorContextStep, SkillOperatorContextTarget,
    SkillOperatorContextTerminal, SkillOperatorContextTool,
};

// rust-style-allow: long-function - compact and full modes share one ordered
// operator-facing rendering contract so decision fields cannot drift.
pub(super) fn write_operator_context(
    report: &PreparedSkillRunReport,
    full: bool,
) -> Result<(), String> {
    let mut out = String::new();
    out.push_str("Prepared run\n");
    out.push_str(&format!(
        "  Skill:  {}\n  Runner: {}\n  Source: {}\n",
        report.request.skill_path.display(),
        report.request.runner,
        source_label(report),
    ));
    if let Some(run_id) = &report.request.run_id {
        out.push_str(&format!("  Run:    {run_id}\n"));
    }
    if let Some(receipt_dir) = &report.request.receipt_dir {
        out.push_str(&format!("  Receipts: {}\n", receipt_dir.display()));
    }
    let total_steps = report.governance.declared_steps + report.governance.conditional_steps;
    out.push_str(&format!(
        "  Steps:  {total_steps} total, {} mutating, {} conditional\n  Tools:  {}\n",
        report.governance.mutating_steps.len(),
        report.governance.conditional_steps,
        list_or_none(&report.governance.tool_refs),
    ));
    out.push_str("  Inputs: ");
    if report.request.inputs.is_empty() {
        out.push_str("none\n");
    } else {
        out.push_str(
            &report
                .request
                .inputs
                .iter()
                .map(|input| format!("{} ({})", input.name, input.value_type))
                .collect::<Vec<_>>()
                .join(", "),
        );
        out.push('\n');
    }
    if let Some(credential) = &report.request.credential {
        out.push_str(&format!(
            "  Credential: {}/{}; scopes: {}\n",
            credential.provider,
            credential.auth_mode,
            list_or_none(&credential.scopes),
        ));
    } else {
        out.push_str("  Credential: none\n");
    }
    out.push_str(&format!("  Digest: {}\n", report.digest));
    if let Some(reason) = &report.blocked_reason {
        out.push_str(&format!("\nPreparation blocked: {reason}\n"));
        append_resolution_trace(&mut out, report);
    }
    if !full {
        out.push_str("  Full context: add --full-operator-context\n");
        let _ignored = writeln!(std::io::stderr(), "{out}");
        return Ok(());
    }
    let Some(chain) = report.chain.as_ref() else {
        let _ignored = writeln!(std::io::stderr(), "{out}");
        return Ok(());
    };
    out.push_str("\nFull operator context\n");
    out.push_str(&format!("cwd: {}\n", report.request.cwd.display()));
    out.push_str(&format!("entry_kind: {}\n", report.request.entry.kind));
    if let Some(answers_path) = &report.request.answers_path {
        out.push_str(&format!("answers_path: {}\n", answers_path.display()));
    }
    out.push_str("request_bindings:\n");
    for input in &report.request.inputs {
        out.push_str(&format!(
            "  - {}: type={}, bytes={}, sha256={}\n",
            input.name, input.value_type, input.canonical_bytes, input.sha256
        ));
    }
    if let Some(credential) = &report.request.credential {
        out.push_str(&format!(
            "credential_binding: env_var={}, material_ref_sha256={}\n",
            credential.env_var, credential.material_ref_sha256,
        ));
    }
    append_resolution_trace(&mut out, report);
    out.push_str(&format!(
        "skill_path: {}\n",
        chain.entry.package.directory.display()
    ));
    out.push_str(&format!(
        "chain_nodes: {} / {}\nchain_content_bytes: {} / {}\nchain_max_depth: {}\n",
        chain.node_count,
        chain.max_nodes,
        chain.content_bytes,
        chain.max_content_bytes,
        chain.max_depth,
    ));
    append_node(&mut out, &chain.entry, true)?;
    let _ignored = writeln!(std::io::stderr(), "{out}");
    Ok(())
}

fn source_label(report: &PreparedSkillRunReport) -> String {
    let entry = &report.request.entry;
    match (&entry.skill_id, &entry.version, &entry.trust_tier) {
        (Some(skill), Some(version), Some(trust)) => {
            format!("{skill}@{version} ({trust})")
        }
        (Some(skill), Some(version), None) => format!("{skill}@{version}"),
        _ => format!("{} ({})", entry.source_label, entry.kind),
    }
}

fn append_resolution_trace(out: &mut String, report: &PreparedSkillRunReport) {
    out.push_str("resolution_trace:\n");
    for entry in &report.trace {
        out.push_str(&format!(
            "  - {} {} {}: {}\n",
            entry.node_path, entry.stage, entry.outcome, entry.detail
        ));
    }
}

fn list_or_none(values: &[String]) -> String {
    if values.is_empty() {
        "none".to_owned()
    } else {
        values.join(", ")
    }
}

// rust-style-allow: long-function - a recursive skill node is rendered as one
// ordered packet so child contracts, tools, context, and steps stay adjacent.
fn append_node(
    out: &mut String,
    node: &SkillOperatorContextNode,
    entry: bool,
) -> Result<(), String> {
    out.push_str(&format!("\n--- skill node: {} ---\n", node.node_path));
    out.push_str(&format!(
        "package_dir: {}\npackage_source: {}\npackage_source_label: {}\n",
        node.package.directory.display(),
        node.package.source,
        node.package.source_label,
    ));
    if let Some(reference) = &node.package.reference {
        out.push_str(&format!("package_ref: {reference}\n"));
    }
    if let Some(registry) = &node.package.registry {
        out.push_str(&format!(
            "registry_ref: {}\nregistry_skill_id: {}\nregistry_version: {}\nregistry_digest: {}\nregistry_package_digest: {}\nregistry_trust_tier: {}\n",
            registry.reference,
            registry.skill_id,
            registry.version,
            registry.digest,
            registry.package_digest.as_deref().unwrap_or("none"),
            registry.trust_tier,
        ));
    }
    out.push_str(&format!(
        "runner_name: {}\nrunner_type: {}\nrunner_selection: {}\nterminal: {}\n",
        node.runner.name,
        node.runner.source_type,
        node.runner.selection,
        terminal_label(&node.terminal),
    ));
    if let Some(requested) = &node.runner.requested_name {
        out.push_str(&format!("runner_requested_name: {requested}\n"));
    }
    append_document(
        out,
        if entry {
            "root skill".to_owned()
        } else {
            format!("skill contract: {}", node.node_path)
        },
        &node.skill_markdown,
        "markdown",
    );
    let runner_label = if entry {
        format!("selected runner: {}", node.runner.name)
    } else {
        format!(
            "selected runner: {} at {}",
            node.runner.name, node.node_path
        )
    };
    append_json_block(out, &runner_label, &node.runner.raw)?;
    append_tools(out, &node.node_path, &node.tools);
    for step in &node.steps {
        append_step(out, step)?;
    }
    Ok(())
}

fn append_step(out: &mut String, step: &SkillOperatorContextStep) -> Result<(), String> {
    out.push_str(&format!("\n--- graph step: {} ---\n", step.node_path));
    out.push_str(&format!(
        "step_id: {}\ntarget: {}\nmutation: {}\n",
        step.id,
        target_label(&step.target),
        step.mutating,
    ));
    append_string_list(out, "allowed_tools", &step.allowed_tools);
    append_string_list(out, "tool_refs", &step.tool_refs);
    append_json_block(
        out,
        &format!("graph step raw: {}", step.node_path),
        &step.raw,
    )?;
    for context in &step.context_skills {
        append_context_skill(out, &step.node_path, context);
    }
    if let Some(child) = &step.child {
        append_node(out, child, false)?;
    }
    Ok(())
}

fn append_context_skill(
    out: &mut String,
    step_path: &str,
    context: &SkillOperatorContextContextSkill,
) {
    out.push_str(&format!(
        "\ncontext_attachment: {step_path}\ncontext_ref: {}\ncontext_source: {}\ncontext_name: {}\n",
        context.reference, context.source, context.name,
    ));
    append_document(
        out,
        format!("context skill: {} at {step_path}", context.reference),
        &context.document,
        "markdown",
    );
}

fn append_tools(out: &mut String, node_path: &str, tools: &[SkillOperatorContextTool]) {
    out.push_str(&format!("\n--- tool manifests: {node_path} ---\n"));
    if tools.is_empty() {
        out.push_str("none declared by selected runner or graph steps\n");
        return;
    }
    for tool in tools {
        match (&tool.path, &tool.sha256, &tool.content) {
            (Some(path), Some(sha256), Some(content)) => {
                out.push_str(&format!(
                    "\n--- tool manifest: {} at {node_path} ---\npath: {}\nsha256: {sha256}\nsource: {}\n\n```json\n{content}\n```\n",
                    tool.name,
                    path.display(),
                    tool.source,
                ));
            }
            _ => out.push_str(&format!("tool: {}\nsource: {}\n", tool.name, tool.source)),
        }
    }
}

fn append_document(
    out: &mut String,
    label: String,
    document: &SkillOperatorContextDocument,
    language: &str,
) {
    out.push_str(&format!("\n--- {label} ---\n"));
    match &document.path {
        Some(path) => out.push_str(&format!("path: {}\n", path.display())),
        None => out.push_str(&format!("source: {}\n", document.source_label)),
    }
    out.push_str(&format!(
        "sha256: {}\n\n```{language}\n{}\n```\n",
        document.sha256, document.content
    ));
}

fn append_json_block(out: &mut String, label: &str, value: &JsonValue) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(value)
        .map_err(|error| format!("could not render {label} as JSON: {error}"))?;
    out.push_str(&format!("\n--- {label} ---\n\n```json\n{contents}\n```\n"));
    Ok(())
}

fn append_string_list(out: &mut String, label: &str, values: &[String]) {
    if values.is_empty() {
        out.push_str(&format!("{label}: none\n"));
    } else {
        out.push_str(&format!("{label}: {}\n", values.join(", ")));
    }
}

fn target_label(target: &SkillOperatorContextTarget) -> String {
    match target {
        SkillOperatorContextTarget::Skill { reference, runner } => match runner {
            Some(runner) => format!("skill {reference} runner {runner}"),
            None => format!("skill {reference}"),
        },
        SkillOperatorContextTarget::Tool { name } => format!("tool {name}"),
        SkillOperatorContextTarget::Run { source_type } => format!("run {source_type}"),
    }
}

fn terminal_label(terminal: &SkillOperatorContextTerminal) -> &'static str {
    match terminal {
        SkillOperatorContextTerminal::ExpandedGraph => "expanded-graph",
        SkillOperatorContextTerminal::Runner => "terminal-runner",
        SkillOperatorContextTerminal::LegacyMarkdown => "legacy-markdown",
    }
}
