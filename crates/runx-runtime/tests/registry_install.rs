use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::signature::KeyPair;
use runx_contracts::{sha256_hex, sha256_prefixed};
use runx_runtime::registry::{
    InstallCandidate, InstallError, InstallLocalSkillOptions, RegistryManifestSignature,
    RegistryManifestSigner, RegistryManifestSourceAuthority, RegistryManifestTrustEnvError,
    RegistryPackageFile, RegistrySignedManifest, TrustTier, TrustedRegistryManifestKey,
    install_local_skill, trusted_registry_manifest_keys_from_env,
};
use tempfile::tempdir;

const TEST_MANIFEST_KEY_ID: &str = "runx-registry-test-key";
const TEST_MANIFEST_SIGNER_ID: &str = "runx-registry-test-signer";
const TEST_MANIFEST_PUBLIC_KEY_BASE64: &str = "K9U/1+6tuu9O5YfBO++MHrdr95NlPe1Okyg9XS7eWm0=";
const DYNAMIC_MANIFEST_SEED: [u8; 32] = [7; 32];
const TEST_MANIFEST_SIGNATURE: &str =
    "base64:e-DzjjAZRv4inUscSd43cfT5287lIkvkM1YqgsFy1pZ9PkHEJCKp5Hm-zdlAY1D7ItVLNEw8HTM03lhgPk4hCg";
const TEST_MANIFEST_OTHER_SKILL_SIGNATURE: &str =
    "base64:h0WA5oT6vN3L5jQ76o79l533P3kE2tw1tphqgDcmmQu0_DcsfhPNAI05w1njHzyYib_CUnjPpYpx0c8MsJOMAw";

#[test]
fn trusted_signed_manifest_installs() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let candidate = install_candidate()?;

    let install = install_local_skill(
        &candidate,
        &InstallLocalSkillOptions {
            destination_root: temp.path().join("skills"),
            expected_digest: None,
            trusted_manifest_keys: trusted_manifest_keys()?,
        },
    )?;

    assert_eq!(install.skill_id.as_deref(), Some("acme/echo"));
    assert_eq!(install.digest, skill_digest());
    assert!(install.destination.exists());
    Ok(())
}

#[test]
fn package_files_install_and_digest_mismatch_fails() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut candidate = install_candidate()?;
    candidate.package_files = vec![
        RegistryPackageFile {
            path: "run.mjs".to_owned(),
            content: "console.log('installed');\n".to_owned(),
        },
        RegistryPackageFile {
            path: "context/review-rubric/SKILL.md".to_owned(),
            content: "---\nname: review-rubric\n---\n# Review\n".to_owned(),
        },
        RegistryPackageFile {
            path: "references/operator.md".to_owned(),
            content: "# Operator\n".to_owned(),
        },
        RegistryPackageFile {
            path: "graph/stage/X.yaml".to_owned(),
            content: "skill: stage\n".to_owned(),
        },
        RegistryPackageFile {
            path: "push-outbox/manifest.json".to_owned(),
            content: "{}\n".to_owned(),
        },
    ];
    candidate.package_digest = Some(package_digest(&candidate.package_files));

    let install = install_local_skill(
        &candidate,
        &InstallLocalSkillOptions {
            destination_root: temp.path().join("skills"),
            expected_digest: None,
            trusted_manifest_keys: trusted_manifest_keys()?,
        },
    )?;

    let package_root = install.destination.parent().ok_or("missing package root")?;
    assert_eq!(
        std::fs::read_to_string(package_root.join("run.mjs"))?,
        "console.log('installed');\n"
    );
    assert_eq!(
        std::fs::read_to_string(package_root.join("context/review-rubric/SKILL.md"))?,
        "---\nname: review-rubric\n---\n# Review\n"
    );
    assert_eq!(
        std::fs::read_to_string(package_root.join("references/operator.md"))?,
        "# Operator\n"
    );
    assert_eq!(
        std::fs::read_to_string(package_root.join("graph/stage/X.yaml"))?,
        "skill: stage\n"
    );
    assert_eq!(
        std::fs::read_to_string(package_root.join("push-outbox/manifest.json"))?,
        "{}\n"
    );

    let mut tampered = candidate;
    tampered.package_digest = Some("sha256:not-the-package".to_owned());
    let error = install_error(&tampered, temp.path())?;
    assert!(matches!(error, InstallError::PackageDigestMismatch { .. }));
    Ok(())
}

