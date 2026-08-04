use std::io::{self, Write};
use std::process::ExitCode;

pub(crate) fn write_stdout(message: &str) -> io::Result<()> {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    handle.write_all(message.as_bytes())
}

pub(crate) fn write_stdout_code(message: &str, exit_code: u8) -> ExitCode {
    if write_stdout(message).is_ok() {
        ExitCode::from(exit_code)
    } else {
        ExitCode::from(1)
    }
}

pub(crate) fn write_stderr(message: &str) -> io::Result<()> {
    io::stderr().write_all(message.as_bytes())
}

pub(crate) fn write_stderr_code(message: &str) -> ExitCode {
    if write_stderr(message).is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
