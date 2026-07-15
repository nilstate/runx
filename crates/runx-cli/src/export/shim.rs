use std::collections::BTreeMap;
use std::path::Path;

use runx_runtime::export::{RunxExportSkill, RunxExportSkillInput};

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
    output.push_str("```bash\n");
    output.push_str(&render_command(
        command_target,
        &skill.inputs,
        &display_path(runx_bin),
    ));
    output.push_str("\n```\n\n");
    output.push_str(&render_inputs(&skill.inputs));
    output.push('\n');
    output.push_str(&render_continuation(&display_path(runx_bin)));
    output.push_str(&format!(
        "<!-- {} source={} - generated, do not edit -->\n",
        target.marker(),
        display_path(&skill.abs_dir)
    ));
    output
}

fn render_command(
    command_target: &str,
    inputs: &BTreeMap<String, RunxExportSkillInput>,
    runx_bin: &str,
) -> String {
    let mut lines = vec![format!(
        "{} skill {}",
        shell_quote(runx_bin),
        shell_quote(command_target)
    )];
    for name in inputs.keys() {
        lines.push(format!("  --{name} \"<{name}>\""));
    }
    lines.push("  --json".to_owned());
    lines.join(" \\\n")
}

fn render_inputs(inputs: &BTreeMap<String, RunxExportSkillInput>) -> String {
    if inputs.is_empty() {
        return "Inputs: none.\n".to_owned();
    }
    let mut lines = vec!["Inputs:".to_owned()];
    for (name, input) in inputs {
        let requirement = if input.required {
            "required"
        } else {
            "optional"
        };
        let description = input
            .description
            .as_deref()
            .unwrap_or("No description provided.");
        lines.push(format!("- {name} ({requirement}) - {description}"));
    }
    format!("{}\n", lines.join("\n"))
}

fn render_continuation(runx_bin: &str) -> String {
    format!(
        "\
Interpret the runx JSON result exactly:
- If `status` is `sealed`, surface the receipt id, status, and artifact ids.
- If runx returns `status` `needs_agent`, inspect `requests[]`. For each request with `kind` `agent_act`, treat `request.invocation.envelope` as the only task packet: use its `inputs`, `current_context`, `historical_context`, `instructions`, and `output` contract; do not use tools outside `allowed_tools`.
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