#[test]
fn tampered_content_fails_against_signed_manifest() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut candidate = install_candidate()?;
    candidate.markdown = candidate.markdown.replace("Echo", "Tampered");

    let error = install_error(&candidate, temp.path())?;

    assert!(matches!(error, InstallError::DigestMismatch { .. }));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn unsigned_candidate_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut candidate = install_candidate()?;
    candidate.signed_manifest = None;

    let error = install_error(&candidate, temp.path())?;

    assert!(matches!(error, InstallError::UnsignedManifest(_)));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn mismatched_manifest_identity_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut candidate = install_candidate()?;
    candidate.signed_manifest = Some(signed_manifest(
        "acme/other",
        "1.0.0",
        &skill_digest(),
        Some(&profile_digest()),
        TEST_MANIFEST_OTHER_SKILL_SIGNATURE,
    ));

    let error = install_error(&candidate, temp.path())?;

    assert!(matches!(
        error,
        InstallError::ManifestIdentityMismatch { .. }
    ));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn missing_manifest_identity_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut candidate = install_candidate()?;
    candidate.skill_id = None;

    let error = install_error(&candidate, temp.path())?;

    assert!(matches!(
        error,
        InstallError::ManifestIdentityMissing {
            field: "skill_id",
            ..
        }
    ));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn unknown_manifest_key_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut candidate = install_candidate()?;
    let manifest = candidate
        .signed_manifest
        .as_mut()
        .ok_or("signed manifest missing from fixture")?;
    manifest.signer.key_id = "unknown-key".to_owned();

    let error = install_error(&candidate, temp.path())?;

    assert!(matches!(error, InstallError::UnknownManifestKey { .. }));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn invalid_manifest_signature_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut candidate = install_candidate()?;
    let manifest = candidate
        .signed_manifest
        .as_mut()
        .ok_or("signed manifest missing from fixture")?;
    manifest.signature = RegistryManifestSignature {
        alg: "ed25519".to_owned(),
        value: "base64:invalid".to_owned(),
    };

    let error = install_error(&candidate, temp.path())?;

    assert!(matches!(
        error,
        InstallError::InvalidManifestSignature { .. }
    ));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn malformed_signed_manifest_payload_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut candidate = install_candidate()?;
    let manifest = candidate
        .signed_manifest
        .as_mut()
        .ok_or("signed manifest missing from fixture")?;
    manifest.skill_id = "acme/echo\nversion=1.0.0".to_owned();

    let error = install_error(&candidate, temp.path())?;

    assert!(matches!(
        error,
        InstallError::InvalidManifestSignature { reason, .. } if reason == "malformed payload"
    ));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn registry_install_rejects_out_of_scope_manifest_key() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let candidate = install_candidate()?;
    let error = match install_local_skill(
        &candidate,
        &InstallLocalSkillOptions {
            destination_root: temp.path().join("skills"),
            expected_digest: None,
            trusted_manifest_keys: vec![TrustedRegistryManifestKey::official_from_base64(
                TEST_MANIFEST_KEY_ID.to_owned(),
                TEST_MANIFEST_PUBLIC_KEY_BASE64,
            )?],
        },
    ) {
        Ok(_) => return Err("install should fail".into()),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        InstallError::ManifestTrustScopeViolation { .. }
    ));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn registry_install_rejects_official_key_from_non_official_source()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut candidate = install_candidate()?;
    candidate.r#ref = "runx/echo@1.0.0".to_owned();
    candidate.skill_id = Some("runx/echo".to_owned());
    candidate.trust_tier = Some(TrustTier::FirstParty);
    candidate.signed_manifest = Some(signed_manifest_with_dynamic_key(
        "runx/echo",
        "1.0.0",
        &skill_digest(),
        Some(&profile_digest()),
    )?);
    let key_pair = dynamic_manifest_key_pair()?;
    let error = match install_local_skill(
        &candidate,
        &InstallLocalSkillOptions {
            destination_root: temp.path().join("skills"),
            expected_digest: None,
            trusted_manifest_keys: vec![TrustedRegistryManifestKey::official_from_base64(
                TEST_MANIFEST_KEY_ID.to_owned(),
                &STANDARD.encode(key_pair.public_key().as_ref()),
            )?],
        },
    ) {
        Ok(_) => return Err("install should fail".into()),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        InstallError::ManifestTrustScopeViolation { reason, .. }
            if reason.contains("official runx registry source")
    ));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn registry_install_rejects_third_party_key_outside_owner_namespace()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let candidate = install_candidate()?;
    let error = match install_local_skill(
        &candidate,
        &InstallLocalSkillOptions {
            destination_root: temp.path().join("skills"),
            expected_digest: None,
            trusted_manifest_keys: vec![TrustedRegistryManifestKey::from_base64(
                TEST_MANIFEST_KEY_ID.to_owned(),
                TEST_MANIFEST_PUBLIC_KEY_BASE64,
                "other".to_owned(),
                "test-registry".to_owned(),
            )?],
        },
    ) {
        Ok(_) => return Err("install should fail".into()),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        InstallError::ManifestTrustScopeViolation { reason, .. }
            if reason.contains("other/*")
    ));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

