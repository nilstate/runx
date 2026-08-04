use std::path::Path;

use runx_runtime::export::{RunxExportMode, RunxExportRunner, RunxExportSkill};

use super::{GeneratedFile, Target, display_path};

pub(super) fn plan_files(
    target: Target,
    project: bool,
    root: &Path,
    skills: &[RunxExportSkill],
    skill_dir: &Path,
    runx_bin: &Path,
) -> Vec<GeneratedFile> {
    skills
        .iter()
        .map(|skill| {
            let command_target = if project {
                skill
                    .abs_dir
                    .strip_prefix(root)
                    .map(display_path)
                    .unwrap_or_else(|_| display_path(&skill.abs_dir))
            } else {
                display_path(&skill.abs_dir)
            };
            let contents = render_shim(target, skill, &command_target, runx_bin);
            GeneratedFile {
                path: skill_dir.join(&skill.name).join("SKILL.md"),
                contents,
            }
        })
        .collect()
}

fn render_shim(
    target: Target,
    skill: &RunxExportSkill,
    command_target: &str,
    runx_bin: &Path,
) -> String {
    if skill.mode == RunxExportMode::NativeInstructions {
        return render_native_instructions(target, skill, runx_bin);
    }
    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&format!("name: {}\n", yaml_plain_or_quoted(&skill.name)));
    output.push_str("description: |-\n");
    output.push_str(&indent_block(&skill.description));
    if target == Target::Claude {
        output.push_str(&format!(
            "allowed-tools: Bash({} skill *)\n",
            shell_quote(&display_path(runx_bin))
        ));
    }
    output.push_str("---\n");
    output.push_str(&format!("# {} - governed by runx\n\n", skill.name));
    output.push_str(
        "Run the declared runner through runx; do not bypass it by independently reproducing work that runner owns.\n",
    );
    output.push_str(
        "Runx governs this runner's execution, policy, approvals, and signed receipt. A planning runner seals a plan, not the downstream external action; only report delivery or mutation when a provider-specific governed runner returns provider evidence.\n\n",
    );
    output.push_str(
        "Runx uses its local-development receipt identity when no explicit signer is configured. \
If any `RUNX_RECEIPT_SIGN_*` variable is present, the complete signer tuple must be present or \
runx fails closed. Never invent, copy, or print signing keys.\n\n",
    );
    output.push_str(&render_source_manual(skill));
    for runner in &skill.runners {
        output.push_str(&render_runner(
            command_target,
            runner,
            &display_path(runx_bin),
        ));
    }
    output.push('\n');
    output.push_str(&render_continuation(&display_path(runx_bin)));
    output.push_str(&format!(
        "<!-- {} source={} package-digest={} - generated, do not edit -->\n",
        target.marker(),
        display_path(&skill.abs_dir),
        skill.package_digest,
    ));
    output
}

fn render_native_instructions(target: Target, skill: &RunxExportSkill, runx_bin: &Path) -> String {
    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&format!("name: {}\n", yaml_plain_or_quoted(&skill.name)));
    output.push_str("description: |-\n");
    output.push_str(&indent_block(&skill.description));
    if target == Target::Claude {
        output.push_str(&format!(
            "allowed-tools: Bash({} *)\n",
            shell_quote(&display_path(runx_bin))
        ));
    }
    output.push_str("---\n");
    output.push_str(&render_source_manual(skill));
    output.push_str(&format!(
        "<!-- {} source={} - generated, do not edit -->\n",
        target.marker(),
        display_path(&skill.abs_dir)
    ));
    output
}

fn render_source_manual(skill: &RunxExportSkill) -> String {
    format!(
        "<!-- runx-source-manual-begin digest={} package-digest={} bytes={} -->\n{}<!-- runx-source-manual-end -->\n\n",
        skill.manual_digest,
        skill.package_digest,
        skill.manual_markdown.len(),
        skill.manual_markdown
    )
}

