pub(super) use runx_contracts::GitBlobDigest;
use runx_contracts::{JsonObject, JsonValue};
use serde::{Deserialize, Serialize};

use crate::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, CapabilityOutput,
};

use super::super::capability::{NativeCapability, TypedNativeCapability};

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct GitInput {
    pub(super) repo_root: String,
}

impl CapabilityInput for GitInput {
    fn defaults() -> JsonObject {
        JsonObject::from([("repo_root".to_owned(), JsonValue::String(".".to_owned()))])
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct GitDiffInput {
    pub(super) repo_root: String,
    pub(super) base: String,
}

impl CapabilityInput for GitDiffInput {
    fn defaults() -> JsonObject {
        JsonObject::from([
            ("repo_root".to_owned(), JsonValue::String(".".to_owned())),
            ("base".to_owned(), JsonValue::String("HEAD".to_owned())),
        ])
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct GitBlobDigestInput {
    pub(super) contents: String,
}

impl CapabilityInput for GitBlobDigestInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct GitBranchOutput {
    pub(super) repo_root: String,
    pub(super) branch: String,
    pub(super) detached: bool,
}

impl CapabilityOutput for GitBranchOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct GitStatusOutput {
    pub(super) repo_root: String,
    pub(super) clean: bool,
    pub(super) entries: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) branch: Option<String>,
}

impl CapabilityOutput for GitStatusOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct GitDiffOutput {
    pub(super) repo_root: String,
    pub(super) base: String,
    pub(super) files: Vec<String>,
}

impl CapabilityOutput for GitDiffOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct GitBlobDigestOutput {
    pub(super) git_blob_digest: GitBlobDigest,
}

impl CapabilityOutput for GitBlobDigestOutput {}

const ROOT_FIELDS: &[CapabilityField] = &[CapabilityField {
    name: "repo_root",
    description: "Workspace-relative Git repository root.",
}];

const DIFF_FIELDS: &[CapabilityField] = &[
    CapabilityField {
        name: "repo_root",
        description: "Workspace-relative Git repository root.",
    },
    CapabilityField {
        name: "base",
        description: "Verified Git ref or commit to compare against.",
    },
];

const BLOB_FIELDS: &[CapabilityField] = &[CapabilityField {
    name: "contents",
    description: "Exact UTF-8 blob contents to bind to Git's canonical blob identity.",
}];

static CURRENT_BRANCH: TypedNativeCapability<GitInput, GitBranchOutput> =
    TypedNativeCapability::new(
        CapabilityDefinition {
            id: "git.current_branch",
            owner: "runx-runtime/git",
            summary: "Read the current branch or detached HEAD through native process supervision.",
            scopes: &["git.read"],
            effect: CapabilityEffect::Read,
            approval: CapabilityApproval::None,
            artifacts: CapabilityArtifacts::Wrapped {
                output: "git_branch",
                packet: "runx.git.branch.v1",
            },
            admission: CapabilityAdmission::ReusedBy(&["release", "issue-to-pr"]),
            fields: ROOT_FIELDS,
        },
        super::current_branch,
    );

static STATUS: TypedNativeCapability<GitInput, GitStatusOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: "git.status",
        owner: "runx-runtime/git",
        summary: "Read bounded porcelain working-tree status without hooks, pagers, or locks.",
        scopes: &["git.read"],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Wrapped {
            output: "git_status",
            packet: "runx.git.status.v1",
        },
        admission: CapabilityAdmission::ReusedBy(&["release", "skill-lab"]),
        fields: ROOT_FIELDS,
    },
    super::status,
);

static DIFF: TypedNativeCapability<GitDiffInput, GitDiffOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: "git.diff_name_only",
        owner: "runx-runtime/git",
        summary: "List changed paths against one verified Git commit without external drivers.",
        scopes: &["git.read"],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Wrapped {
            output: "git_diff",
            packet: "runx.git.diff.v1",
        },
        admission: CapabilityAdmission::ReusedBy(&["release", "issue-to-pr"]),
        fields: DIFF_FIELDS,
    },
    super::diff_name_only,
);

static BLOB_DIGEST: TypedNativeCapability<GitBlobDigestInput, GitBlobDigestOutput> =
    TypedNativeCapability::new(
        CapabilityDefinition {
            id: "git.blob_digest",
            owner: "runx-runtime/git",
            summary: "Compute the canonical Git blob SHA-1 for exact UTF-8 contents.",
            scopes: &[],
            effect: CapabilityEffect::Read,
            approval: CapabilityApproval::None,
            artifacts: CapabilityArtifacts::Named {
                output: "git_blob_digest",
                packet: "runx.git.blob_digest.v1",
            },
            admission: CapabilityAdmission::RuntimeInvariant(
                "pinned Git source identity must use Git's canonical blob encoding",
            ),
            fields: BLOB_FIELDS,
        },
        super::blob_digest,
    );

pub(in crate::tool_catalogs::native) const CAPABILITIES: &[&dyn NativeCapability] =
    &[&CURRENT_BRANCH, &STATUS, &DIFF, &BLOB_DIGEST];
