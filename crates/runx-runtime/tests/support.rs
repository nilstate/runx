use std::collections::BTreeMap;
use std::fs;
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

pub(crate) fn write_test_skill_package(
    dir: &Path,
    manual: &str,
    profile: &str,
) -> Result<(), std::io::Error> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join("SKILL.md"), manual)?;
    fs::write(dir.join("X.yaml"), profile)
}

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
    let mut env = std::env::vars().collect();
    insert_test_signing_env(&mut env);
    RuntimeOptions::from_env(env)
}

#[cfg(feature = "cli-tool")]
pub(crate) fn local_harness_runtime_options() -> RuntimeOptions {
    RuntimeOptions {
        created_at: TEST_CREATED_AT.to_owned(),
        ..RuntimeOptions::local_development(std::env::vars().collect())
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

/// Waits for a descendant process to die from its recorded `pid [start_time]`.
///
/// Linux fixtures include `/proc/self/stat` start time so a busy concurrent test
/// run cannot mistake rapid PID reuse for a surviving descendant. Older
/// pid-only fixtures retain the ESRCH/zombie check.
#[cfg(all(unix, feature = "thread-outbox-provider"))]
pub(crate) fn wait_for_recorded_pid_exit(
    pid_path: &Path,
    deadline: std::time::Duration,
) -> Result<(), Box<dyn std::error::Error>> {
    let poll = std::time::Duration::from_millis(10);
    let started = std::time::Instant::now();
    let (pid, started_at) = loop {
        match std::fs::read_to_string(pid_path) {
            Ok(raw) if !raw.trim().is_empty() => {
                let mut fields = raw.split_whitespace();
                let pid = fields
                    .next()
                    .ok_or("recorded process identity missing pid")?;
                let started_at = fields.next().map(str::parse).transpose()?;
                break (pid.parse::<i32>()?, started_at);
            }
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
    wait_for_process_exit(pid, started_at, deadline.saturating_sub(started.elapsed()))
}

/// Polls until the process can no longer execute.
///
/// Linux can briefly retain a killed orphan as a zombie when the container's
/// PID 1 has not reaped it yet. A zombie cannot run or write the sentinel the
/// process-tree lifecycle tests protect, so it is terminal even though `kill(pid, 0)`
/// continues to resolve the PID.
#[cfg(all(unix, feature = "mcp"))]
pub(crate) fn wait_for_pid_exit(
    pid: i32,
    deadline: std::time::Duration,
) -> Result<(), Box<dyn std::error::Error>> {
    wait_for_process_exit(pid, None, deadline)
}

#[cfg(all(unix, any(feature = "mcp", feature = "thread-outbox-provider")))]
fn wait_for_process_exit(
    pid: i32,
    started_at: Option<u64>,
    deadline: std::time::Duration,
) -> Result<(), Box<dyn std::error::Error>> {
    let poll = std::time::Duration::from_millis(10);
    let started = std::time::Instant::now();
    let pid = rustix::process::Pid::from_raw(pid).ok_or("invalid pid to wait on")?;
    loop {
        if matches!(
            rustix::process::test_kill_process(pid),
            Err(rustix::io::Errno::SRCH)
        ) || process_is_terminal(pid.as_raw_nonzero().get())
            || started_at.is_some_and(|expected| {
                process_start_time(pid.as_raw_nonzero().get())
                    .is_some_and(|actual| actual != expected)
            })
        {
            return Ok(());
        }
        if started.elapsed() >= deadline {
            return Err(format!("process {pid:?} still alive after {deadline:?}").into());
        }
        std::thread::sleep(poll);
    }
}

#[cfg(all(unix, any(feature = "mcp", feature = "thread-outbox-provider")))]
fn process_start_time(pid: i32) -> Option<u64> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let path = format!("/proc/{pid}/stat");
        std::fs::read_to_string(path).ok().and_then(|stat| {
            let (_, tail) = stat.rsplit_once(") ")?;
            tail.split_whitespace().nth(19)?.parse().ok()
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(all(unix, any(feature = "mcp", feature = "thread-outbox-provider")))]
fn process_is_terminal(pid: i32) -> bool {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let path = format!("/proc/{pid}/stat");
        std::fs::read_to_string(path)
            .ok()
            .and_then(|stat| stat.rsplit_once(") ").map(|(_, tail)| tail.to_owned()))
            .and_then(|tail| tail.chars().next())
            .is_some_and(|state| matches!(state, 'Z' | 'X'))
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let _ = pid;
        false
    }
}