#[test]
fn registry_manifest_env_key_cannot_self_promote_to_official()
-> Result<(), Box<dyn std::error::Error>> {
    let key_pair = dynamic_manifest_key_pair()?;
    let env = [
        (
            runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID_ENV.to_owned(),
            TEST_MANIFEST_KEY_ID.to_owned(),
        ),
        (
            runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ENV.to_owned(),
            STANDARD.encode(key_pair.public_key().as_ref()),
        ),
        (
            runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_OWNER_ENV.to_owned(),
            "runx".to_owned(),
        ),
        (
            runx_runtime::registry::RUNX_REGISTRY_SOURCE_AUTHORITY_ENV.to_owned(),
            "official_runx".to_owned(),
        ),
    ]
    .into_iter()
    .collect::<BTreeMap<_, _>>();

    assert!(matches!(
        trusted_registry_manifest_keys_from_env(&env),
        Err(RegistryManifestTrustEnvError::InvalidKey)
    ));
    Ok(())
}

#[test]
fn registry_install_rejects_unsigned_or_mismatched_trust_tier()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let mut unsigned = install_candidate()?;
    unsigned.signed_manifest = None;
    let unsigned_error = install_error(&unsigned, temp.path())?;
    assert!(matches!(unsigned_error, InstallError::UnsignedManifest(_)));

    let temp = tempdir()?;
    let mut first_party = install_candidate()?;
    first_party.trust_tier = Some(TrustTier::FirstParty);
    let tier_error = install_error(&first_party, temp.path())?;
    assert!(matches!(
        tier_error,
        InstallError::ManifestTrustScopeViolation { .. }
    ));
    assert!(!temp.path().join("skills").exists());
    Ok(())
}

fn install_error(
    candidate: &InstallCandidate,
    temp_path: &std::path::Path,
) -> Result<InstallError, Box<dyn std::error::Error>> {
    match install_local_skill(
        candidate,
        &InstallLocalSkillOptions {
            destination_root: temp_path.join("skills"),
            expected_digest: None,
            trusted_manifest_keys: trusted_manifest_keys()?,
        },
    ) {
        Ok(_) => Err("install should fail".into()),
        Err(error) => Ok(error),
    }
}

fn install_candidate() -> Result<InstallCandidate, Box<dyn std::error::Error>> {
    Ok(InstallCandidate {
        markdown: include_str!("../../../fixtures/registry/install/echo-SKILL.md").to_owned(),
        profile_document: Some(
            include_str!("../../../fixtures/registry/install/echo-X.yaml").to_owned(),
        ),
        package_files: Vec::new(),
        package_digest: None,
        source: "runx-registry".to_owned(),
        source_label: "runx registry".to_owned(),
        r#ref: "acme/echo@1.0.0".to_owned(),
        skill_id: Some("acme/echo".to_owned()),
        version: Some("1.0.0".to_owned()),
        signed_manifest: Some(signed_manifest(
            "acme/echo",
            "1.0.0",
            &skill_digest(),
            Some(&profile_digest()),
            TEST_MANIFEST_SIGNATURE,
        )),
        profile_digest: None,
        runner_names: vec!["default".to_owned()],
        trust_tier: Some(TrustTier::Community),
        manifest_source_authority: Some(RegistryManifestSourceAuthority::RegistrySource(
            "test-registry".to_owned(),
        )),
    })
}