fn render_runner(command_target: &str, runner: &RunxExportRunner, runx_bin: &str) -> String {
    let mut output = String::new();
    let title = runner.name.as_deref().unwrap_or("default");
    let default = if runner.default { " (default)" } else { "" };
    output.push_str(&format!("## Runner `{title}`{default}\n\n"));
    output.push_str("Inspect this exact contract from the source package:\n\n```bash\n");
    output.push_str(&render_inspect_command(command_target, runner, runx_bin));
    output.push_str("\n```\n\nInput contract:\n\n```json\n");
    let schema =
        runx_contracts::input_contract_schema_with_examples(&runner.inputs, &runner.examples);
    output.push_str(
        &serde_json::to_string_pretty(&schema)
            .unwrap_or_else(|_| "{\"type\":\"object\"}".to_owned()),
    );
    output.push_str("\n```\n\n");
    if !runner.examples.is_empty() {
        output.push_str("Validated invocation example:\n\n");
    } else {
        output.push_str("Invocation template (replace placeholders before running):\n\n");
    }
    output.push_str("```bash\n");
    output.push_str(&render_command(command_target, runner, runx_bin));
    output.push_str("\n```\n\n");
    output
}

fn render_inspect_command(
    command_target: &str,
    runner: &RunxExportRunner,
    runx_bin: &str,
) -> String {
    let mut command = format!(
        "{} skill inspect {}",
        shell_quote(runx_bin),
        shell_quote(command_target),
    );
    if let Some(name) = &runner.name {
        command.push(' ');
        command.push_str(&shell_quote(name));
    }
    command.push_str(" --json");
    command
}

fn render_command(command_target: &str, runner: &RunxExportRunner, runx_bin: &str) -> String {
    let mut command = format!(
        "{} skill {}",
        shell_quote(runx_bin),
        shell_quote(command_target)
    );
    if let Some(name) = &runner.name {
        command.push(' ');
        command.push_str(&shell_quote(name));
    }
    let mut lines = vec![command];
    if let Some(example) = runner.examples.first() {
        for (name, value) in example {
            let encoded = serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned());
            lines.push(format!(
                "  --input-json {} {}",
                shell_quote(name),
                shell_quote(&encoded)
            ));
        }
    } else {
        for (name, input) in &runner.inputs {
            if input.required && input.default.is_none() {
                lines.push(format!("  --{name} \"<{name}>\""));
            }
        }
    }
    lines.push("  --json".to_owned());
    lines.join(" \\\n")
}

fn render_continuation(runx_bin: &str) -> String {
    format!(
        "\
Interpret the runx JSON result exactly:
- If `status` is `sealed`, surface the receipt id, status, and artifact ids.
- If runx returns `status` `needs_agent`, inspect `requests[]`. For each request with `kind` `agent_act`, treat `request.invocation.envelope` as the only task packet: verify `instructions` against `instructions_sha256`, use its `inputs`, progressive `current_context` summaries, `historical_context`, exact `instructions`, and `output` contract; do not use tools outside `allowed_tools`.
- Write an answers JSON file outside the skill package with one key per request id:

```json
{{
  \"answers\": {{
    \"<request.id>\": {{
      \"...\": \"object matching request.invocation.envelope.output\",
      \"closure\": {{
        \"disposition\": \"closed\",
        \"reason_code\": \"completed\",
        \"summary\": \"concise outcome summary\"
      }}
    }}
  }}
}}
```

Then resume the same run with the `run_id` printed by runx:

```bash
{} resume \"<run_id>\" \"<answers.json>\" \\
  --json
```

Repeat this loop until the result is sealed or runx asks for operator approval/input. If approval or human input is required, relay the exact runx request instead of fabricating an answer. Never place signing seeds, provider tokens, or raw credentials in the answers file or response.

",
        shell_quote(runx_bin)
    )
}

fn indent_block(value: &str) -> String {
    let mut output = String::new();
    for line in value.lines() {
        output.push_str("  ");
        output.push_str(line);
        output.push('\n');
    }
    if value.is_empty() {
        output.push_str("  \n");
    }
    output
}

fn yaml_plain_or_quoted(value: &str) -> String {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        value.to_owned()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| "\"runx-skill\"".to_owned())
    }
}

fn shell_quote(value: &str) -> String {
    if value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '/' | '.' | '_' | '-' | ':')
    }) {
        return value.to_owned();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
