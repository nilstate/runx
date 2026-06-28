// rust-style-allow: large-file - doctor aggregates path, registry, and authority diagnostics until those surfaces split.
use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use runx_contracts::{
    DoctorDiagnostic, DoctorDiagnosticSeverity, DoctorLocation, DoctorRepair,
    DoctorRepairConfidence, DoctorRepairKind, DoctorRepairRisk, DoctorReport, DoctorReportSchema,
    DoctorStatus, DoctorSummary, JsonObject, JsonValue,
};
use runx_pay::effect_state::{
    RUNX_EFFECT_STATE_PATH_ENV, RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV,
    hosted_effect_state_backend_is_supported, resolve_effect_state_path,
};
use runx_runtime::{
    PROVIDER_PERMISSION_GRANT_ID_ENV, PROVIDER_PERMISSION_GRANTED_SCOPES_ENV,
    RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV, RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV,
    RUNX_RECEIPT_SIGN_KID_ENV, RuntimeError, default_doctor_options, load_runx_config_file,
    resolve_runx_home_dir, run_doctor,
};

use crate::history::{
    RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64_ENV, RUNX_RECEIPT_VERIFY_KID_ENV,
};
use crate::registry::{self, RegistryAction, RegistryPlan};
use crate::router::{DoctorMode, DoctorPlan};

const OFFICIAL_SKILLS_DIR_ENV: &str = "RUNX_OFFICIAL_SKILLS_DIR";

pub fn run_native_doctor(plan: DoctorPlan) -> ExitCode {
    let env = crate::history::env_map();
    let cwd = match env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            let _ignored = crate::cli_io::write_stderr_code(&format!(
                "runx: failed to resolve cwd: {error}\n"
            ));
            return ExitCode::from(1);
        }
    };

    match run_doctor_command(&plan, &env, &cwd) {
        Ok(output) => crate::cli_io::write_stdout_code(&output.stdout, output.exit_code),
        Err(error) => {
            let _ignored = crate::cli_io::write_stderr_code(&format!("runx: {error}\n"));
            ExitCode::from(1)
        }
    }
}

struct DoctorCliOutput {
    stdout: String,
    exit_code: u8,
}

fn run_doctor_command(
    plan: &DoctorPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<DoctorCliOutput, DoctorCliError> {
    if plan.mode == DoctorMode::Authority || plan.mode == DoctorMode::Registry {
        let report = if plan.mode == DoctorMode::Authority {
            run_authority_doctor(env, cwd)
        } else {
            run_registry_doctor(env, cwd)
        };
        let stdout = if plan.json {
            json_line(&report)?
        } else {
            render_doctor_report(&report)
        };
        return Ok(DoctorCliOutput {
            stdout,
            exit_code: 0,
        });
    }

    let root = resolve_doctor_root(plan, env, cwd);
    let mut report = run_doctor(&root, &default_doctor_options())?;
    if let Some(diagnostic) = managed_agent_config_diagnostic(env, cwd) {
        report.diagnostics.push(diagnostic);
    }
    report.summary = summary(&report.diagnostics);
    if report
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == DoctorDiagnosticSeverity::Error)
    {
        report.status = DoctorStatus::Failure;
    }
    let exit_code = match report.status {
        DoctorStatus::Success => 0,
        DoctorStatus::Failure => 1,
    };
    let stdout = if plan.json {
        json_line(&report)?
    } else {
        render_doctor_report(&report)
    };
    Ok(DoctorCliOutput { stdout, exit_code })
}

