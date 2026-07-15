use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_cli::export::{ExportError, ExportPlan, Target, run_export_command};

use crate::support::temp_root;

#[test]
fn exports_public_skills_to_claude_global_with_absolute_delegation()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-claude-global")?;
    fixture.write_skill("visible", None)?;
    fixture.write_skill("hidden", Some("internal"))?;

    let report = run_export_command(
        &ExportPlan {
            target: Target::Claude,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    )?;

    assert_eq!(report.exported.len(), 1);
    assert_eq!(report.exported[0].skill, "visible");
    let shim = fixture.read_home_file(".claude/skills/visible/SKILL.md")?;
    assert!(shim.contains("allowed-tools: Bash(/opt/runx/bin/runx skill *)"));
    assert!(shim.contains("/opt/runx/bin/runx skill"));
    assert!(
        shim.contains(
            fixture
                .project
                .join("skills/visible")
                .to_str()
                .unwrap_or_default()
        )
    );
    assert!(shim.contains("runx-export:claude"));
    assert!(!fixture.home.join(".claude/skills/hidden/SKILL.md").exists());
    Ok(())
}

#[test]
fn exports_claude_project_scope_with_project_relative_skill_ref()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-claude-project")?;
    fixture.write_skill("visible", None)?;

    run_export_command(
        &ExportPlan {
            target: Target::Claude,
            refs: Vec::new(),
            project: true,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    )?;

    let shim = fixture.read_project_file(".claude/skills/visible/SKILL.md")?;
    assert!(shim.contains("/opt/runx/bin/runx skill skills/visible"));
    assert!(shim.contains("--objective \"<objective>\""));
    assert!(!shim.contains(&format!(
        "runx skill {}",
        fixture.project.to_str().unwrap_or_default()
    )));
    Ok(())
}

#[test]
fn explicit_ref_exports_internal_skill() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-explicit-internal")?;
    fixture.write_skill("hidden", Some("internal"))?;

    let report = run_export_command(
        &ExportPlan {
            target: Target::Claude,
            refs: vec!["hidden".to_owned()],
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    )?;

    assert_eq!(report.exported.len(), 1);
    assert_eq!(report.exported[0].skill, "hidden");
    assert!(fixture.home.join(".claude/skills/hidden/SKILL.md").exists());
    Ok(())
}

