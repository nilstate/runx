use std::collections::BTreeMap;
use std::path::PathBuf;

use runx_contracts::JsonObject;
pub use runx_contracts::{
    DevFixtureAssertion, DevFixtureAssertionKind, DevFixtureResult, DevFixtureStatus, DevReport,
    DevReportSchema, DevReportStatus,
};
use runx_parser::{DevFixture, DevFixtureLane, DevFixtureTarget};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevLoopOptions {
    pub root: PathBuf,
    pub unit_path: Option<PathBuf>,
    /// A specific fixture lane, or `None` to run every lane.
    pub lane: Option<DevFixtureLane>,
    /// Immutable workspace environment admitted by the caller. Dev fixtures
    /// may overlay their declared values, but must never re-read process state.
    pub env: BTreeMap<String, String>,
}

impl DevLoopOptions {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            unit_path: None,
            lane: Some(DevFixtureLane::Deterministic),
            env: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoadedDevFixture {
    pub path: PathBuf,
    pub definition: DevFixture,
}

impl LoadedDevFixture {
    #[must_use]
    pub fn name(&self) -> &str {
        &self.definition.name
    }

    #[must_use]
    pub const fn lane(&self) -> DevFixtureLane {
        self.definition.lane
    }

    #[must_use]
    pub fn target(&self) -> &DevFixtureTarget {
        &self.definition.target
    }

    #[must_use]
    pub fn target_json(&self) -> JsonObject {
        self.definition.target.to_json_object()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevFixtureExecutionRoots {
    pub cwd: PathBuf,
    pub repo_root: PathBuf,
}

#[derive(Clone, Debug)]
pub struct PreparedDevFixtureWorkspace {
    pub root: Option<PathBuf>,
    pub tokens: BTreeMap<String, String>,
}

#[derive(Debug, Error)]
pub enum DevError {
    #[error("failed to read dev fixture {path}: {source}")]
    ReadFixture {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse dev fixture {path}: {source}")]
    ParseFixture {
        path: PathBuf,
        #[source]
        source: runx_parser::DevFixtureError,
    },
    #[error("failed to read {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse JSON at {path}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("dev fixture workspace path must be relative: {path}")]
    AbsoluteWorkspacePath { path: String },
    #[error("dev fixture workspace path escapes root: {path}")]
    EscapingWorkspacePath { path: String },
    #[error("failed to run fixture command {command}: {source}")]
    Spawn {
        command: String,
        #[source]
        source: std::io::Error,
    },
    #[error("dev fixture command `{command}` failed with status {status}: {output}")]
    FixtureCommand {
        command: String,
        status: i32,
        output: String,
    },
    #[error(transparent)]
    Runtime(#[from] crate::RuntimeError),
}

pub trait DevFixtureExecutor {
    fn run_fixture(
        &self,
        root: &std::path::Path,
        fixture: &LoadedDevFixture,
    ) -> Result<DevFixtureResult, DevError>;
}

#[derive(Clone, Debug, Default)]
pub struct LocalDevFixtureExecutor {
    pub(crate) env: BTreeMap<String, String>,
}