// rust-style-allow: long-function - this builds one structured diagnostic packet
// from env, config, and credential state so the evidence and repair stay together.
fn managed_agent_config_diagnostic(
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Option<DoctorDiagnostic> {
    let config_dir = resolve_runx_home_dir(env, cwd);
    let config_path = config_dir.join("config.json");
    let config = load_runx_config_file(&config_path);
    let mut evidence = JsonObject::new();
    evidence.insert(
        "config_path".to_owned(),
        JsonValue::String(config_path.display().to_string()),
    );

    let (config_provider, config_model, config_key_ref, config_error) = match config {
        Ok(config) => (
            config
                .agent
                .as_ref()
                .and_then(|agent| agent.provider.as_deref())
                .map(str::to_owned),
            config
                .agent
                .as_ref()
                .and_then(|agent| agent.model.as_deref())
                .map(str::to_owned),
            config
                .agent
                .as_ref()
                .and_then(|agent| agent.api_key_ref.as_deref())
                .map(str::to_owned),
            None,
        ),
        Err(error) => (None, None, None, Some(error.to_string())),
    };

    let provider = first_non_empty([
        env.get("RUNX_AGENT_PROVIDER").map(String::as_str),
        config_provider.as_deref(),
    ]);
    let model = first_non_empty([
        env.get("RUNX_AGENT_MODEL").map(String::as_str),
        config_model.as_deref(),
    ]);
    let provider_key_env = provider.and_then(provider_api_key_env);
    let api_key_configured = env_contains_non_empty(env, "RUNX_AGENT_API_KEY")
        || provider_key_env.is_some_and(|name| env_contains_non_empty(env, name))
        || config_key_ref
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());

    evidence.insert(
        "provider_set".to_owned(),
        JsonValue::Bool(provider.is_some()),
    );
    evidence.insert("model_set".to_owned(), JsonValue::Bool(model.is_some()));
    evidence.insert(
        "api_key_set".to_owned(),
        JsonValue::Bool(api_key_configured),
    );
    if let Some(provider) = provider {
        evidence.insert(
            "provider".to_owned(),
            JsonValue::String(provider.to_owned()),
        );
    }
    if let Some(model) = model {
        evidence.insert("model".to_owned(), JsonValue::String(model.to_owned()));
    }
    if let Some(name) = provider_key_env {
        evidence.insert(
            "provider_api_key_env".to_owned(),
            JsonValue::String(name.to_owned()),
        );
    }
    if let Some(error) = config_error.as_ref() {
        evidence.insert("config_error".to_owned(), JsonValue::String(error.clone()));
    }

    let complete = provider.is_some() && model.is_some() && api_key_configured;
    let partial = !complete
        && (provider.is_some() || model.is_some() || api_key_configured || config_error.is_some());
    if !complete && !partial {
        return None;
    }
    let severity = if partial {
        DoctorDiagnosticSeverity::Warning
    } else {
        DoctorDiagnosticSeverity::Info
    };
    let message = if let Some(error) = config_error {
        format!("Managed-agent config could not be read: {error}.")
    } else if complete {
        "Managed-agent config is complete; agent-task runners can execute in-process.".to_owned()
    } else {
        "Managed-agent config is partial; set provider, model, and API key or unset the partial values. Otherwise agent-task runners may yield to the host or fail later.".to_owned()
    };

    Some(DoctorDiagnostic {
        id: "runx.agent.config".to_owned(),
        instance_id: "runx:doctor:runx.agent.config".to_owned(),
        severity,
        title: "Managed-agent config".to_owned(),
        message,
        target: object([
            ("kind", string_value("config")),
            ("ref", string_value("runx.agent.config")),
        ]),
        location: DoctorLocation {
            path: "runx config".to_owned(),
            json_pointer: Some("/agent".to_owned()),
        },
        evidence: Some(evidence),
        repairs: if partial {
            vec![DoctorRepair {
                id: "runx.agent.config.configure".to_owned(),
                kind: DoctorRepairKind::Manual,
                confidence: DoctorRepairConfidence::High,
                risk: DoctorRepairRisk::Low,
                path: Some("runx config".to_owned()),
                json_pointer: Some("/agent".to_owned()),
                contents: Some(
                    "Set agent.provider, agent.model, and agent.api_key, or unset partial managed-agent config."
                        .to_owned(),
                ),
                patch: None,
                command: Some(
                    "runx config set agent.provider anthropic && runx config set agent.model <model> && runx config set agent.api_key <key>".to_owned(),
                ),
                requires_human_review: false,
            }]
        } else {
            Vec::new()
        },
    })
}

fn first_non_empty<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<&'a str> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
}

fn provider_api_key_env(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        _ => None,
    }
}

