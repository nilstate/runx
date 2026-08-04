use std::fs;
use std::path::Path;

pub(crate) fn write_cli_tool_skill(
    dir: &Path,
    name: &str,
    description: &str,
    inputs: &[(&str, &str)],
    emitted_packet: Option<&str>,
) -> Result<(), std::io::Error> {
    fs::create_dir(dir)?;
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"),
    )?;

    let inputs = inputs
        .iter()
        .fold(String::new(), |mut yaml, (name, input_type)| {
            yaml.push_str(&format!(
                "      {name}:\n        type: {input_type}\n        required: false\n"
            ));
            yaml
        });
    let inputs = if inputs.is_empty() {
        String::new()
    } else {
        format!("    inputs:\n{inputs}")
    };
    let artifacts = emitted_packet.map_or_else(String::new, |packet| {
        format!("    artifacts:\n      named_emits:\n        {packet}: runx.payment.{packet}.v1\n")
    });
    fs::write(
        dir.join("X.yaml"),
        format!(
            "skill: {name}\nversion: \"0.1.0\"\nrunners:\n  {name}:\n    default: true\n    type: cli-tool\n    command: runx-payment-test\n{inputs}{artifacts}"
        ),
    )
}