#[test]
fn codex_global_writes_shim_and_idempotent_permission_block()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-codex")?;
    fixture.write_skill("visible", None)?;
    fs::create_dir_all(fixture.home.join(".codex/rules"))?;
    fs::write(
        fixture.home.join(".codex/rules/default.rules"),
        "# existing approval\nallow_rule(pattern = [\"git\", \"status\"])\n",
    )?;

    run_export_command(
        &ExportPlan {
            target: Target::Codex,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    )?;
    run_export_command(
        &ExportPlan {
            target: Target::Codex,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    )?;

    let shim = fixture.read_home_file(".codex/skills/visible/SKILL.md")?;
    assert!(shim.contains("name: visible"));
    assert!(!shim.contains("allowed-tools"));
    assert!(shim.contains("--objective \"<objective>\""));
    assert!(shim.contains("local-development receipt identity"));
    assert!(shim.contains("complete signer tuple"));
    assert!(shim.contains("If runx returns `status` `needs_agent`"));
    assert!(shim.contains("request.invocation.envelope"));
    assert!(shim.contains("allowed_tools"));
    assert!(shim.contains("\"answers\""));
    assert!(shim.contains("resume \"<run_id>\" \"<answers.json>\""));
    assert!(shim.contains("runx-export:codex"));
    let rules = fixture.read_home_file(".codex/rules/default.rules")?;
    assert!(rules.contains("# existing approval"));
    assert_eq!(rules.matches("runx-export start").count(), 1);
    assert_eq!(
        rules
            .matches("prefix_rule(pattern = [\"runx\", \"skill\"]")
            .count(),
        1
    );
    assert_eq!(
        rules
            .matches("prefix_rule(pattern = [\"runx\", \"resume\"]")
            .count(),
        1
    );
    assert_eq!(
        rules
            .matches("prefix_rule(pattern = [\"/opt/runx/bin/runx\", \"skill\"]")
            .count(),
        1
    );
    assert_eq!(
        rules
            .matches("prefix_rule(pattern = [\"/opt/runx/bin/runx\", \"resume\"]")
            .count(),
        1
    );
    Ok(())
}

#[test]
fn exports_namespaced_repo_skills_with_codex_safe_names() -> Result<(), Box<dyn std::error::Error>>
{
    let fixture = ExportFixture::new("runx-export-namespaced")?;
    fixture.write_namespaced_skill("acme", "triage")?;

    let report = run_export_command(
        &ExportPlan {
            target: Target::Codex,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    )?;

    assert_eq!(report.exported.len(), 1);
    assert_eq!(report.exported[0].skill, "acme-triage");
    let shim = fixture.read_home_file(".codex/skills/acme-triage/SKILL.md")?;
    assert!(shim.contains("name: acme-triage"));
    assert!(shim.contains("skill /"));
    assert!(shim.contains("skills/acme/triage"));
    Ok(())
}

#[test]
fn codex_global_initializes_missing_codex_home() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-codex-first-run")?;
    fixture.write_skill("visible", None)?;

    let report = run_export_command(
        &ExportPlan {
            target: Target::Codex,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    )?;

    assert_eq!(report.exported.len(), 1);
    assert_eq!(report.exported[0].skill, "visible");
    assert!(fixture.home.join(".codex/skills/visible/SKILL.md").exists());
    assert!(fixture.home.join(".codex/rules/default.rules").exists());
    let rules = fixture.read_home_file(".codex/rules/default.rules")?;
    assert!(rules.contains("prefix_rule(pattern = [\"runx\", \"skill\"]"));
    assert!(rules.contains("prefix_rule(pattern = [\"runx\", \"resume\"]"));
    assert!(rules.contains("prefix_rule(pattern = [\"/opt/runx/bin/runx\", \"skill\"]"));
    assert!(rules.contains("prefix_rule(pattern = [\"/opt/runx/bin/runx\", \"resume\"]"));
    Ok(())
}

#[test]
fn exports_default_runner_inputs_when_skill_frontmatter_has_none()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-runner-inputs")?;
    fixture.write_skill_with_runner_inputs("send-as")?;

    run_export_command(
        &ExportPlan {
            target: Target::Codex,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    )?;

    let shim = fixture.read_home_file(".codex/skills/send-as/SKILL.md")?;
    assert!(shim.contains("--objective \"<objective>\""));
    assert!(shim.contains("--principal \"<principal>\""));
    assert!(shim.contains("- objective (required) - Bounded send objective."));
    assert!(shim.contains("- provider_context (optional) - Provider readiness."));
    assert!(shim.contains("A planning runner seals a plan, not the downstream external action"));
    assert!(!shim.contains("Do not perform the work yourself"));
    Ok(())
}

#[test]
fn explicit_ref_exports_official_source_skill() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-official-ref")?;
    let official_root = fixture.write_official_skill_with_runner_inputs("send-as")?;
    let mut env = fixture.env.clone();
    env.insert(
        "RUNX_OFFICIAL_SKILLS_SOURCE_DIR".to_owned(),
        path_string(&official_root)?,
    );

    let report = run_export_command(
        &ExportPlan {
            target: Target::Codex,
            refs: vec!["send-as".to_owned()],
            project: false,
            json: false,
        },
        &fixture.project,
        &env,
    )?;

    assert_eq!(report.exported.len(), 1);
    assert_eq!(report.exported[0].skill, "send-as");
    let shim = fixture.read_home_file(".codex/skills/send-as/SKILL.md")?;
    assert!(shim.contains("skill "));
    assert!(shim.contains("/official-skills/send-as"));
    assert!(shim.contains("--objective \"<objective>\""));
    Ok(())
}

#[test]
fn reexport_prunes_only_marked_generated_files() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-prune")?;
    fixture.write_skill("visible", None)?;
    let managed = fixture.home.join(".claude/skills/stale/SKILL.md");
    let manual = fixture.home.join(".claude/skills/manual/SKILL.md");
    fs::create_dir_all(managed.parent().ok_or("managed parent")?)?;
    fs::create_dir_all(manual.parent().ok_or("manual parent")?)?;
    fs::write(
        &managed,
        "---\nname: stale\n---\n<!-- runx-export:claude source=/missing - generated, do not edit -->\n",
    )?;
    fs::write(&manual, "---\nname: manual\n---\n# Hand-authored\n")?;

    let report = run_export_command(
        &ExportPlan {
            target: Target::Claude,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    )?;

    assert_eq!(report.pruned.len(), 1);
    assert!(!managed.exists());
    assert!(manual.exists());
    Ok(())
}

#[test]
fn codex_project_scope_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-codex-project")?;
    fixture.write_skill("visible", None)?;

    let error = match run_export_command(
        &ExportPlan {
            target: Target::Codex,
            refs: Vec::new(),
            project: true,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    ) {
        Ok(_) => return Err("codex project export should be disabled".into()),
        Err(error) => error,
    };

    match error {
        ExportError::Unsupported(message) => {
            assert!(message.contains("not supported until Codex project skill"));
        }
        other => return Err(format!("unexpected error: {other}").into()),
    }
    Ok(())
}

#[test]
fn rejects_skill_names_that_escape_export_directory() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-path-traversal")?;
    let dir = fixture.project.join("skills").join("bad");
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: ../outside\ndescription: Escape attempt.\n---\n# bad\n",
    )?;

    let error = match run_export_command(
        &ExportPlan {
            target: Target::Claude,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    ) {
        Ok(_) => return Err("unsafe skill name should fail".into()),
        Err(error) => error,
    };

    match error {
        ExportError::InvalidArgs(message) => {
            assert!(message.contains("cannot be exported"));
        }
        other => return Err(format!("unexpected error: {other}").into()),
    }
    assert!(!fixture.home.join(".claude/outside/SKILL.md").exists());
    Ok(())
}