fn run_registry_doctor(env: &BTreeMap<String, String>, cwd: &Path) -> DoctorReport {
    let target = registry::resolve_registry_target(&registry_probe_plan(), env, cwd);
    let diagnostics = vec![
        registry_target_diagnostic(&target),
        path_diagnostic(
            "runx.registry.official_cache",
            "Official skill cache",
            registry::official_skills_cache_root(env, cwd),
            &[OFFICIAL_SKILLS_DIR_ENV],
        ),
        path_diagnostic(
            "runx.registry.global_cache",
            "Registry skill cache",
            registry::registry_skills_cache_root(env, cwd),
            &["RUNX_HOME"],
        ),
        registry_trust_key_diagnostic(env),
        registry_remote_install_diagnostic(&target, env),
    ];
    DoctorReport {
        schema: DoctorReportSchema::V1,
        status: DoctorStatus::Success,
        summary: summary(&diagnostics),
        diagnostics,
    }
}

fn registry_probe_plan() -> RegistryPlan {
    RegistryPlan {
        action: RegistryAction::Resolve,
        subject: "runx/registry-probe".to_owned(),
        registry: None,
        registry_dir: None,
        version: None,
        expected_digest: None,
        destination: None,
        owner: None,
        profile: None,
        trust_tier: None,
        limit: None,
        upsert: false,
        json: true,
    }
}

fn registry_target_diagnostic(target: &registry::RegistryTarget) -> DoctorDiagnostic {
    let mut evidence = JsonObject::new();
    evidence.insert("source".to_owned(), string_value(target.label()));
    evidence.insert(
        "description".to_owned(),
        JsonValue::String(registry::registry_source_description(target)),
    );
    evidence.insert(
        "source_fingerprint".to_owned(),
        JsonValue::String(target.fingerprint_source()),
    );
    DoctorDiagnostic {
        id: "runx.registry.target".to_owned(),
        instance_id: "runx:doctor-registry:runx.registry.target".to_owned(),
        severity: DoctorDiagnosticSeverity::Info,
        title: "Registry target".to_owned(),
        message: format!(
            "Registry target selected: {}.",
            registry::registry_source_description(target)
        ),
        target: object([
            ("kind", string_value("registry")),
            ("ref", string_value("runx.registry.target")),
        ]),
        location: DoctorLocation {
            path: "environment".to_owned(),
            json_pointer: None,
        },
        evidence: Some(evidence),
        repairs: Vec::new(),
    }
}

fn path_diagnostic(id: &str, title: &str, path: PathBuf, env_names: &[&str]) -> DoctorDiagnostic {
    let mut evidence = JsonObject::new();
    evidence.insert(
        "path".to_owned(),
        JsonValue::String(path.display().to_string()),
    );
    evidence.insert(
        "env_vars".to_owned(),
        JsonValue::Array(
            env_names
                .iter()
                .map(|name| JsonValue::String((*name).to_owned()))
                .collect(),
        ),
    );
    DoctorDiagnostic {
        id: id.to_owned(),
        instance_id: format!("runx:doctor-registry:{id}"),
        severity: DoctorDiagnosticSeverity::Info,
        title: title.to_owned(),
        message: format!("{title} resolves to {}.", path.display()),
        target: object([
            ("kind", string_value("registry")),
            ("ref", string_value(id)),
        ]),
        location: DoctorLocation {
            path: "environment".to_owned(),
            json_pointer: None,
        },
        evidence: Some(evidence),
        repairs: Vec::new(),
    }
}