fn skill_digest() -> String {
    sha256_prefixed(include_str!("../../../fixtures/registry/install/echo-SKILL.md").as_bytes())
}

fn profile_digest() -> String {
    sha256_prefixed(include_str!("../../../fixtures/registry/install/echo-X.yaml").as_bytes())
}

fn package_digest(files: &[RegistryPackageFile]) -> String {
    let mut sorted = files.to_vec();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    let mut canonical = String::from("{\"files\":[");
    for (index, file) in sorted.iter().enumerate() {
        if index > 0 {
            canonical.push(',');
        }
        canonical.push_str("{\"content\":");
        canonical.push_str(&serde_json::to_string(&file.content).expect("string serializes"));
        canonical.push_str(",\"path\":");
        canonical.push_str(&serde_json::to_string(&file.path).expect("string serializes"));
        canonical.push('}');
    }
    canonical.push_str("]}");
    sha256_hex(canonical.as_bytes())
}

fn trusted_manifest_keys() -> Result<Vec<TrustedRegistryManifestKey>, Box<dyn std::error::Error>> {
    Ok(vec![TrustedRegistryManifestKey::from_base64(
        TEST_MANIFEST_KEY_ID.to_owned(),
        TEST_MANIFEST_PUBLIC_KEY_BASE64,
        "acme".to_owned(),
        "test-registry".to_owned(),
    )?])
}

fn signed_manifest(
    skill_id: &str,
    version: &str,
    digest: &str,
    profile_digest: Option<&str>,
    signature: &str,
) -> RegistrySignedManifest {
    RegistrySignedManifest {
        schema: runx_runtime::registry::REGISTRY_SIGNED_MANIFEST_SCHEMA.to_owned(),
        skill_id: skill_id.to_owned(),
        version: version.to_owned(),
        digest: digest.to_owned(),
        profile_digest: profile_digest.map(str::to_owned),
        signer: RegistryManifestSigner {
            id: TEST_MANIFEST_SIGNER_ID.to_owned(),
            key_id: TEST_MANIFEST_KEY_ID.to_owned(),
        },
        signature: RegistryManifestSignature {
            alg: "ed25519".to_owned(),
            value: signature.to_owned(),
        },
    }
}

fn signed_manifest_with_dynamic_key(
    skill_id: &str,
    version: &str,
    digest: &str,
    profile_digest: Option<&str>,
) -> Result<RegistrySignedManifest, Box<dyn std::error::Error>> {
    let payload = registry_manifest_payload(skill_id, version, digest, profile_digest);
    let signature = dynamic_manifest_key_pair()?.sign(payload.as_bytes());
    Ok(signed_manifest(
        skill_id,
        version,
        digest,
        profile_digest,
        &format!("base64:{}", URL_SAFE_NO_PAD.encode(signature.as_ref())),
    ))
}

fn registry_manifest_payload(
    skill_id: &str,
    version: &str,
    digest: &str,
    profile_digest: Option<&str>,
) -> String {
    format!(
        "{}\nskill_id={skill_id}\nversion={version}\ndigest={digest}\nprofile_digest={}\nsigner_id={TEST_MANIFEST_SIGNER_ID}\nkey_id={TEST_MANIFEST_KEY_ID}\n",
        runx_runtime::registry::REGISTRY_SIGNED_MANIFEST_SCHEMA,
        profile_digest.unwrap_or("")
    )
}

fn dynamic_manifest_key_pair() -> Result<ring::signature::Ed25519KeyPair, std::io::Error> {
    ring::signature::Ed25519KeyPair::from_seed_unchecked(&DYNAMIC_MANIFEST_SEED).map_err(|error| {
        std::io::Error::other(format!(
            "dynamic registry manifest seed rejected: {error:?}"
        ))
    })
}
