use std::collections::BTreeMap;
use std::path::Path;

use runx_contracts::Receipt;
#[cfg(feature = "cli-tool")]
use runx_runtime::RuntimeOptions;
use runx_runtime::{
    LocalReceiptStore, RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV,
    RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV, RUNX_RECEIPT_SIGN_KID_ENV, RuntimeReceiptSignatureConfig,
};

#[cfg(feature = "cli-tool")]
pub(crate) const TEST_CREATED_AT: &str = "2026-05-18T00:00:00Z";
pub(crate) const TEST_SIGNING_KID: &str = "runx-runtime-prod-fixture-key";
pub(crate) const TEST_SIGNING_SEED_BASE64: &str = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
pub(crate) const TEST_SIGNING_ISSUER_TYPE: &str = "hosted";

pub(crate) fn test_signing_env() -> BTreeMap<String, String> {
    [
        (
            RUNX_RECEIPT_SIGN_KID_ENV.to_owned(),
            TEST_SIGNING_KID.to_owned(),
        ),
        (
            RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV.to_owned(),
            TEST_SIGNING_SEED_BASE64.to_owned(),
        ),
        (
            RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV.to_owned(),
            TEST_SIGNING_ISSUER_TYPE.to_owned(),
        ),
    ]
    .into_iter()
    .collect()
}

pub(crate) fn insert_test_signing_env(env: &mut BTreeMap<String, String>) {
    for (key, value) in test_signing_env() {
        env.entry(key).or_insert(value);
    }
}

pub(crate) fn test_signature_config()
-> Result<RuntimeReceiptSignatureConfig, Box<dyn std::error::Error>> {
    Ok(RuntimeReceiptSignatureConfig::from_env(&test_signing_env())?)
}

#[cfg(feature = "cli-tool")]
pub(crate) fn signed_runtime_options() -> Result<RuntimeOptions, runx_runtime::RuntimeError> {
    let mut env = RuntimeOptions::local_development().env;
    insert_test_signing_env(&mut env);
    RuntimeOptions::from_env(env)
}

#[cfg(feature = "cli-tool")]
pub(crate) fn local_harness_runtime_options() -> RuntimeOptions {
    RuntimeOptions {
        created_at: TEST_CREATED_AT.to_owned(),
        ..RuntimeOptions::local_development()
    }
}

pub(crate) fn read_test_signed_receipt(
    receipt_dir: &Path,
    receipt_id: &str,
) -> Result<Receipt, Box<dyn std::error::Error>> {
    let signature_config = test_signature_config()?;
    Ok(LocalReceiptStore::new(receipt_dir)
        .read_exact_with_policy(receipt_id, signature_config.signature_policy())?)
}

/// Waits for a descendant process to die, given a file the descendant wrote its
/// own pid into at startup: the pid file must appear and `kill(pid, 0)` must then
/// report ESRCH, all within `deadline`. Kill-the-descendants tests poll this
/// instead of sleeping a fixed window before asserting the descendant's sentinel
/// was never written.
#[cfg(unix)]
pub(crate) fn wait_for_recorded_pid_exit(
    pid_path: &Path,
    deadline: std::time::Duration,
) -> Result<(), Box<dyn std::error::Error>> {
    let poll = std::time::Duration::from_millis(10);
    let started = std::time::Instant::now();
    let pid = loop {
        match std::fs::read_to_string(pid_path) {
            Ok(raw) if !raw.trim().is_empty() => break raw.trim().parse::<i32>()?,
            _ if started.elapsed() >= deadline => {
                return Err(format!(
                    "descendant never recorded its pid at {}",
                    pid_path.display()
                )
                .into());
            }
            _ => std::thread::sleep(poll),
        }
    };
    wait_for_pid_exit(pid, deadline.saturating_sub(started.elapsed()))
}

/// Polls `kill(pid, 0)` until it reports ESRCH, failing if the process is
/// still alive at `deadline`.
#[cfg(unix)]
pub(crate) fn wait_for_pid_exit(
    pid: i32,
    deadline: std::time::Duration,
) -> Result<(), Box<dyn std::error::Error>> {
    let poll = std::time::Duration::from_millis(10);
    let started = std::time::Instant::now();
    let pid = rustix::process::Pid::from_raw(pid).ok_or("invalid pid to wait on")?;
    loop {
        if matches!(
            rustix::process::test_kill_process(pid),
            Err(rustix::io::Errno::SRCH)
        ) {
            return Ok(());
        }
        if started.elapsed() >= deadline {
            return Err(format!("process {pid:?} still alive after {deadline:?}").into());
        }
        std::thread::sleep(poll);
    }
}