// rust-style-allow: long-function - one diagnostic assembles the trust-key matrix and repair hints.
fn registry_trust_key_diagnostic(env: &BTreeMap<String, String>) -> DoctorDiagnostic {
    let configured_key_id = env
        .get(runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID_ENV)
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let configured_owner = env
        .get(runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_OWNER_ENV)
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let configured_source =
        runx_runtime::registry::registry_manifest_source_authority_from_env(env)
            .map(|source| runx_runtime::registry::registry_manifest_source_key(&source));
    let key_material_configured = env_contains_non_empty(
        env,
        runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ENV,
    );
    let mut keys =
        runx_runtime::registry::default_trusted_registry_manifest_keys().unwrap_or_default();
    let configured = key_material_configured
        && configured_key_id.is_some()
        && configured_owner.is_some()
        && configured_source.is_some();
    if configured
        && let Ok(configured_keys) =
            runx_runtime::registry::trusted_registry_manifest_keys_from_env(env)
    {
        keys = configured_keys;
    }
    let partial = !configured
        && (key_material_configured
            || configured_key_id.is_some()
            || configured_owner.is_some()
            || configured_source.is_some());
    let mut evidence = JsonObject::new();
    evidence.insert(
        "key_ids".to_owned(),
        JsonValue::Array(
            keys.iter()
                .map(|key| JsonValue::String(key.key_id.clone()))
                .collect(),
        ),
    );
    evidence.insert(
        "trust_policy".to_owned(),
        JsonValue::Array(keys.iter().map(registry_trust_policy_evidence).collect()),
    );
    evidence.insert(
        "operator_key_configured".to_owned(),
        JsonValue::Bool(configured),
    );
    evidence.insert(
        "partial_operator_key_config".to_owned(),
        JsonValue::Bool(partial),
    );
    evidence.insert(
        "env_vars".to_owned(),
        JsonValue::Array(
            [
                runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID_ENV,
                runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ENV,
                runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_OWNER_ENV,
                "RUNX_REGISTRY_URL",
                "RUNX_REGISTRY_DIR",
            ]
            .into_iter()
            .map(|name| JsonValue::String(name.to_owned()))
            .collect(),
        ),
    );
    DoctorDiagnostic {
        id: "runx.registry.trust_keys".to_owned(),
        instance_id: "runx:doctor-registry:runx.registry.trust_keys".to_owned(),
        severity: if partial {
            DoctorDiagnosticSeverity::Warning
        } else {
            DoctorDiagnosticSeverity::Info
        },
        title: "Registry trust keys".to_owned(),
        message: if configured {
            format!(
                "Registry manifest trust key configured; key id: {}.",
                configured_key_id.unwrap_or_default()
            )
        } else if partial {
            format!(
                "Registry manifest trust key is partially configured; set {}, {}, {}, and a registry source.",
                runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID_ENV,
                runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ENV,
                runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_OWNER_ENV,
            )
        } else {
            format!(
                "Using built-in registry trust keys. Set {}, {}, {}, and a registry source to add an operator key.",
                runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID_ENV,
                runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ENV,
                runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_OWNER_ENV,
            )
        },
        target: object([
            ("kind", string_value("registry")),
            ("ref", string_value("runx.registry.trust_keys")),
        ]),
        location: DoctorLocation {
            path: "environment".to_owned(),
            json_pointer: None,
        },
        evidence: Some(evidence),
        repairs: if partial {
            vec![manual_env_repair(
                "runx.registry.trust_keys.configure_env",
                &[
                    runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID_ENV,
                    runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ENV,
                    runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_OWNER_ENV,
                    "RUNX_REGISTRY_URL",
                    "RUNX_REGISTRY_DIR",
                ],
                "Set the registry manifest trust key id, public key, allowed owner namespace, and registry source together.",
                DoctorRepairRisk::Sensitive,
            )]
        } else {
            Vec::new()
        },
    }
}

fn registry_trust_policy_evidence(
    key: &runx_runtime::registry::TrustedRegistryManifestKey,
) -> JsonValue {
    let (scope, allowed_namespace, allowed_source, can_grant_first_party) = match &key.scope {
        runx_runtime::registry::RegistryManifestTrustScope::OfficialRunx => (
            "official_runx",
            "runx/*".to_owned(),
            "official_runx".to_owned(),
            true,
        ),
        runx_runtime::registry::RegistryManifestTrustScope::ThirdParty {
            allowed_owner,
            allowed_source,
        } => (
            "third_party",
            format!("{allowed_owner}/*"),
            allowed_source.clone(),
            false,
        ),
    };
    JsonValue::Object(object([
        ("key_id", JsonValue::String(key.key_id.clone())),
        ("scope", string_value(scope)),
        ("allowed_namespace", JsonValue::String(allowed_namespace)),
        ("allowed_source", JsonValue::String(allowed_source)),
        (
            "can_grant_first_party",
            JsonValue::Bool(can_grant_first_party),
        ),
    ]))
}