#[test]
fn rejects_input_names_that_are_not_safe_shell_flags() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = ExportFixture::new("runx-export-unsafe-input")?;
    fixture.write_skill_with_input("bad", "bad$name")?;

    let error = match run_export_command(
        &ExportPlan {
            target: Target::Claude,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    ) {
        Ok(_) => return Err("unsafe input name should fail".into()),
        Err(error) => error,
    };

    match error {
        ExportError::InvalidArgs(message) => {
            assert!(message.contains("not a safe runx skill flag"));
        }
        other => return Err(format!("unexpected error: {other}").into()),
    }
    Ok(())
}

#[test]
fn rejects_input_names_that_collide_with_runx_skill_flags() -> Result<(), Box<dyn std::error::Error>>
{
    let fixture = ExportFixture::new("runx-export-reserved-input")?;
    fixture.write_skill_with_input("bad", "json")?;

    let error = match run_export_command(
        &ExportPlan {
            target: Target::Claude,
            refs: Vec::new(),
            project: false,
            json: false,
        },
        &fixture.project,
        &fixture.env,
    ) {
        Ok(_) => return Err("reserved input name should fail".into()),
        Err(error) => error,
    };

    match error {
        ExportError::InvalidArgs(message) => {
            assert!(message.contains("not a safe runx skill flag"));
        }
        other => return Err(format!("unexpected error: {other}").into()),
    }
    Ok(())
}

struct ExportFixture {
    root: PathBuf,
    project: PathBuf,
    home: PathBuf,
    env: BTreeMap<String, String>,
}