fn registry_remote_install_diagnostic(
    target: &registry::RegistryTarget,
    env: &BTreeMap<String, String>,
) -> DoctorDiagnostic {
    let remote = matches!(target, registry::RegistryTarget::Remote { .. });
    let configured = env_contains_non_empty(env, "RUNX_INSTALLATION_ID");
    let severity = DoctorDiagnosticSeverity::Info;
    let message = if remote && configured {
        "Remote registry install identity configured.".to_owned()
    } else if remote {
        "Remote registry installs will use the local runx install identity; set RUNX_INSTALLATION_ID only when an explicit shared identity is needed.".to_owned()
    } else {
        "Remote registry install identity is not required for the selected local registry target."
            .to_owned()
    };
    let mut evidence = JsonObject::new();
    evidence.insert("remote_target".to_owned(), JsonValue::Bool(remote));
    evidence.insert("configured".to_owned(), JsonValue::Bool(configured));
    evidence.insert(
        "env_vars".to_owned(),
        JsonValue::Array(vec![JsonValue::String("RUNX_INSTALLATION_ID".to_owned())]),
    );
    DoctorDiagnostic {
        id: "runx.registry.installation_id".to_owned(),
        instance_id: "runx:doctor-registry:runx.registry.installation_id".to_owned(),
        severity,
        title: "Registry install identity".to_owned(),
        message,
        target: object([
            ("kind", string_value("registry")),
            ("ref", string_value("runx.registry.installation_id")),
        ]),
        location: DoctorLocation {
            path: "environment".to_owned(),
            json_pointer: None,
        },
        evidence: Some(evidence),
        repairs: Vec::new(),
    }
}

fn run_authority_doctor(env: &BTreeMap<String, String>, cwd: &Path) -> DoctorReport {
    let diagnostics = vec![
        readiness_diagnostic(
            "runx.authority.signer",
            "Receipt signer",
            &[
                RUNX_RECEIPT_SIGN_KID_ENV,
                RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV,
                RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV,
            ],
            env,
            Some(RUNX_RECEIPT_SIGN_KID_ENV),
        ),
        readiness_diagnostic(
            "runx.authority.verify_key",
            "Receipt verification key",
            &[
                RUNX_RECEIPT_VERIFY_KID_ENV,
                RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64_ENV,
            ],
            env,
            Some(RUNX_RECEIPT_VERIFY_KID_ENV),
        ),
        effect_state_diagnostic(env, cwd),
        readiness_diagnostic(
            "runx.authority.provider_grant",
            "Provider permission grant",
            &[
                PROVIDER_PERMISSION_GRANT_ID_ENV,
                PROVIDER_PERMISSION_GRANTED_SCOPES_ENV,
            ],
            env,
            None,
        ),
    ];
    DoctorReport {
        schema: DoctorReportSchema::V1,
        status: DoctorStatus::Success,
        summary: summary(&diagnostics),
        diagnostics,
    }
}

// rust-style-allow: long-function - one diagnostic keeps effect-state path, evidence, and repairs together.
fn effect_state_diagnostic(env: &BTreeMap<String, String>, cwd: &Path) -> DoctorDiagnostic {
    if env_contains_non_empty(env, RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV) {
        let hosted_status = hosted_effect_state_backend_is_supported(env);
        let mut evidence = authority_evidence(
            &[
                RUNX_EFFECT_STATE_PATH_ENV,
                RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV,
            ],
            true,
            None,
        );
        if matches!(hosted_status, Ok(true)) {
            evidence.insert(
                "backend".to_owned(),
                JsonValue::String("hosted_transactional".to_owned()),
            );
            evidence.insert(
                "transport".to_owned(),
                JsonValue::String("configured".to_owned()),
            );
            return DoctorDiagnostic {
                id: "runx.authority.effect_state".to_owned(),
                instance_id: "runx:doctor-authority:runx.authority.effect_state".to_owned(),
                severity: DoctorDiagnosticSeverity::Info,
                title: "Hosted effect state transport".to_owned(),
                message: format!(
                    "{RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV} is configured with a hosted transactional transport."
                ),
                target: object([
                    ("kind", string_value("authority")),
                    ("ref", string_value("runx.authority.effect_state")),
                ]),
                location: DoctorLocation {
                    path: "environment".to_owned(),
                    json_pointer: None,
                },
                evidence: Some(evidence),
                repairs: Vec::new(),
            };
        }
        evidence.insert(
            "consequence".to_owned(),
            JsonValue::String(
                "Native runx refuses incomplete hosted transactional effect-state descriptors before local file fallback.".to_owned(),
            ),
        );
        if let Err(error) = hosted_status {
            evidence.insert("error".to_owned(), JsonValue::String(error.to_string()));
        }
        return DoctorDiagnostic {
            id: "runx.authority.effect_state".to_owned(),
            instance_id: "runx:doctor-authority:runx.authority.effect_state".to_owned(),
            severity: DoctorDiagnosticSeverity::Error,
            title: "Effect state path".to_owned(),
            message: format!(
                "{RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV} is configured without a complete hosted effect-state transport. Unset it for local file-backed execution, or pass endpoint_url, bearer_token, and allowed_families from the hosted runtime service."
            ),
            target: object([
                ("kind", string_value("authority")),
                ("ref", string_value("runx.authority.effect_state")),
            ]),
            location: DoctorLocation {
                path: "environment".to_owned(),
                json_pointer: None,
            },
            evidence: Some(evidence),
            repairs: vec![manual_env_repair(
                "runx.authority.effect_state.configure_hosted_transport",
                &[RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV],
                "Pass a complete native-hosted effect-state transport descriptor, or unset RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON for local file-backed execution.",
                DoctorRepairRisk::High,
            )],
        };
    }
    let configured = env_contains_non_empty(env, RUNX_EFFECT_STATE_PATH_ENV);
    let resolved_path = resolve_effect_state_path(env, cwd);
    let mut evidence = authority_evidence(&[RUNX_EFFECT_STATE_PATH_ENV], configured, None);
    let message = match resolved_path.as_ref() {
        Some(path) if configured => {
            let path = path.display();
            evidence.insert(
                "resolved_path".to_owned(),
                JsonValue::String(path.to_string()),
            );
            format!("Effect state path configured; resolved path: {path}.")
        }
        Some(path) => {
            let path = path.display();
            evidence.insert(
                "resolved_path".to_owned(),
                JsonValue::String(path.to_string()),
            );
            evidence.insert(
                "consequence".to_owned(),
                JsonValue::String(effect_state_unset_consequence().to_owned()),
            );
            format!(
                "Effect state path not configured; set {RUNX_EFFECT_STATE_PATH_ENV}. \
                 {consequence} Current fallback resolves to: {path}.",
                consequence = effect_state_unset_consequence()
            )
        }
        None => {
            evidence.insert(
                "consequence".to_owned(),
                JsonValue::String(effect_state_unset_consequence().to_owned()),
            );
            format!(
                "Effect state path not configured; set {RUNX_EFFECT_STATE_PATH_ENV}. {}",
                effect_state_unset_consequence()
            )
        }
    };
    DoctorDiagnostic {
        id: "runx.authority.effect_state".to_owned(),
        instance_id: "runx:doctor-authority:runx.authority.effect_state".to_owned(),
        severity: if configured {
            DoctorDiagnosticSeverity::Info
        } else {
            DoctorDiagnosticSeverity::Warning
        },
        title: "Effect state path".to_owned(),
        message,
        target: object([
            ("kind", string_value("authority")),
            ("ref", string_value("runx.authority.effect_state")),
        ]),
        location: DoctorLocation {
            path: "environment".to_owned(),
            json_pointer: None,
        },
        evidence: Some(evidence),
        repairs: if configured {
            Vec::new()
        } else {
            vec![manual_env_repair(
                "runx.authority.effect_state.configure_env",
                &[RUNX_EFFECT_STATE_PATH_ENV],
                "Set RUNX_EFFECT_STATE_PATH to a durable writable state file for cross-run effect accounting.",
                DoctorRepairRisk::Low,
            )]
        },
    }
}