impl ExportFixture {
    fn new(prefix: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let root = temp_root(prefix);
        let project = root.join("project");
        let home = root.join("home");
        fs::create_dir_all(&project)?;
        fs::create_dir_all(&home)?;
        let env = [
            ("HOME".to_owned(), path_string(&home)?),
            (
                "RUNX_EXPORT_BIN".to_owned(),
                "/opt/runx/bin/runx".to_owned(),
            ),
        ]
        .into_iter()
        .collect();
        Ok(Self {
            root,
            project,
            home,
            env,
        })
    }

    fn write_skill(
        &self,
        name: &str,
        visibility: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.write_skill_with_input_and_visibility(name, "objective", visibility)
    }

    fn write_skill_with_input(
        &self,
        name: &str,
        input_name: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.write_skill_with_input_and_visibility(name, input_name, None)
    }

    fn write_skill_with_input_and_visibility(
        &self,
        name: &str,
        input_name: &str,
        visibility: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let dir = self.project.join("skills").join(name);
        fs::create_dir_all(&dir)?;
        fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: Export {name} through runx.\ninputs:\n  {input_name}:\n    type: string\n    required: true\n    description: Work to perform.\n---\n# {name}\n\nRun the governed skill.\n"
            ),
        )?;
        if let Some(visibility) = visibility {
            fs::write(
                dir.join("X.yaml"),
                format!(
                    "skill: {name}\ncatalog:\n  kind: skill\n  audience: public\n  visibility: {visibility}\n  role: context\nrunners:\n  default:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: {name}\n"
                ),
            )?;
        }
        Ok(())
    }

    fn write_skill_with_runner_inputs(&self, name: &str) -> Result<(), Box<dyn std::error::Error>> {
        let dir = self.project.join("skills").join(name);
        Self::write_runner_input_skill_at(&dir, name)
    }

    fn write_namespaced_skill(
        &self,
        owner: &str,
        name: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let declared_name = format!("{owner}/{name}");
        let dir = self.project.join("skills").join(owner).join(name);
        fs::create_dir_all(&dir)?;
        fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: {declared_name}\ndescription: Export {declared_name} through runx.\ninputs:\n  objective:\n    type: string\n    required: true\n    description: Work to perform.\n---\n# {declared_name}\n"
            ),
        )?;
        fs::write(
            dir.join("X.yaml"),
            format!(
                "skill: {declared_name}\ncatalog:\n  kind: skill\n  audience: operator\n  visibility: public\n  role: canonical\nrunners:\n  default:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: {name}\n"
            ),
        )?;
        Ok(())
    }

    fn write_official_skill_with_runner_inputs(
        &self,
        name: &str,
    ) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let root = self.root.join("official-skills");
        Self::write_runner_input_skill_at(&root.join(name), name)?;
        Ok(root)
    }

    fn write_runner_input_skill_at(
        dir: &Path,
        name: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        fs::create_dir_all(dir)?;
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Export {name} through runx.\n---\n# {name}\n"),
        )?;
        fs::write(
            dir.join("X.yaml"),
            format!(
                "skill: {name}\ncatalog:\n  kind: skill\n  audience: public\n  visibility: public\n  role: canonical\nrunners:\n  plan:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: {name}\n    inputs:\n      objective:\n        type: string\n        required: true\n        description: Bounded send objective.\n      principal:\n        type: string\n        required: true\n        description: Principal represented by the send.\n      provider_context:\n        type: json\n        required: false\n        description: Provider readiness.\n"
            ),
        )?;
        Ok(())
    }

    fn read_home_file(&self, relative: &str) -> Result<String, Box<dyn std::error::Error>> {
        Ok(fs::read_to_string(self.home.join(relative))?)
    }

    fn read_project_file(&self, relative: &str) -> Result<String, Box<dyn std::error::Error>> {
        Ok(fs::read_to_string(self.project.join(relative))?)
    }
}

impl Drop for ExportFixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).ok();
    }
}

fn path_string(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "path is not UTF-8".into())
}