fn effect_state_unset_consequence() -> &'static str {
    "Cross-run spend caps, payment idempotency, and effect replay recovery are not durable without a configured state path."
}

fn readiness_diagnostic(
    id: &str,
    title: &str,
    env_names: &[&str],
    env: &BTreeMap<String, String>,
    key_id_env: Option<&str>,
) -> DoctorDiagnostic {
    let missing = env_names
        .iter()
        .filter(|name| !env_contains_non_empty(env, name))
        .copied()
        .collect::<Vec<_>>();
    let configured = missing.is_empty();
    let message = if configured {
        match key_id_env
            .and_then(|name| env.get(name))
            .map(String::as_str)
        {
            Some(key_id) => format!("{title} configured; key id: {key_id}."),
            None => format!("{title} configured."),
        }
    } else {
        format!("{title} not configured; set {}.", missing.join(", "))
    };
    DoctorDiagnostic {
        id: id.to_owned(),
        instance_id: format!("runx:doctor-authority:{id}"),
        severity: if configured {
            DoctorDiagnosticSeverity::Info
        } else {
            DoctorDiagnosticSeverity::Warning
        },
        title: title.to_owned(),
        message,
        target: object([
            ("kind", string_value("authority")),
            ("ref", string_value(id)),
        ]),
        location: DoctorLocation {
            path: "environment".to_owned(),
            json_pointer: None,
        },
        evidence: Some(authority_evidence(env_names, configured, key_id_env)),
        repairs: if configured {
            Vec::new()
        } else {
            vec![manual_env_repair(
                &format!("{id}.configure_env"),
                &missing,
                &format!("Set {} in the operator environment.", missing.join(", ")),
                DoctorRepairRisk::Sensitive,
            )]
        },
    }
}

fn manual_env_repair(
    id: &str,
    env_names: &[&str],
    contents: &str,
    risk: DoctorRepairRisk,
) -> DoctorRepair {
    DoctorRepair {
        id: id.to_owned(),
        kind: DoctorRepairKind::Manual,
        confidence: DoctorRepairConfidence::High,
        risk,
        path: Some("environment".to_owned()),
        json_pointer: None,
        contents: Some(format!(
            "{contents} Required env vars: {}.",
            env_names.join(", ")
        )),
        patch: None,
        command: None,
        requires_human_review: true,
    }
}

fn authority_evidence(
    env_names: &[&str],
    configured: bool,
    key_id_env: Option<&str>,
) -> JsonObject {
    let mut evidence = JsonObject::new();
    evidence.insert(
        "env_vars".to_owned(),
        JsonValue::Array(
            env_names
                .iter()
                .map(|name| JsonValue::String((*name).to_owned()))
                .collect(),
        ),
    );
    evidence.insert("configured".to_owned(), JsonValue::Bool(configured));
    if let Some(name) = key_id_env {
        evidence.insert("key_id_env".to_owned(), JsonValue::String(name.to_owned()));
    }
    evidence
}

fn env_contains_non_empty(env: &BTreeMap<String, String>, name: &str) -> bool {
    env.get(name)
        .map(String::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn object(entries: impl IntoIterator<Item = (&'static str, JsonValue)>) -> JsonObject {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

fn string_value(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

fn summary(diagnostics: &[DoctorDiagnostic]) -> DoctorSummary {
    let mut errors = 0;
    let mut warnings = 0;
    let mut infos = 0;
    for diagnostic in diagnostics {
        match diagnostic.severity {
            DoctorDiagnosticSeverity::Error => errors += 1,
            DoctorDiagnosticSeverity::Warning => warnings += 1,
            DoctorDiagnosticSeverity::Info => infos += 1,
        }
    }
    DoctorSummary {
        errors,
        warnings,
        infos,
    }
}

fn resolve_doctor_root(plan: &DoctorPlan, env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    match plan.path.as_deref() {
        Some(path) => {
            runx_runtime::resolve_path_from_user_input(&path.to_string_lossy(), env, cwd, true)
        }
        None => workspace_base(env, cwd),
    }
}

fn workspace_base(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    env.get("RUNX_CWD")
        .map(PathBuf::from)
        .or_else(|| find_runx_workspace_root(cwd))
        .or_else(|| env.get("INIT_CWD").map(PathBuf::from))
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn find_runx_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join("pnpm-workspace.yaml").exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn json_line<T: serde::Serialize>(value: &T) -> Result<String, DoctorCliError> {
    serde_json::to_string_pretty(value)
        .map(|json| format!("{json}\n"))
        .map_err(DoctorCliError::Serialize)
}

fn render_doctor_report(report: &DoctorReport) -> String {
    let mut lines = vec![
        String::new(),
        format!(
            "  {}  doctor  {} error(s), {} warning(s)",
            status_icon(&report.status),
            report.summary.errors,
            report.summary.warnings
        ),
    ];
    for diagnostic in &report.diagnostics {
        lines.push(format!(
            "  {}  {}  {}",
            diagnostic_icon(&diagnostic.severity),
            diagnostic.id,
            diagnostic.location.path
        ));
        lines.push(format!("     {}", diagnostic.message));
        if let Some(repair) = diagnostic.repairs.first() {
            if let Some(command) = repair.command.as_ref() {
                lines.push(format!("     next: {command}"));
            } else if let Some(contents) = repair.contents.as_ref() {
                lines.push(format!("     next: {contents}"));
            }
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn status_icon(status: &DoctorStatus) -> &'static str {
    match status {
        DoctorStatus::Success => "✓",
        DoctorStatus::Failure => "✗",
    }
}

fn diagnostic_icon(severity: &DoctorDiagnosticSeverity) -> &'static str {
    match severity {
        DoctorDiagnosticSeverity::Error => "✗",
        DoctorDiagnosticSeverity::Warning | DoctorDiagnosticSeverity::Info => "·",
    }
}

#[derive(Debug)]
enum DoctorCliError {
    Runtime(RuntimeError),
    Serialize(serde_json::Error),
}

impl std::fmt::Display for DoctorCliError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Runtime(error) => write!(formatter, "{error}"),
            Self::Serialize(error) => {
                write!(formatter, "failed to serialize doctor report: {error}")
            }
        }
    }
}

impl From<RuntimeError> for DoctorCliError {
    fn from(value: RuntimeError) -> Self {
        Self::Runtime(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_render_surfaces_first_repair_next_action() {
        let report = DoctorReport {
            schema: DoctorReportSchema::V1,
            status: DoctorStatus::Success,
            summary: DoctorSummary {
                errors: 0,
                warnings: 1,
                infos: 0,
            },
            diagnostics: vec![DoctorDiagnostic {
                id: "runx.registry.installation_id".to_owned(),
                instance_id: "runx:doctor-registry:runx.registry.installation_id".to_owned(),
                severity: DoctorDiagnosticSeverity::Info,
                title: "Registry install identity".to_owned(),
                message: "Remote registry installs use an automatic local install identity."
                    .to_owned(),
                target: object([
                    ("kind", string_value("registry")),
                    ("ref", string_value("runx.registry.installation_id")),
                ]),
                location: DoctorLocation {
                    path: "environment".to_owned(),
                    json_pointer: None,
                },
                evidence: None,
                repairs: vec![DoctorRepair {
                    id: "runx.registry.installation_id.configure_env".to_owned(),
                    kind: DoctorRepairKind::Manual,
                    confidence: DoctorRepairConfidence::High,
                    risk: DoctorRepairRisk::Low,
                    path: Some("environment".to_owned()),
                    json_pointer: None,
                    contents: Some(
                        "Set RUNX_INSTALLATION_ID only when you need a shared install identity."
                            .to_owned(),
                    ),
                    patch: None,
                    command: None,
                    requires_human_review: true,
                }],
            }],
        };

        let rendered = render_doctor_report(&report);

        assert!(rendered.contains(
            "next: Set RUNX_INSTALLATION_ID only when you need a shared install identity."
        ));
    }
}
