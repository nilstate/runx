use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use runx_contracts::{JsonObject, JsonValue, ProviderOperationPacket, sha256_prefixed};

use super::ProviderNativeAccess;
use crate::process::{ProcessSpec, ProcessStdin, run_process};
use crate::process_invocation::process_base_environment;

const GITHUB_PROVIDER: &str = "github";
const GH_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;
const GH_TIMEOUT: Duration = Duration::from_secs(20);
const GIT_OUTPUT_LIMIT_BYTES: usize = 16 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const PREFLIGHT_QUERY: &str = r#"query RunxProviderPreflight($owner: String!, $name: String!) {
  viewer { id login }
  repository(owner: $owner, name: $name) { nameWithOwner viewerPermission }
}"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ResolvedGithubTarget {
    pub(super) host: String,
    pub(super) repository: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LocalGithubBinding {
    pub(super) host: String,
    pub(super) repository: String,
    pub(super) login: String,
    account_id: String,
    permission: String,
}

impl LocalGithubBinding {
    #[cfg(feature = "catalog")]
    pub(super) fn grant_id(&self) -> String {
        format!("local-github:{}:{}", self.host, self.login)
    }

    pub(super) fn principal_ref(&self) -> String {
        format!(
            "runx:principal:github:{}:{}:{}",
            self.host, self.login, self.account_id
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GithubOperation {
    IssueRead,
    IssuesRead,
    IssuesWrite,
    PullRequestsRead,
    PullRequestsWrite,
    PullRequestOpen,
    PullRequestPublish,
    PullRequestRead,
    ThreadsRead,
    ThreadsWrite,
    PullRequestComment,
    PullRequestCommentRead,
    SyncRead,
    SyncWriteBatch,
}

impl GithubOperation {
    fn parse(operation: &str) -> Result<Self, LocalGithubError> {
        match operation {
            "issue.read" => Ok(Self::IssueRead),
            "issues.read" => Ok(Self::IssuesRead),
            "issues.write" => Ok(Self::IssuesWrite),
            "pullrequests.read" | "pull_requests.read" => Ok(Self::PullRequestsRead),
            "pullrequests.write" | "pull_requests.write" => Ok(Self::PullRequestsWrite),
            "pullrequest.open" => Ok(Self::PullRequestOpen),
            "pullrequest.publish" => Ok(Self::PullRequestPublish),
            "pullrequest.read" => Ok(Self::PullRequestRead),
            "threads.read" => Ok(Self::ThreadsRead),
            "threads.write" => Ok(Self::ThreadsWrite),
            "pullrequest.comment" => Ok(Self::PullRequestComment),
            "pullrequest.comment.read" => Ok(Self::PullRequestCommentRead),
            "sync.read" => Ok(Self::SyncRead),
            "sync.write_batch" => Ok(Self::SyncWriteBatch),
            _ => Err(LocalGithubError::new(format!(
                "local GitHub does not support provider operation {operation:?}"
            ))),
        }
    }

    fn access(self) -> ProviderNativeAccess {
        match self {
            Self::IssueRead
            | Self::IssuesRead
            | Self::PullRequestsRead
            | Self::PullRequestRead
            | Self::ThreadsRead
            | Self::PullRequestCommentRead
            | Self::SyncRead => ProviderNativeAccess::Read,
            Self::IssuesWrite
            | Self::PullRequestsWrite
            | Self::PullRequestOpen
            | Self::PullRequestPublish
            | Self::ThreadsWrite
            | Self::PullRequestComment
            | Self::SyncWriteBatch => ProviderNativeAccess::Mutate,
        }
    }

    fn permits_scope(self, scope: &str) -> bool {
        match self {
            Self::IssueRead | Self::IssuesRead | Self::SyncRead => scope == "repo.read",
            Self::IssuesWrite => scope == "repo.write",
            Self::PullRequestsRead | Self::PullRequestRead | Self::PullRequestCommentRead => {
                matches!(scope, "repo.read" | "pr.read")
            }
            Self::PullRequestsWrite | Self::PullRequestOpen | Self::PullRequestPublish => {
                matches!(scope, "repo.write" | "pr.write")
            }
            Self::ThreadsRead => matches!(scope, "repo.read" | "pr.read"),
            Self::ThreadsWrite => matches!(scope, "repo.write" | "pr.comment"),
            Self::PullRequestComment => scope == "pr.comment",
            Self::SyncWriteBatch => scope == "repo.write",
        }
    }
}

#[cfg(feature = "catalog")]
pub(super) fn mutation_is_replay_safe(operation: &str) -> Result<bool, LocalGithubError> {
    Ok(matches!(
        GithubOperation::parse(operation)?,
        GithubOperation::IssuesWrite
            | GithubOperation::PullRequestsWrite
            | GithubOperation::PullRequestPublish
    ))
}

#[derive(Debug)]
pub(super) struct LocalGithubError {
    message: String,
}

impl LocalGithubError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for LocalGithubError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for LocalGithubError {}

pub(super) fn resolve_target(
    env: &BTreeMap<String, String>,
    fallback: &Path,
    requested: &str,
) -> Result<ResolvedGithubTarget, LocalGithubError> {
    let requested = requested.trim();
    if matches!(requested, "." | "checkout" | "current") {
        let workspace = crate::config::resolve_runx_workspace_base(env, fallback);
        let remote = git_remote_origin(env, &workspace)?;
        return parse_github_remote(&remote);
    }
    let repository = validate_repository(requested)?;
    let host = env
        .get("GH_HOST")
        .map(String::as_str)
        .unwrap_or("github.com");
    Ok(ResolvedGithubTarget {
        host: validate_host(host)?,
        repository,
    })
}

pub(super) fn preflight(
    env: &BTreeMap<String, String>,
    fallback: &Path,
    operation: &str,
    access: ProviderNativeAccess,
    requested_target: &str,
    required_scopes: &[String],
) -> Result<LocalGithubBinding, LocalGithubError> {
    let target = resolve_target(env, fallback, requested_target)?;
    preflight_resolved(env, fallback, operation, access, target, required_scopes)
}

pub(super) fn preflight_resolved(
    env: &BTreeMap<String, String>,
    fallback: &Path,
    operation: &str,
    access: ProviderNativeAccess,
    target: ResolvedGithubTarget,
    required_scopes: &[String],
) -> Result<LocalGithubBinding, LocalGithubError> {
    validate_operation(operation, access, required_scopes)?;
    let (owner, name) = repository_parts(&target.repository)?;
    let body = serde_json::to_vec(&serde_json::json!({
        "query": PREFLIGHT_QUERY,
        "variables": {"owner": owner, "name": name}
    }))
    .map_err(|error| LocalGithubError::new(format!("encoding GitHub preflight: {error}")))?;
    let response = run_gh_json(
        env,
        fallback,
        vec![
            "api".to_owned(),
            "--hostname".to_owned(),
            target.host.clone(),
            "graphql".to_owned(),
            "--input".to_owned(),
            "-".to_owned(),
        ],
        Some(body),
        "GitHub identity and repository preflight",
    )?;
    let data = value_field(&response, "data")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| LocalGithubError::new("gh returned no GitHub preflight data"))?;
    let viewer = data
        .get("viewer")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| {
            LocalGithubError::new("gh is not authenticated; run `gh auth login` and retry")
        })?;
    let repository = data
        .get("repository")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| {
            LocalGithubError::new(format!(
                "the active gh account cannot access repository {}",
                target.repository
            ))
        })?;
    let login = required_string(viewer, "login", "GitHub viewer login")?;
    let account_id = required_string(viewer, "id", "GitHub viewer id")?;
    let canonical_repository =
        required_string(repository, "nameWithOwner", "GitHub repository identity")?;
    if !canonical_repository.eq_ignore_ascii_case(&target.repository) {
        return Err(LocalGithubError::new(format!(
            "gh resolved repository {canonical_repository:?}, not requested repository {:?}",
            target.repository
        )));
    }
    let permission = required_string(
        repository,
        "viewerPermission",
        "GitHub repository permission",
    )?;
    let binding = LocalGithubBinding {
        host: target.host,
        repository: canonical_repository,
        login,
        account_id,
        permission,
    };
    validate_binding_access(&binding, access)?;
    Ok(binding)
}

#[cfg(feature = "catalog")]
pub(super) fn validate_cached_binding(
    binding: LocalGithubBinding,
    operation: &str,
    access: ProviderNativeAccess,
    required_scopes: &[String],
) -> Result<LocalGithubBinding, LocalGithubError> {
    validate_operation(operation, access, required_scopes)?;
    validate_binding_access(&binding, access)?;
    Ok(binding)
}

fn validate_operation(
    operation: &str,
    access: ProviderNativeAccess,
    required_scopes: &[String],
) -> Result<(), LocalGithubError> {
    let operation = GithubOperation::parse(operation)?;
    if operation.access() != access {
        return Err(LocalGithubError::new(
            "local GitHub operation access does not match provider.read/provider.mutate",
        ));
    }
    if let Some(scope) = required_scopes
        .iter()
        .find(|scope| !operation.permits_scope(scope))
    {
        return Err(LocalGithubError::new(format!(
            "local GitHub operation does not admit required scope {scope:?}"
        )));
    }
    Ok(())
}

fn validate_binding_access(
    binding: &LocalGithubBinding,
    access: ProviderNativeAccess,
) -> Result<(), LocalGithubError> {
    if access == ProviderNativeAccess::Mutate
        && !matches!(binding.permission.as_str(), "WRITE" | "MAINTAIN" | "ADMIN")
    {
        return Err(LocalGithubError::new(format!(
            "the active gh account has {} permission for {}; write access is required",
            binding.permission, binding.repository
        )));
    }
    Ok(())
}

pub(super) fn invoke(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    operation_name: &str,
    access: ProviderNativeAccess,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let operation = GithubOperation::parse(operation_name)?;
    if operation.access() != access {
        return Err(LocalGithubError::new(
            "admitted local GitHub operation changed access class before execution",
        ));
    }
    if access == ProviderNativeAccess::Mutate {
        // Validate all mutation-wide requirements before dispatching any
        // provider request. A missing idempotency key must never be learned
        // after a remote write has already happened.
        required_string(input, "idempotency_key", "idempotency key")?;
    }
    let result = match operation {
        GithubOperation::IssueRead => read_issue(env, cwd, binding, input)?,
        GithubOperation::IssuesRead => read_issues(env, cwd, binding, input)?,
        GithubOperation::PullRequestsRead => read_pull_requests(env, cwd, binding, input)?,
        GithubOperation::PullRequestRead => read_pull_request(env, cwd, binding, input)?,
        GithubOperation::ThreadsRead => read_threads(env, cwd, binding, input)?,
        GithubOperation::IssuesWrite => mutate_issue(env, cwd, binding, input)?,
        GithubOperation::PullRequestsWrite => mutate_pull_request(env, cwd, binding, input)?,
        GithubOperation::PullRequestOpen => open_pull_request(env, cwd, binding, input)?,
        GithubOperation::PullRequestPublish => publish_pull_request(env, cwd, binding, input)?,
        GithubOperation::ThreadsWrite => mutate_thread(env, cwd, binding, input)?,
        GithubOperation::PullRequestComment => comment_on_pull_request(env, cwd, binding, input)?,
        GithubOperation::PullRequestCommentRead => {
            read_pull_request_comment(env, cwd, binding, input)?
        }
        GithubOperation::SyncRead => read_sync_result(env, cwd, binding, input)?,
        GithubOperation::SyncWriteBatch => sync_write_batch(env, cwd, binding, input)?,
    };
    let readback_digest = sha256_prefixed(
        &serde_json::to_vec(&result)
            .map_err(|error| LocalGithubError::new(format!("encoding GitHub result: {error}")))?,
    );
    let (idempotency_key, operation_id) = if access == ProviderNativeAccess::Mutate {
        (
            Some(required_string(input, "idempotency_key", "idempotency key")?.to_owned()),
            Some(local_operation_id(operation, input, &result)?),
        )
    } else {
        (None, None)
    };
    let packet = ProviderOperationPacket {
        schema: "runx.provider.operation.v1".to_owned(),
        status: "success".to_owned(),
        provider: GITHUB_PROVIDER.to_owned(),
        operation: operation_name.to_owned(),
        target: binding.repository.clone(),
        result: JsonValue::Object(result),
        transport: "local_github".to_owned(),
        readback_ref: format!("runx:github-readback:{readback_digest}"),
        access: None,
        principal_ref: None,
        grant_ref: None,
        finality: None,
        plan_digest: None,
        result_digest: None,
        operation_id,
        idempotency_key,
        host: Some(binding.host.clone()),
        account_ref: Some(binding.principal_ref()),
    };
    let packet_value: JsonValue =
        serde_json::from_value(serde_json::to_value(packet).map_err(|error| {
            LocalGithubError::new(format!("encoding GitHub provider packet: {error}"))
        })?)
        .map_err(|error| {
            LocalGithubError::new(format!("projecting GitHub provider packet: {error}"))
        })?;
    packet_value
        .as_object()
        .cloned()
        .ok_or_else(|| LocalGithubError::new("GitHub provider packet is not an object"))
}

fn read_issue(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let number = issue_number(input, "issue_number")?;
    let issue = github_api_get(
        env,
        cwd,
        binding,
        &format!("repos/{}/issues/{number}", binding.repository),
        "GitHub issue read",
    )?;
    normalize_issue(&issue, &binding.repository)
}

#[derive(Clone, Copy)]
enum ResourceCollectionKind {
    Issues,
    PullRequests,
}

fn read_exact_collection_refs(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    refs: &[JsonValue],
    kind: ResourceCollectionKind,
    include_body: bool,
) -> Result<Option<Vec<JsonValue>>, LocalGithubError> {
    if refs.is_empty() {
        return Ok(None);
    }
    if refs.len() > 100 {
        return Err(LocalGithubError::new(
            "GitHub collection refs exceed the declared limit",
        ));
    }
    let (prefix, label) = match kind {
        ResourceCollectionKind::Issues => ("issues/", "issue"),
        ResourceCollectionKind::PullRequests => ("pulls/", "pull-request"),
    };
    let mut items = Vec::with_capacity(refs.len());
    for reference in refs {
        let reference = reference
            .as_str()
            .ok_or_else(|| LocalGithubError::new(format!("GitHub {label} ref must be a string")))?;
        let number = reference
            .strip_prefix(prefix)
            .ok_or_else(|| {
                LocalGithubError::new(format!("GitHub {label} ref must be {prefix}<number>"))
            })
            .and_then(|number| safe_number(number, &format!("{label} number")))?;
        let path_kind = match kind {
            ResourceCollectionKind::Issues => "issues",
            ResourceCollectionKind::PullRequests => "pulls",
        };
        let resource = github_api_get(
            env,
            cwd,
            binding,
            &format!("repos/{}/{path_kind}/{number}", binding.repository),
            if matches!(kind, ResourceCollectionKind::Issues) {
                "GitHub issue read"
            } else {
                "GitHub pull-request read"
            },
        )?;
        if matches!(kind, ResourceCollectionKind::Issues)
            && value_field(&resource, "pull_request").is_some()
        {
            return Err(LocalGithubError::new(format!(
                "GitHub issue ref issues/{number} targets a pull request"
            )));
        }
        let normalized = match kind {
            ResourceCollectionKind::Issues => normalize_issue(&resource, &binding.repository)?,
            ResourceCollectionKind::PullRequests => {
                normalize_pull_request(&resource, &binding.repository)?
            }
        };
        items.push(JsonValue::Object(compact_collection_item(
            normalized,
            include_body,
        )?));
    }
    Ok(Some(items))
}

fn read_issues(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let selector = input
        .get("resource_selector")
        .and_then(JsonValue::as_object)
        .unwrap_or(input);
    let filters = selector
        .get("filters")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let include_body = selector
        .get("include_body")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    if let Some(items) = read_exact_collection_refs(
        env,
        cwd,
        binding,
        selector
            .get("refs")
            .and_then(JsonValue::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        ResourceCollectionKind::Issues,
        include_body,
    )? {
        return Ok(collection_result(&binding.repository, items));
    }
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("per_page", &bounded_limit(&filters)?.to_string());
    if let Some(state) = filters.get("state").and_then(JsonValue::as_str) {
        if !matches!(state, "open" | "closed" | "all") {
            return Err(LocalGithubError::new("GitHub issue state is invalid"));
        }
        query.append_pair("state", state);
    }
    if let Some(labels) = filters.get("labels").and_then(JsonValue::as_array) {
        let labels = labels
            .iter()
            .map(|label| safe_bounded_string(label, "GitHub label", 100))
            .collect::<Result<Vec<_>, _>>()?;
        query.append_pair("labels", &labels.join(","));
    }
    let endpoint = format!("repos/{}/issues?{}", binding.repository, query.finish());
    let response = github_api_get(env, cwd, binding, &endpoint, "GitHub issues read")?;
    let items = response
        .as_array()
        .ok_or_else(|| LocalGithubError::new("gh issue list response was not an array"))?
        .iter()
        .filter(|issue| value_field(issue, "pull_request").is_none())
        .map(|issue| {
            normalize_issue(issue, &binding.repository)
                .and_then(|item| compact_collection_item(item, include_body))
                .map(JsonValue::Object)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(collection_result(&binding.repository, items))
}

fn read_pull_requests(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let selector = input
        .get("resource_selector")
        .and_then(JsonValue::as_object)
        .unwrap_or(input);
    let filters = selector
        .get("filters")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let include_body = selector
        .get("include_body")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    if let Some(items) = read_exact_collection_refs(
        env,
        cwd,
        binding,
        selector
            .get("refs")
            .and_then(JsonValue::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        ResourceCollectionKind::PullRequests,
        include_body,
    )? {
        return Ok(collection_result(&binding.repository, items));
    }
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("per_page", &bounded_limit(&filters)?.to_string());
    if let Some(state) = filters.get("state").and_then(JsonValue::as_str) {
        if !matches!(state, "open" | "closed" | "all") {
            return Err(LocalGithubError::new(
                "GitHub pull-request state is invalid",
            ));
        }
        query.append_pair("state", state);
    }
    for field in ["base", "head"] {
        if let Some(value) = filters.get(field) {
            query.append_pair(field, &safe_git_ref(value, field)?);
        }
    }
    let endpoint = format!("repos/{}/pulls?{}", binding.repository, query.finish());
    let response = github_api_get(env, cwd, binding, &endpoint, "GitHub pull requests read")?;
    let items = response
        .as_array()
        .ok_or_else(|| LocalGithubError::new("gh pull-request list response was not an array"))?
        .iter()
        .map(|pull| {
            normalize_pull_request(pull, &binding.repository)
                .and_then(|item| compact_collection_item(item, include_body))
                .map(JsonValue::Object)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(collection_result(&binding.repository, items))
}

fn read_pull_request(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let number = issue_number(input, "pull_number").or_else(|_| issue_number(input, "number"))?;
    let pull = github_api_get(
        env,
        cwd,
        binding,
        &format!("repos/{}/pulls/{number}", binding.repository),
        "GitHub pull-request read",
    )?;
    normalize_pull_request(&pull, &binding.repository)
}

fn open_pull_request(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let title = required_string(input, "title", "GitHub pull-request title")?;
    let body = required_string(input, "body", "GitHub pull-request body")?;
    if title.len() > 256 || body.len() > 65_536 || title.contains('\0') || body.contains('\0') {
        return Err(LocalGithubError::new(
            "GitHub pull-request title or body exceeds its bounded contract",
        ));
    }
    let head = safe_git_ref(
        input
            .get("head")
            .ok_or_else(|| LocalGithubError::new("GitHub pull-request head is missing"))?,
        "head",
    )?;
    let base = safe_git_ref(
        input
            .get("base")
            .ok_or_else(|| LocalGithubError::new("GitHub pull-request base is missing"))?,
        "base",
    )?;
    let draft = input
        .get("draft")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let pull = github_api_write(
        env,
        cwd,
        binding,
        "POST",
        &format!("repos/{}/pulls", binding.repository),
        JsonObject::from([
            ("title".to_owned(), JsonValue::String(title)),
            ("body".to_owned(), JsonValue::String(body)),
            ("head".to_owned(), JsonValue::String(head)),
            ("base".to_owned(), JsonValue::String(base)),
            ("draft".to_owned(), JsonValue::Bool(draft)),
        ]),
        "GitHub pull-request creation",
    )?;
    normalize_pull_request(&pull, &binding.repository)
}

fn publish_pull_request(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let workspace = crate::config::resolve_runx_workspace_base(env, cwd);
    let remote = parse_github_remote(&git_remote_origin(env, &workspace)?)?;
    if remote.host != binding.host || !remote.repository.eq_ignore_ascii_case(&binding.repository) {
        return Err(LocalGithubError::new(format!(
            "checkout origin targets {}, not admitted repository {}",
            remote.repository, binding.repository
        )));
    }
    let commit = exact_commit(input)?;
    let head = safe_git_ref(
        input
            .get("head")
            .ok_or_else(|| LocalGithubError::new("GitHub pull-request head is missing"))?,
        "head",
    )?;
    let base = safe_git_ref(
        input
            .get("base")
            .ok_or_else(|| LocalGithubError::new("GitHub pull-request base is missing"))?,
        "base",
    )?;
    let title = required_string(input, "title", "GitHub pull-request title")?;
    let body = required_string(input, "body", "GitHub pull-request body")?;
    if title.len() > 256 || body.len() > 65_536 || title.contains('\0') || body.contains('\0') {
        return Err(LocalGithubError::new(
            "GitHub pull-request title or body exceeds its bounded contract",
        ));
    }
    let draft = input
        .get("draft")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let resolved_commit = run_git_text(
        env,
        &workspace,
        vec![
            "rev-parse".to_owned(),
            "--verify".to_owned(),
            format!("{commit}^{{commit}}"),
        ],
        "Git commit verification",
    )?;
    if resolved_commit != commit {
        return Err(LocalGithubError::new(
            "commit must be the exact full object id selected for publication",
        ));
    }
    let remote_ref = format!("refs/heads/{head}");
    match read_remote_ref(env, &workspace, &remote_ref)? {
        Some(remote_commit) if remote_commit == commit => {}
        Some(remote_commit) => {
            return Err(LocalGithubError::new(format!(
                "remote {remote_ref} already points to {remote_commit}; refusing to overwrite it with {commit}"
            )));
        }
        None => {
            run_git_success(
                env,
                &workspace,
                vec![
                    "push".to_owned(),
                    "--porcelain".to_owned(),
                    "origin".to_owned(),
                    format!("{commit}:{remote_ref}"),
                ],
                "exact Git ref publication",
            )?;
        }
    }
    if read_remote_ref(env, &workspace, &remote_ref)?.as_deref() != Some(commit.as_str()) {
        return Err(LocalGithubError::new(
            "remote branch readback did not match the approved commit",
        ));
    }

    let owner = binding
        .repository
        .split_once('/')
        .map(|(owner, _)| owner)
        .ok_or_else(|| LocalGithubError::new("GitHub repository identity is malformed"))?;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("state", "open");
    query.append_pair("head", &format!("{owner}:{head}"));
    query.append_pair("base", &base);
    query.append_pair("per_page", "2");
    let candidates = github_api_get(
        env,
        cwd,
        binding,
        &format!("repos/{}/pulls?{}", binding.repository, query.finish()),
        "GitHub pull-request publication recovery",
    )?;
    let candidates = candidates.as_array().ok_or_else(|| {
        LocalGithubError::new("GitHub pull-request recovery response was not an array")
    })?;
    let pull = match candidates.as_slice() {
        [] => github_api_write(
            env,
            cwd,
            binding,
            "POST",
            &format!("repos/{}/pulls", binding.repository),
            JsonObject::from([
                ("title".to_owned(), JsonValue::String(title.clone())),
                ("body".to_owned(), JsonValue::String(body.clone())),
                ("head".to_owned(), JsonValue::String(head.clone())),
                ("base".to_owned(), JsonValue::String(base.clone())),
                ("draft".to_owned(), JsonValue::Bool(draft)),
            ]),
            "GitHub pull-request publication",
        )?,
        [pull] => pull.clone(),
        _ => {
            return Err(LocalGithubError::new(
                "multiple open pull requests match the approved head and base",
            ));
        }
    };
    let number = json_u64(&pull, "number", "GitHub pull-request number")?;
    let readback = github_api_get(
        env,
        cwd,
        binding,
        &format!("repos/{}/pulls/{number}", binding.repository),
        "GitHub pull-request publication readback",
    )?;
    verify_published_pull_request(&readback, &title, &body, &head, &base, &commit, draft)?;
    let mut result = normalize_pull_request(&readback, &binding.repository)?;
    result.insert("published_commit".to_owned(), JsonValue::String(commit));
    result.insert("branch_ref".to_owned(), JsonValue::String(remote_ref));
    Ok(result)
}

fn verify_published_pull_request(
    pull: &JsonValue,
    title: &str,
    body: &str,
    head: &str,
    base: &str,
    commit: &str,
    draft: bool,
) -> Result<(), LocalGithubError> {
    let matches = required_json_string(pull, "title", "GitHub pull-request title")? == title
        && value_field(pull, "body").and_then(JsonValue::as_str) == Some(body)
        && required_json_string(pull, "state", "GitHub pull-request state")? == "open"
        && nested_string(pull, "head", "ref")? == head
        && nested_string(pull, "head", "sha")? == commit
        && nested_string(pull, "base", "ref")? == base
        && value_field(pull, "draft")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false)
            == draft;
    if !matches {
        return Err(LocalGithubError::new(
            "pull-request readback did not match the approved publication",
        ));
    }
    Ok(())
}

fn nested_string<'a>(
    value: &'a JsonValue,
    object: &str,
    field: &str,
) -> Result<&'a str, LocalGithubError> {
    value_field(value, object)
        .and_then(JsonValue::as_object)
        .and_then(|object| object.get(field))
        .and_then(JsonValue::as_str)
        .ok_or_else(|| LocalGithubError::new(format!("GitHub {object}.{field} is missing")))
}

fn exact_commit(input: &JsonObject) -> Result<String, LocalGithubError> {
    let commit = required_string(input, "commit", "exact Git commit")?;
    if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(LocalGithubError::new(
            "commit must be an exact full hexadecimal Git object id",
        ));
    }
    Ok(commit.to_ascii_lowercase())
}

fn read_remote_ref(
    env: &BTreeMap<String, String>,
    workspace: &Path,
    remote_ref: &str,
) -> Result<Option<String>, LocalGithubError> {
    let output = run_git_text(
        env,
        workspace,
        vec![
            "ls-remote".to_owned(),
            "--refs".to_owned(),
            "origin".to_owned(),
            remote_ref.to_owned(),
        ],
        "Git remote ref readback",
    )?;
    if output.is_empty() {
        return Ok(None);
    }
    let mut lines = output.lines();
    let first = lines
        .next()
        .and_then(|line| line.split_whitespace().next())
        .filter(|oid| {
            matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .ok_or_else(|| LocalGithubError::new("Git remote ref readback was malformed"))?;
    if lines.next().is_some() {
        return Err(LocalGithubError::new(
            "Git remote ref readback returned multiple refs",
        ));
    }
    Ok(Some(first.to_ascii_lowercase()))
}

fn run_git_text(
    env: &BTreeMap<String, String>,
    workspace: &Path,
    args: Vec<String>,
    label: &'static str,
) -> Result<String, LocalGithubError> {
    let outcome = run_git(env, workspace, args, label)?;
    if !outcome.status.success() {
        return Err(LocalGithubError::new(format!(
            "{label} failed with exit status {}",
            outcome.status
        )));
    }
    std::str::from_utf8(&outcome.stdout.bytes)
        .map(str::trim)
        .map(str::to_owned)
        .map_err(|_| LocalGithubError::new(format!("{label} returned non-UTF-8 output")))
}

fn run_git_success(
    env: &BTreeMap<String, String>,
    workspace: &Path,
    args: Vec<String>,
    label: &'static str,
) -> Result<(), LocalGithubError> {
    let outcome = run_git(env, workspace, args, label)?;
    if !outcome.status.success() {
        return Err(LocalGithubError::new(format!(
            "{label} failed with exit status {}",
            outcome.status
        )));
    }
    Ok(())
}

fn run_git(
    env: &BTreeMap<String, String>,
    workspace: &Path,
    args: Vec<String>,
    label: &'static str,
) -> Result<crate::process::ProcessOutcome, LocalGithubError> {
    let mut child_env =
        process_base_environment(env).map_err(|error| LocalGithubError::new(error.to_string()))?;
    child_env.insert("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned());
    child_env.insert("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned());
    let outcome = run_process(
        ProcessSpec::new(label, "git", GIT_OUTPUT_LIMIT_BYTES)
            .args(args)
            .cwd(workspace)
            .env(child_env)
            .timeout(Some(GIT_TIMEOUT)),
    )
    .map_err(|error| LocalGithubError::new(format!("{label} could not run: {error}")))?;
    if outcome.timed_out || outcome.stdout.truncated || outcome.stderr.truncated {
        return Err(LocalGithubError::new(format!(
            "{label} exceeded runtime bounds"
        )));
    }
    Ok(outcome)
}

fn read_threads(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let reference = thread_reference(input)?;
    let endpoint = match reference.as_slice() {
        [kind, number, "comments"] if matches!(*kind, "issues" | "pulls") => {
            let number = safe_number(number, "thread number")?;
            format!("repos/{}/issues/{number}/comments", binding.repository)
        }
        _ => {
            return Err(LocalGithubError::new(
                "GitHub thread reference must be issues/<number>/comments or pulls/<number>/comments",
            ));
        }
    };
    let response = github_api_get(env, cwd, binding, &endpoint, "GitHub thread read")?;
    let include_body = input
        .get("resource_selector")
        .and_then(JsonValue::as_object)
        .and_then(|selector| selector.get("include_body"))
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let items = response
        .as_array()
        .ok_or_else(|| LocalGithubError::new("gh thread response was not an array"))?
        .iter()
        .map(normalize_comment_object)
        .map(|result| {
            result
                .and_then(|item| compact_collection_item(item, include_body))
                .map(JsonValue::Object)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(collection_result(&binding.repository, items))
}

fn mutate_issue(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let mutation = required_mutation(input, "issues")?;
    sync_mutation_result(
        binding,
        mutation,
        mutate_resource(env, cwd, binding, mutation, ResourceMutationKind::Issue)?,
    )
}

fn mutate_pull_request(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let mutation = required_mutation(input, "pulls")?;
    sync_mutation_result(
        binding,
        mutation,
        mutate_resource(
            env,
            cwd,
            binding,
            mutation,
            ResourceMutationKind::PullRequest,
        )?,
    )
}

/// Apply and independently verify an issue or pull-request update, returning
/// the normalized provider resource. The surrounding sync envelope is built
/// exactly once by `sync_mutation_result`, whether this is a standalone write
/// or one item in a batch.
fn mutate_resource(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    mutation: &JsonObject,
    kind: ResourceMutationKind,
) -> Result<JsonObject, LocalGithubError> {
    let (kind_ref, issue) = match kind {
        ResourceMutationKind::Issue => ("issues", true),
        ResourceMutationKind::PullRequest => ("pulls", false),
    };
    let number = reference_number(mutation, kind_ref)?;
    let patch = mutation_payload(mutation)?;
    github_api_write(
        env,
        cwd,
        binding,
        "PATCH",
        &format!("repos/{}/{kind_ref}/{number}", binding.repository),
        patch,
        if issue {
            "GitHub issue mutation"
        } else {
            "GitHub pull-request mutation"
        },
    )?;
    let actual = github_api_get(
        env,
        cwd,
        binding,
        &format!("repos/{}/{kind_ref}/{number}", binding.repository),
        if issue {
            "GitHub issue mutation readback"
        } else {
            "GitHub pull-request mutation readback"
        },
    )?;
    if issue {
        verify_issue_patch(mutation_payload(mutation)?, &actual)?;
        normalize_issue(&actual, &binding.repository)
    } else {
        verify_simple_patch(mutation_payload(mutation)?, &actual)?;
        normalize_pull_request(&actual, &binding.repository)
    }
}

fn mutate_thread(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let mutation = input
        .get("mutation")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| LocalGithubError::new("GitHub thread mutation is missing"))?;
    sync_mutation_result(
        binding,
        mutation,
        mutate_thread_resource(env, cwd, binding, mutation)?,
    )
}

fn mutate_thread_resource(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    mutation: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let reference = mutation
        .get("ref")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| LocalGithubError::new("GitHub thread mutation ref is missing"))?;
    let payload = mutation_payload(mutation)?;
    let parts = reference.split('/').collect::<Vec<_>>();
    let (method, endpoint) = match parts.as_slice() {
        [kind, number, "comments"] if matches!(*kind, "issues" | "pulls") => (
            "POST",
            format!(
                "repos/{}/issues/{}/comments",
                binding.repository,
                safe_number(number, "thread number")?
            ),
        ),
        ["issues", "comments", comment] => (
            "PATCH",
            format!(
                "repos/{}/issues/comments/{}",
                binding.repository,
                safe_number(comment, "comment number")?
            ),
        ),
        _ => {
            return Err(LocalGithubError::new(
                "GitHub thread mutation ref is unsupported",
            ));
        }
    };
    let posted = github_api_write(
        env,
        cwd,
        binding,
        method,
        &endpoint,
        payload,
        "GitHub thread mutation",
    )?;
    let comment_id = json_u64(&posted, "id", "GitHub comment id")?;
    let actual = github_api_get(
        env,
        cwd,
        binding,
        &format!("repos/{}/issues/comments/{comment_id}", binding.repository),
        "GitHub thread mutation readback",
    )?;
    verify_simple_patch(mutation_payload(mutation)?, &actual)?;
    normalize_comment_object(&actual)
}

fn comment_on_pull_request(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let number = issue_number(input, "pr_number")?;
    let body = required_string(input, "body", "pull-request comment body")?;
    if body.len() > 65_536 || body.contains('\0') {
        return Err(LocalGithubError::new(
            "pull-request comment body exceeds its bounded contract",
        ));
    }
    let posted = github_api_write(
        env,
        cwd,
        binding,
        "POST",
        &format!("repos/{}/issues/{number}/comments", binding.repository),
        JsonObject::from([("body".to_owned(), JsonValue::String(body.clone()))]),
        "GitHub pull-request comment",
    )?;
    let comment_id = json_u64(&posted, "id", "GitHub comment id")?;
    let actual = github_api_get(
        env,
        cwd,
        binding,
        &format!("repos/{}/issues/comments/{comment_id}", binding.repository),
        "GitHub pull-request comment readback",
    )?;
    let actual_body = required_json_string(&actual, "body", "GitHub comment body")?;
    if actual_body != body {
        return Err(LocalGithubError::new(
            "GitHub comment readback body did not match the approved body",
        ));
    }
    Ok(JsonObject::from([
        (
            "repository".to_owned(),
            JsonValue::String(binding.repository.clone()),
        ),
        ("number".to_owned(), JsonValue::String(number.to_string())),
        (
            "comment_ref".to_owned(),
            JsonValue::String(format!("issues/comments/{comment_id}")),
        ),
        (
            "body_digest".to_owned(),
            JsonValue::String(sha256_prefixed(body.as_bytes())),
        ),
    ]))
}

fn read_pull_request_comment(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let reference = required_string(input, "comment_ref", "GitHub comment ref")?;
    let parts = reference.split('/').collect::<Vec<_>>();
    let ["issues", "comments", comment] = parts.as_slice() else {
        return Err(LocalGithubError::new(
            "GitHub comment ref must be issues/comments/<number>",
        ));
    };
    let comment = safe_number(comment, "comment number")?;
    let actual = github_api_get(
        env,
        cwd,
        binding,
        &format!("repos/{}/issues/comments/{comment}", binding.repository),
        "GitHub pull-request comment readback",
    )?;
    let body = required_json_string(&actual, "body", "GitHub comment body")?;
    Ok(JsonObject::from([
        (
            "repository".to_owned(),
            JsonValue::String(binding.repository.clone()),
        ),
        (
            "number".to_owned(),
            input.get("number").cloned().unwrap_or(JsonValue::Null),
        ),
        ("comment_ref".to_owned(), JsonValue::String(reference)),
        (
            "body_digest".to_owned(),
            JsonValue::String(sha256_prefixed(body.as_bytes())),
        ),
        (
            "state".to_owned(),
            JsonValue::String("published".to_owned()),
        ),
    ]))
}

fn read_sync_result(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    if input
        .get("mutations")
        .and_then(JsonValue::as_array)
        .is_some()
    {
        return read_sync_batch_result(env, cwd, binding, input);
    }
    let mutation = input
        .get("mutation")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| LocalGithubError::new("GitHub sync readback mutation is missing"))?;
    let sync_ref = required_string(input, "sync_ref", "GitHub sync readback ref")?;
    let mutation_digest = required_string(
        input,
        "mutation_digest",
        "GitHub sync readback mutation digest",
    )?;
    let resource = read_sync_item(env, cwd, binding, mutation, &sync_ref, &mutation_digest)?;
    let mut result = sync_mutation_result(binding, mutation, resource)?;
    // Preserve the caller's batch identity when this is a readback of a
    // prior write. The resource and mutation envelope itself must come from
    // the fresh provider read, not from the stale input packet.
    for field in ["batch_digest", "idempotency_key"] {
        if let Some(value) = input.get(field) {
            result.insert(field.to_owned(), value.clone());
        }
    }
    Ok(result)
}

fn read_sync_item(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    mutation: &JsonObject,
    sync_ref: &str,
    mutation_digest: &str,
) -> Result<JsonObject, LocalGithubError> {
    let actual_mutation_digest = sha256_prefixed(
        &serde_json::to_vec(&JsonValue::Object(mutation.clone()))
            .map_err(|error| LocalGithubError::new(format!("encoding mutation: {error}")))?,
    );
    if mutation_digest != actual_mutation_digest {
        return Err(LocalGithubError::new(
            "GitHub sync readback mutation digest does not match the approved mutation",
        ));
    }
    let mutation_ref = required_string(mutation, "ref", "GitHub mutation ref")?;
    let parts = sync_ref.split('/').collect::<Vec<_>>();
    if let ["issues", "comments", comment] = parts.as_slice() {
        let actual = github_api_get(
            env,
            cwd,
            binding,
            &format!(
                "repos/{}/issues/comments/{}",
                binding.repository,
                safe_number(comment, "comment number")?
            ),
            "GitHub sync comment readback",
        )?;
        verify_comment_sync_readback(env, cwd, binding, mutation, &actual)?;
        return Ok(compact_sync_resource(
            &normalize_comment_object(&actual)?,
            sync_ref,
        ));
    }
    let (actual, issue) = match parts.as_slice() {
        ["issues", number] => {
            if mutation_ref != sync_ref {
                return Err(LocalGithubError::new(
                    "GitHub issue readback ref did not match the approved mutation",
                ));
            }
            (
                github_api_get(
                    env,
                    cwd,
                    binding,
                    &format!(
                        "repos/{}/issues/{}",
                        binding.repository,
                        safe_number(number, "issue number")?
                    ),
                    "GitHub sync issue readback",
                )?,
                true,
            )
        }
        ["pulls", number] => {
            if mutation_ref != sync_ref {
                return Err(LocalGithubError::new(
                    "GitHub pull-request readback ref did not match the approved mutation",
                ));
            }
            (
                github_api_get(
                    env,
                    cwd,
                    binding,
                    &format!(
                        "repos/{}/pulls/{}",
                        binding.repository,
                        safe_number(number, "pull-request number")?
                    ),
                    "GitHub sync pull-request readback",
                )?,
                false,
            )
        }
        _ => {
            return Err(LocalGithubError::new(
                "GitHub sync readback reference is unsupported",
            ));
        }
    };
    if issue {
        verify_issue_patch(mutation_payload(mutation)?, &actual)?;
        Ok(compact_sync_resource(
            &normalize_issue(&actual, &binding.repository)?,
            sync_ref,
        ))
    } else {
        verify_simple_patch(mutation_payload(mutation)?, &actual)?;
        Ok(compact_sync_resource(
            &normalize_pull_request(&actual, &binding.repository)?,
            sync_ref,
        ))
    }
}

fn sync_write_batch(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let mutations = bounded_mutation_array(input)?;
    for mutation in &mutations {
        validate_batch_mutation(mutation)?;
    }
    let mut items = Vec::with_capacity(mutations.len());
    for mutation in &mutations {
        let item = apply_batch_mutation(env, cwd, binding, mutation)
            .map(JsonValue::Object)
            .unwrap_or_else(|_| batch_unknown_item(mutation));
        items.push(item);
    }
    batch_result(binding, mutations, items)
}

fn apply_batch_mutation(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    mutation: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let actual = match mutation_ref_kind(mutation)? {
        MutationRefKind::Issue => {
            mutate_resource(env, cwd, binding, mutation, ResourceMutationKind::Issue)?
        }
        MutationRefKind::PullRequest => mutate_resource(
            env,
            cwd,
            binding,
            mutation,
            ResourceMutationKind::PullRequest,
        )?,
        MutationRefKind::Thread => mutate_thread_resource(env, cwd, binding, mutation)?,
    };
    mutation_item(mutation, actual)
}

fn validate_batch_mutation(mutation: &JsonObject) -> Result<(), LocalGithubError> {
    match mutation_ref_kind(mutation)? {
        MutationRefKind::Issue => {
            required_mutation_shape(mutation, "issues")?;
        }
        MutationRefKind::PullRequest => {
            required_mutation_shape(mutation, "pulls")?;
        }
        MutationRefKind::Thread => {
            let reference = required_string(mutation, "ref", "GitHub thread mutation ref")?;
            let op = required_string(mutation, "op", "GitHub thread mutation operation")?;
            match (reference, op.as_str()) {
                (reference, "comment") if reference.ends_with("/comments") => {
                    mutation_payload(mutation)?;
                }
                (reference, "update") if reference.starts_with("issues/comments/") => {
                    mutation_payload(mutation)?;
                }
                _ => {
                    return Err(LocalGithubError::new(
                        "GitHub thread mutation must be a comment or comment update",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn required_mutation_shape(
    mutation: &JsonObject,
    expected_kind: &str,
) -> Result<(), LocalGithubError> {
    let reference = required_string(mutation, "ref", "GitHub mutation ref")?;
    if !reference.starts_with(&format!("{expected_kind}/")) {
        return Err(LocalGithubError::new(format!(
            "GitHub mutation ref must target {expected_kind}"
        )));
    }
    if required_string(mutation, "op", "GitHub mutation operation")? != "update" {
        return Err(LocalGithubError::new(
            "GitHub issue/pull-request mutation must use update",
        ));
    }
    mutation_payload(mutation)?;
    Ok(())
}

fn read_sync_batch_result(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    input: &JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let items = input
        .get("mutations")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| LocalGithubError::new("GitHub batch readback mutations are missing"))?;
    if items.is_empty() || items.len() > 8 {
        return Err(LocalGithubError::new(
            "GitHub batch readback mutations must contain 1 to 8 items",
        ));
    }
    let mut updated_items = Vec::with_capacity(items.len());
    let mut unresolved = 0usize;
    for item in items {
        let item = item
            .as_object()
            .ok_or_else(|| LocalGithubError::new("GitHub batch readback item is not an object"))?;
        let mut child = JsonObject::new();
        for field in ["mutation", "sync_ref", "mutation_digest"] {
            if let Some(value) = item.get(field) {
                child.insert(field.to_owned(), value.clone());
            }
        }
        if !child.contains_key("mutation") {
            return Err(LocalGithubError::new(
                "GitHub batch readback item is missing mutation",
            ));
        }
        let mutation = child
            .get("mutation")
            .and_then(JsonValue::as_object)
            .ok_or_else(|| {
                LocalGithubError::new("GitHub batch readback item mutation is missing")
            })?;
        let sync_ref = required_string(&child, "sync_ref", "GitHub batch readback sync ref")?;
        let mutation_digest = required_string(
            &child,
            "mutation_digest",
            "GitHub batch readback mutation digest",
        )?;
        let mut updated = item.clone();
        match read_sync_item(env, cwd, binding, mutation, &sync_ref, &mutation_digest) {
            Ok(resource) => {
                updated.insert("status".to_owned(), JsonValue::String("applied".to_owned()));
                updated.insert("resource".to_owned(), JsonValue::Object(resource));
            }
            Err(_) => unresolved += 1,
        }
        updated_items.push(JsonValue::Object(updated));
    }
    if unresolved > 0 {
        return Err(LocalGithubError::new(format!(
            "GitHub batch readback could not verify {unresolved} mutation item(s)"
        )));
    }
    let mut output = input.clone();
    output.insert(
        "batch_status".to_owned(),
        JsonValue::String("applied".to_owned()),
    );
    output.insert(
        "mutations".to_owned(),
        JsonValue::Array(updated_items.clone()),
    );
    output.insert(
        "resources".to_owned(),
        JsonValue::Array(
            updated_items
                .iter()
                .filter_map(JsonValue::as_object)
                .filter_map(|item| item.get("resource").cloned())
                .collect(),
        ),
    );
    Ok(output)
}

#[derive(Clone, Copy)]
enum ResourceMutationKind {
    Issue,
    PullRequest,
}

#[derive(Clone, Copy)]
enum MutationRefKind {
    Issue,
    PullRequest,
    Thread,
}

fn mutation_ref_kind(mutation: &JsonObject) -> Result<MutationRefKind, LocalGithubError> {
    let reference = required_string(mutation, "ref", "GitHub batch mutation ref")?;
    let parts = reference.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["issues", number] if number.parse::<u64>().is_ok() => Ok(MutationRefKind::Issue),
        ["pulls", number] if number.parse::<u64>().is_ok() => Ok(MutationRefKind::PullRequest),
        [kind, number, "comments"]
            if matches!(*kind, "issues" | "pulls") && number.parse::<u64>().is_ok() =>
        {
            Ok(MutationRefKind::Thread)
        }
        ["issues", "comments", comment] if comment.parse::<u64>().is_ok() => {
            Ok(MutationRefKind::Thread)
        }
        _ => Err(LocalGithubError::new(
            "GitHub batch mutation ref is unsupported",
        )),
    }
}

fn bounded_mutation_array(input: &JsonObject) -> Result<Vec<&JsonObject>, LocalGithubError> {
    let mutations = input
        .get("mutations")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| LocalGithubError::new("GitHub batch mutations are missing"))?;
    if mutations.is_empty() || mutations.len() > 8 {
        return Err(LocalGithubError::new(
            "GitHub batch mutations must contain 1 to 8 items",
        ));
    }
    mutations
        .iter()
        .map(|value| {
            value
                .as_object()
                .ok_or_else(|| LocalGithubError::new("GitHub batch mutation is not an object"))
        })
        .collect()
}

fn batch_unknown_item(mutation: &JsonObject) -> JsonValue {
    let mutation_value = JsonValue::Object(mutation.clone());
    let digest = serde_json::to_vec(&mutation_value)
        .map(|bytes| sha256_prefixed(&bytes))
        .unwrap_or_else(|_| "sha256:unknown".to_owned());
    JsonValue::Object(JsonObject::from([
        ("status".to_owned(), JsonValue::String("unknown".to_owned())),
        (
            "sync_ref".to_owned(),
            mutation.get("ref").cloned().unwrap_or(JsonValue::Null),
        ),
        ("mutation_digest".to_owned(), JsonValue::String(digest)),
        ("mutation".to_owned(), mutation_value),
        ("resource".to_owned(), JsonValue::Null),
    ]))
}

fn batch_result(
    binding: &LocalGithubBinding,
    mutations: Vec<&JsonObject>,
    items: Vec<JsonValue>,
) -> Result<JsonObject, LocalGithubError> {
    let mutation_values = mutations
        .into_iter()
        .cloned()
        .map(JsonValue::Object)
        .collect::<Vec<_>>();
    let batch_digest = sha256_prefixed(
        &serde_json::to_vec(&JsonValue::Array(mutation_values.clone()))
            .map_err(|error| LocalGithubError::new(format!("encoding batch mutations: {error}")))?,
    );
    let first = items
        .first()
        .and_then(JsonValue::as_object)
        .ok_or_else(|| LocalGithubError::new("GitHub batch result has no first mutation"))?;
    let resources = items
        .iter()
        .filter_map(JsonValue::as_object)
        .filter_map(|item| item.get("resource").cloned())
        .filter(|resource| !matches!(resource, JsonValue::Null))
        .collect::<Vec<_>>();
    let batch_status = if items.iter().all(|item| {
        item.as_object()
            .and_then(|item| item.get("status"))
            .and_then(JsonValue::as_str)
            == Some("applied")
    }) {
        "applied"
    } else {
        "partial_unknown"
    };
    Ok(JsonObject::from([
        (
            "repository".to_owned(),
            JsonValue::String(binding.repository.clone()),
        ),
        ("batch_digest".to_owned(), JsonValue::String(batch_digest)),
        (
            "batch_status".to_owned(),
            JsonValue::String(batch_status.to_owned()),
        ),
        (
            "sync_ref".to_owned(),
            first.get("sync_ref").cloned().unwrap_or(JsonValue::Null),
        ),
        (
            "mutation_digest".to_owned(),
            first
                .get("mutation_digest")
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
        (
            "mutation".to_owned(),
            first.get("mutation").cloned().unwrap_or(JsonValue::Null),
        ),
        ("mutations".to_owned(), JsonValue::Array(items)),
        ("resources".to_owned(), JsonValue::Array(resources)),
    ]))
}

fn github_api_get(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    endpoint: &str,
    label: &'static str,
) -> Result<JsonValue, LocalGithubError> {
    run_gh_json(
        env,
        cwd,
        vec![
            "api".to_owned(),
            "--hostname".to_owned(),
            binding.host.clone(),
            "--method".to_owned(),
            "GET".to_owned(),
            endpoint.to_owned(),
        ],
        None,
        label,
    )
}

fn github_api_write(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    method: &str,
    endpoint: &str,
    body: JsonObject,
    label: &'static str,
) -> Result<JsonValue, LocalGithubError> {
    let body = serde_json::to_vec(&body)
        .map_err(|error| LocalGithubError::new(format!("encoding GitHub request: {error}")))?;
    run_gh_json(
        env,
        cwd,
        vec![
            "api".to_owned(),
            "--hostname".to_owned(),
            binding.host.clone(),
            "--method".to_owned(),
            method.to_owned(),
            endpoint.to_owned(),
            "--input".to_owned(),
            "-".to_owned(),
        ],
        Some(body),
        label,
    )
}

fn run_gh_json(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    args: Vec<String>,
    stdin: Option<Vec<u8>>,
    label: &'static str,
) -> Result<JsonValue, LocalGithubError> {
    let mut child_env =
        process_base_environment(env).map_err(|error| LocalGithubError::new(error.to_string()))?;
    child_env.insert("GH_PROMPT_DISABLED".to_owned(), "1".to_owned());
    child_env.insert("GH_PAGER".to_owned(), "cat".to_owned());
    child_env.insert("NO_COLOR".to_owned(), "1".to_owned());
    let workspace = crate::config::resolve_runx_workspace_base(env, cwd);
    let outcome = run_process(
        ProcessSpec::new(label, "gh", GH_OUTPUT_LIMIT_BYTES)
            .args(args)
            .cwd(workspace)
            .env(child_env)
            .stdin(stdin.map(|bytes| ProcessStdin::new(bytes, "writing GitHub request body")))
            .timeout(Some(gh_timeout(env))),
    )
    .map_err(|error| {
        LocalGithubError::new(format!(
            "gh is unavailable; install GitHub CLI, run `gh auth login`, and retry ({error})"
        ))
    })?;
    if outcome.timed_out {
        return Err(LocalGithubError::new(
            "gh exceeded the 20 second runtime bound",
        ));
    }
    if outcome.stdout.truncated || outcome.stderr.truncated {
        return Err(LocalGithubError::new(
            "gh output exceeded the 1 MiB runtime bound",
        ));
    }
    if matches!(outcome.status.code(), Some(126 | 127)) {
        return Err(LocalGithubError::new(
            "gh is unavailable; install GitHub CLI, run `gh auth login`, and retry",
        ));
    }
    if !outcome.status.success() {
        return Err(LocalGithubError::new(format!(
            "gh failed with exit status {}; verify login, repository access, and the requested operation",
            outcome.status
        )));
    }
    serde_json::from_slice(&outcome.stdout.bytes)
        .map_err(|_| LocalGithubError::new("gh returned malformed JSON"))
}

fn gh_timeout(_env: &BTreeMap<String, String>) -> Duration {
    #[cfg(test)]
    if let Some(milliseconds) = _env
        .get("RUNX_TEST_GH_TIMEOUT_MS")
        .and_then(|value| value.parse::<u64>().ok())
    {
        return Duration::from_millis(milliseconds.max(1));
    }
    GH_TIMEOUT
}

fn git_remote_origin(
    env: &BTreeMap<String, String>,
    workspace: &Path,
) -> Result<String, LocalGithubError> {
    let child_env =
        process_base_environment(env).map_err(|error| LocalGithubError::new(error.to_string()))?;
    let outcome = run_process(
        ProcessSpec::new(
            "GitHub checkout remote discovery",
            "git",
            GIT_OUTPUT_LIMIT_BYTES,
        )
        .args(vec![
            "-c".to_owned(),
            "core.fsmonitor=false".to_owned(),
            "remote".to_owned(),
            "get-url".to_owned(),
            "origin".to_owned(),
        ])
        .cwd(workspace)
        .env(child_env)
        .timeout(Some(GIT_TIMEOUT)),
    )
    .map_err(|error| {
        LocalGithubError::new(format!(
            "cannot inspect the checkout's origin remote ({error})"
        ))
    })?;
    if outcome.timed_out || outcome.stdout.truncated || !outcome.status.success() {
        return Err(LocalGithubError::new(
            "the invocation workspace has no bounded readable Git origin; pass owner/repository explicitly",
        ));
    }
    let remote = std::str::from_utf8(&outcome.stdout.bytes)
        .map_err(|_| LocalGithubError::new("Git origin is not UTF-8"))?
        .trim();
    if remote.is_empty() {
        return Err(LocalGithubError::new("Git origin is empty"));
    }
    Ok(remote.to_owned())
}

fn parse_github_remote(remote: &str) -> Result<ResolvedGithubTarget, LocalGithubError> {
    if let Some(rest) = remote.strip_prefix("git@") {
        let (host, path) = rest.split_once(':').ok_or_else(|| {
            LocalGithubError::new("GitHub SSH origin must include host:owner/repository")
        })?;
        return resolved_remote_parts(host, path);
    }
    let parsed = url::Url::parse(remote)
        .map_err(|_| LocalGithubError::new("Git origin is not a supported GitHub URL"))?;
    if !matches!(parsed.scheme(), "https" | "ssh") {
        return Err(LocalGithubError::new(
            "Git origin must use an HTTPS or SSH GitHub URL",
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| LocalGithubError::new("GitHub origin host is missing"))?;
    resolved_remote_parts(host, parsed.path())
}

fn resolved_remote_parts(host: &str, path: &str) -> Result<ResolvedGithubTarget, LocalGithubError> {
    let repository = path
        .trim_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| path.trim_matches('/'));
    Ok(ResolvedGithubTarget {
        host: validate_host(host)?,
        repository: validate_repository(repository)?,
    })
}

fn validate_host(host: &str) -> Result<String, LocalGithubError> {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty()
        || host.len() > 253
        || host.starts_with('-')
        || host.ends_with('-')
        || host
            .chars()
            .any(|character| !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-'))
    {
        return Err(LocalGithubError::new("GitHub host is invalid"));
    }
    Ok(host)
}

fn validate_repository(repository: &str) -> Result<String, LocalGithubError> {
    let parts = repository.split('/').collect::<Vec<_>>();
    if parts.len() != 2 || parts.iter().any(|part| !valid_repository_part(part)) {
        return Err(LocalGithubError::new(
            "GitHub target must be exactly owner/repository",
        ));
    }
    Ok(repository.to_owned())
}

fn valid_repository_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 100
        && !part.starts_with('.')
        && part.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

fn repository_parts(repository: &str) -> Result<(&str, &str), LocalGithubError> {
    repository
        .split_once('/')
        .ok_or_else(|| LocalGithubError::new("GitHub repository identity is malformed"))
}

fn required_string(
    object: &JsonObject,
    field: &str,
    label: &str,
) -> Result<String, LocalGithubError> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| LocalGithubError::new(format!("{label} is missing")))
}

fn required_json_string(
    value: &JsonValue,
    field: &str,
    label: &str,
) -> Result<String, LocalGithubError> {
    value_field(value, field)
        .and_then(JsonValue::as_str)
        .map(str::to_owned)
        .ok_or_else(|| LocalGithubError::new(format!("{label} is missing")))
}

fn safe_bounded_string(
    value: &JsonValue,
    label: &str,
    max: usize,
) -> Result<String, LocalGithubError> {
    let value = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= max && !value.contains('\0'))
        .ok_or_else(|| LocalGithubError::new(format!("{label} is invalid")))?;
    Ok(value.to_owned())
}

fn safe_git_ref(value: &JsonValue, field: &str) -> Result<String, LocalGithubError> {
    let value = safe_bounded_string(value, field, 255)?;
    if value.chars().any(|character| {
        !character.is_ascii_alphanumeric() && !matches!(character, '.' | '_' | '/' | ':' | '-')
    }) {
        return Err(LocalGithubError::new(format!(
            "GitHub {field} filter is invalid"
        )));
    }
    Ok(value)
}

fn safe_number(value: &str, label: &str) -> Result<u64, LocalGithubError> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| LocalGithubError::new(format!("{label} must be a positive integer")))
}

fn issue_number(input: &JsonObject, field: &str) -> Result<u64, LocalGithubError> {
    match input.get(field) {
        Some(JsonValue::String(value)) => safe_number(value, field),
        Some(JsonValue::Number(runx_contracts::JsonNumber::U64(value))) if *value > 0 => Ok(*value),
        Some(JsonValue::Number(runx_contracts::JsonNumber::I64(value))) if *value > 0 => {
            Ok(*value as u64)
        }
        _ => Err(LocalGithubError::new(format!(
            "GitHub {field} must be a positive integer"
        ))),
    }
}

fn bounded_limit(filters: &JsonObject) -> Result<u64, LocalGithubError> {
    let Some(JsonValue::Number(number)) = filters.get("limit") else {
        return if filters.contains_key("limit") {
            Err(LocalGithubError::new(
                "GitHub result limit must be between 1 and 100",
            ))
        } else {
            Ok(30)
        };
    };
    let value = match number {
        runx_contracts::JsonNumber::U64(value) => Some(*value),
        runx_contracts::JsonNumber::I64(value) if *value > 0 => Some(*value as u64),
        runx_contracts::JsonNumber::F64(value)
            if value.is_finite() && value.fract() == 0.0 && *value > 0.0 =>
        {
            Some(*value as u64)
        }
        _ => None,
    };
    value
        .filter(|value| (1..=100).contains(value))
        .ok_or_else(|| LocalGithubError::new("GitHub result limit must be between 1 and 100"))
}

fn json_u64(value: &JsonValue, field: &str, label: &str) -> Result<u64, LocalGithubError> {
    match value_field(value, field) {
        Some(JsonValue::Number(runx_contracts::JsonNumber::U64(value))) if *value > 0 => Ok(*value),
        Some(JsonValue::Number(runx_contracts::JsonNumber::I64(value))) if *value > 0 => {
            Ok(*value as u64)
        }
        _ => Err(LocalGithubError::new(format!("{label} is missing"))),
    }
}

fn normalize_issue(issue: &JsonValue, repository: &str) -> Result<JsonObject, LocalGithubError> {
    let number = json_u64(issue, "number", "GitHub issue number")?;
    Ok(JsonObject::from([
        (
            "repository".to_owned(),
            JsonValue::String(repository.to_owned()),
        ),
        ("number".to_owned(), JsonValue::String(number.to_string())),
        (
            "title".to_owned(),
            JsonValue::String(required_json_string(issue, "title", "GitHub issue title")?),
        ),
        (
            "state".to_owned(),
            JsonValue::String(required_json_string(issue, "state", "GitHub issue state")?),
        ),
        (
            "body".to_owned(),
            value_field(issue, "body")
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
        (
            "url".to_owned(),
            value_field(issue, "html_url")
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
        (
            "labels".to_owned(),
            named_object_values(issue, "labels", "name"),
        ),
        (
            "assignees".to_owned(),
            named_object_values(issue, "assignees", "login"),
        ),
    ]))
}

fn named_object_values(value: &JsonValue, field: &str, name_field: &str) -> JsonValue {
    JsonValue::Array(
        value_field(value, field)
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| value_field(item, name_field).and_then(JsonValue::as_str))
            .map(|value| JsonValue::String(value.to_owned()))
            .collect(),
    )
}

fn normalize_pull_request(
    pull: &JsonValue,
    repository: &str,
) -> Result<JsonObject, LocalGithubError> {
    let number = json_u64(pull, "number", "GitHub pull-request number")?;
    Ok(JsonObject::from([
        (
            "repository".to_owned(),
            JsonValue::String(repository.to_owned()),
        ),
        ("number".to_owned(), JsonValue::String(number.to_string())),
        (
            "title".to_owned(),
            JsonValue::String(required_json_string(
                pull,
                "title",
                "GitHub pull-request title",
            )?),
        ),
        (
            "state".to_owned(),
            JsonValue::String(required_json_string(
                pull,
                "state",
                "GitHub pull-request state",
            )?),
        ),
        (
            "body".to_owned(),
            value_field(pull, "body")
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
        (
            "url".to_owned(),
            value_field(pull, "html_url")
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
        (
            "head".to_owned(),
            nested_string_value(pull, "head", "ref").unwrap_or(JsonValue::Null),
        ),
        (
            "base".to_owned(),
            nested_string_value(pull, "base", "ref").unwrap_or(JsonValue::Null),
        ),
        (
            "draft".to_owned(),
            value_field(pull, "draft")
                .cloned()
                .unwrap_or(JsonValue::Bool(false)),
        ),
    ]))
}

fn nested_string_value(value: &JsonValue, object: &str, field: &str) -> Option<JsonValue> {
    value_field(value, object)
        .and_then(JsonValue::as_object)
        .and_then(|object| object.get(field))
        .and_then(JsonValue::as_str)
        .map(|value| JsonValue::String(value.to_owned()))
}

fn normalize_comment_object(comment: &JsonValue) -> Result<JsonObject, LocalGithubError> {
    let id = json_u64(comment, "id", "GitHub comment id")?;
    Ok(JsonObject::from([
        ("id".to_owned(), JsonValue::String(id.to_string())),
        (
            "comment_ref".to_owned(),
            JsonValue::String(format!("issues/comments/{id}")),
        ),
        (
            "body".to_owned(),
            value_field(comment, "body")
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
        (
            "url".to_owned(),
            value_field(comment, "html_url")
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
    ]))
}

fn compact_collection_item(
    mut item: JsonObject,
    include_body: bool,
) -> Result<JsonObject, LocalGithubError> {
    if include_body {
        return Ok(item);
    }
    if let Some(body) = item
        .remove("body")
        .and_then(|value| value.as_str().map(str::to_owned))
    {
        item.insert(
            "body_digest".to_owned(),
            JsonValue::String(sha256_prefixed(body.as_bytes())),
        );
    }
    Ok(item)
}

fn collection_result(repository: &str, items: Vec<JsonValue>) -> JsonObject {
    JsonObject::from([
        (
            "repository".to_owned(),
            JsonValue::String(repository.to_owned()),
        ),
        ("items".to_owned(), JsonValue::Array(items)),
        ("cursor".to_owned(), JsonValue::Null),
    ])
}

fn required_mutation<'a>(
    input: &'a JsonObject,
    expected_kind: &str,
) -> Result<&'a JsonObject, LocalGithubError> {
    let mutation = input
        .get("mutation")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| LocalGithubError::new("GitHub sync mutation is missing"))?;
    let reference = required_string(mutation, "ref", "GitHub mutation ref")?;
    if !reference.starts_with(&format!("{expected_kind}/")) {
        return Err(LocalGithubError::new(format!(
            "GitHub mutation ref must target {expected_kind}"
        )));
    }
    if mutation.get("op").and_then(JsonValue::as_str) != Some("update") {
        return Err(LocalGithubError::new(
            "GitHub issue/pull-request mutation must use update",
        ));
    }
    Ok(mutation)
}

fn reference_number(mutation: &JsonObject, kind: &str) -> Result<u64, LocalGithubError> {
    let reference = required_string(mutation, "ref", "GitHub mutation ref")?;
    reference
        .strip_prefix(&format!("{kind}/"))
        .ok_or_else(|| LocalGithubError::new("GitHub mutation ref has the wrong kind"))
        .and_then(|number| safe_number(number, "GitHub mutation number"))
}

fn mutation_payload(mutation: &JsonObject) -> Result<JsonObject, LocalGithubError> {
    mutation
        .get("payload")
        .and_then(JsonValue::as_object)
        .filter(|payload| !payload.is_empty())
        .cloned()
        .ok_or_else(|| LocalGithubError::new("GitHub mutation payload is missing"))
}

fn verify_issue_patch(patch: JsonObject, actual: &JsonValue) -> Result<(), LocalGithubError> {
    for (field, expected) in patch {
        let matches = match field.as_str() {
            "labels" | "assignees" => named_objects_match(value_field(actual, &field), &expected),
            "milestone" => milestone_matches(value_field(actual, &field), &expected),
            _ => value_field(actual, &field) == Some(&expected),
        };
        if !matches {
            return Err(LocalGithubError::new(format!(
                "GitHub issue readback field {field:?} did not match the approved mutation"
            )));
        }
    }
    Ok(())
}

fn verify_simple_patch(patch: JsonObject, actual: &JsonValue) -> Result<(), LocalGithubError> {
    for (field, expected) in patch {
        if value_field(actual, &field) != Some(&expected) {
            return Err(LocalGithubError::new(format!(
                "GitHub readback field {field:?} did not match the approved mutation"
            )));
        }
    }
    Ok(())
}

fn named_objects_match(actual: Option<&JsonValue>, expected: &JsonValue) -> bool {
    let Some(actual) = actual.and_then(JsonValue::as_array) else {
        return false;
    };
    let Some(expected) = expected.as_array() else {
        return false;
    };
    let mut actual = actual
        .iter()
        .filter_map(|value| {
            value_field(value, "name")
                .or_else(|| value_field(value, "login"))
                .and_then(JsonValue::as_str)
        })
        .collect::<Vec<_>>();
    let mut expected = expected
        .iter()
        .filter_map(JsonValue::as_str)
        .collect::<Vec<_>>();
    actual.sort_unstable();
    expected.sort_unstable();
    actual == expected
}

fn milestone_matches(actual: Option<&JsonValue>, expected: &JsonValue) -> bool {
    if matches!(expected, JsonValue::Null) {
        return actual.is_none_or(|value| matches!(value, JsonValue::Null));
    }
    actual.and_then(|value| value_field(value, "number")) == Some(expected)
}

fn value_field<'a>(value: &'a JsonValue, field: &str) -> Option<&'a JsonValue> {
    value.as_object().and_then(|object| object.get(field))
}

fn mutation_item(
    mutation: &JsonObject,
    actual: JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let mutation_value = JsonValue::Object(mutation.clone());
    let mutation_digest = sha256_prefixed(
        &serde_json::to_vec(&mutation_value)
            .map_err(|error| LocalGithubError::new(format!("encoding mutation: {error}")))?,
    );
    let sync_ref = actual
        .get("comment_ref")
        .and_then(JsonValue::as_str)
        .or_else(|| mutation.get("ref").and_then(JsonValue::as_str))
        .ok_or_else(|| LocalGithubError::new("GitHub mutation sync ref is missing"))?;
    Ok(JsonObject::from([
        ("status".to_owned(), JsonValue::String("applied".to_owned())),
        (
            "sync_ref".to_owned(),
            JsonValue::String(sync_ref.to_owned()),
        ),
        (
            "mutation_digest".to_owned(),
            JsonValue::String(mutation_digest),
        ),
        ("mutation".to_owned(), mutation_value),
        (
            "resource".to_owned(),
            JsonValue::Object(compact_sync_resource(&actual, sync_ref)),
        ),
    ]))
}

fn sync_mutation_result(
    binding: &LocalGithubBinding,
    mutation: &JsonObject,
    actual: JsonObject,
) -> Result<JsonObject, LocalGithubError> {
    let item = mutation_item(mutation, actual)?;
    let mutation_value = item
        .get("mutation")
        .cloned()
        .ok_or_else(|| LocalGithubError::new("GitHub mutation item is missing its mutation"))?;
    let mutation_digest = required_string(&item, "mutation_digest", "GitHub mutation item digest")?;
    let sync_ref = required_string(&item, "sync_ref", "GitHub mutation item ref")?;
    let resource = item
        .get("resource")
        .cloned()
        .ok_or_else(|| LocalGithubError::new("GitHub mutation item is missing its resource"))?;
    let batch_digest = sha256_prefixed(
        &serde_json::to_vec(&JsonValue::Array(vec![mutation_value.clone()]))
            .map_err(|error| LocalGithubError::new(format!("encoding mutation batch: {error}")))?,
    );
    let mut result = JsonObject::from([
        (
            "repository".to_owned(),
            JsonValue::String(binding.repository.clone()),
        ),
        (
            "sync_ref".to_owned(),
            JsonValue::String(sync_ref.to_owned()),
        ),
        (
            "mutation_digest".to_owned(),
            JsonValue::String(mutation_digest.clone()),
        ),
        ("batch_digest".to_owned(), JsonValue::String(batch_digest)),
        (
            "batch_status".to_owned(),
            JsonValue::String("applied".to_owned()),
        ),
        ("mutation".to_owned(), mutation_value),
        ("resources".to_owned(), JsonValue::Array(vec![resource])),
    ]);
    result.insert(
        "mutations".to_owned(),
        JsonValue::Array(vec![JsonValue::Object(item)]),
    );
    Ok(result)
}

fn compact_sync_resource(actual: &JsonObject, fallback_ref: &str) -> JsonObject {
    let mut compact = JsonObject::new();
    compact.insert(
        "ref".to_owned(),
        actual
            .get("comment_ref")
            .or_else(|| actual.get("ref"))
            .cloned()
            .unwrap_or_else(|| JsonValue::String(fallback_ref.to_owned())),
    );
    for field in [
        "repository",
        "number",
        "state",
        "url",
        "updated_at",
        "draft",
        "merged",
    ] {
        if let Some(value) = actual.get(field) {
            compact.insert(field.to_owned(), value.clone());
        }
    }
    if let Some(value) = actual.get("body_digest") {
        compact.insert("body_digest".to_owned(), value.clone());
    } else if let Some(body) = actual.get("body").and_then(JsonValue::as_str) {
        compact.insert(
            "body_digest".to_owned(),
            JsonValue::String(sha256_prefixed(body.as_bytes())),
        );
    }
    compact
}

fn verify_comment_sync_readback(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    binding: &LocalGithubBinding,
    mutation: &JsonObject,
    actual: &JsonValue,
) -> Result<(), LocalGithubError> {
    let mutation_ref = required_string(mutation, "ref", "GitHub mutation ref")?;
    let payload = mutation_payload(mutation)?;
    let body = required_json_string(actual, "body", "GitHub comment body")?;
    if payload.get("body") != Some(&JsonValue::String(body.to_owned())) {
        return Err(LocalGithubError::new(
            "GitHub comment readback body did not match the approved mutation",
        ));
    }
    let parts = mutation_ref.split('/').collect::<Vec<_>>();
    if let [kind, number, "comments"] = parts.as_slice()
        && matches!(*kind, "issues" | "pulls")
    {
        let number = safe_number(number, "thread number")?;
        let thread = github_api_get(
            env,
            cwd,
            binding,
            &format!("repos/{}/issues/{number}", binding.repository),
            "GitHub sync comment thread readback",
        )?;
        let is_pull_request = value_field(&thread, "pull_request").is_some();
        if (*kind == "pulls") != is_pull_request {
            return Err(LocalGithubError::new(
                "GitHub comment readback thread type did not match the approved mutation",
            ));
        }
        let issue_url = required_json_string(actual, "issue_url", "GitHub comment issue URL")?;
        if !issue_url.ends_with(&format!("/issues/{number}")) {
            return Err(LocalGithubError::new(
                "GitHub comment readback did not belong to the approved thread",
            ));
        }
    } else if mutation_ref != required_json_string(actual, "comment_ref", "GitHub comment ref")? {
        return Err(LocalGithubError::new(
            "GitHub comment readback ref did not match the approved mutation",
        ));
    }
    Ok(())
}

fn thread_reference(input: &JsonObject) -> Result<Vec<&str>, LocalGithubError> {
    let selector = input
        .get("resource_selector")
        .and_then(JsonValue::as_object)
        .unwrap_or(input);
    let reference = selector
        .get("refs")
        .and_then(JsonValue::as_array)
        .and_then(|refs| refs.first())
        .and_then(JsonValue::as_str)
        .or_else(|| {
            selector
                .get("filters")
                .and_then(JsonValue::as_object)
                .and_then(|filters| filters.get("thread_ref"))
                .and_then(JsonValue::as_str)
        })
        .ok_or_else(|| LocalGithubError::new("GitHub thread reference is missing"))?;
    Ok(reference.split('/').collect())
}

fn local_operation_id(
    operation: GithubOperation,
    input: &JsonObject,
    result: &JsonObject,
) -> Result<String, LocalGithubError> {
    match operation {
        GithubOperation::IssuesWrite
        | GithubOperation::PullRequestsWrite
        | GithubOperation::ThreadsWrite => input
            .get("mutation")
            .and_then(JsonValue::as_object)
            .and_then(|mutation| mutation.get("ref"))
            .and_then(JsonValue::as_str)
            .map(str::to_owned)
            .ok_or_else(|| LocalGithubError::new("GitHub mutation operation id is missing")),
        GithubOperation::SyncWriteBatch => {
            required_string(result, "batch_digest", "GitHub batch mutation digest")
        }
        GithubOperation::PullRequestComment => Ok(format!(
            "pulls/{}/comments",
            issue_number(input, "pr_number")?
        )),
        GithubOperation::PullRequestOpen => Ok(format!(
            "pulls/{}",
            required_string(result, "number", "GitHub pull-request number")?
        )),
        GithubOperation::PullRequestPublish => Ok(format!(
            "pulls/{}",
            required_string(result, "number", "GitHub pull-request number")?
        )),
        _ => Err(LocalGithubError::new(
            "read operation cannot produce a mutation operation id",
        )),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn github_remote_parser_accepts_https_and_ssh_without_shell_shapes()
    -> Result<(), Box<dyn std::error::Error>> {
        assert_eq!(
            parse_github_remote("https://github.com/runxhq/runx.git")?.repository,
            "runxhq/runx"
        );
        assert_eq!(
            parse_github_remote("git@github.com:runxhq/runx.git")?.repository,
            "runxhq/runx"
        );
        for invalid in [
            "file:///tmp/runx",
            "https://github.com/runxhq/runx/extra",
            "git@github.com:runxhq/../../other.git",
        ] {
            assert!(parse_github_remote(invalid).is_err(), "accepted {invalid}");
        }
        Ok(())
    }

    #[test]
    fn operation_registry_rejects_undeclared_and_access_mismatched_operations()
    -> Result<(), Box<dyn std::error::Error>> {
        assert!(GithubOperation::parse("issues.read").is_ok());
        assert!(GithubOperation::parse("issues.delete").is_err());
        assert_eq!(
            GithubOperation::parse("issues.write")?.access(),
            ProviderNativeAccess::Mutate
        );
        assert_eq!(
            GithubOperation::parse("sync.write_batch")?.access(),
            ProviderNativeAccess::Mutate
        );
        Ok(())
    }

    #[test]
    fn github_collection_limit_accepts_integral_values_from_javascript_boundaries()
    -> Result<(), Box<dyn std::error::Error>> {
        for number in [
            runx_contracts::JsonNumber::U64(1),
            runx_contracts::JsonNumber::I64(30),
            runx_contracts::JsonNumber::F64(100.0),
        ] {
            let expected = match &number {
                runx_contracts::JsonNumber::U64(value) => *value,
                runx_contracts::JsonNumber::I64(value) => *value as u64,
                runx_contracts::JsonNumber::F64(value) => *value as u64,
            };
            let actual = bounded_limit(&JsonObject::from([(
                "limit".to_owned(),
                JsonValue::Number(number),
            )]))?;
            assert_eq!(actual, expected);
        }
        assert!(
            bounded_limit(&JsonObject::from([(
                "limit".to_owned(),
                JsonValue::Number(runx_contracts::JsonNumber::F64(1.5)),
            )]))
            .is_err()
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_read_uses_authenticated_gh_without_approval_and_projects_provider_contract()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/runx", false)?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "issue.read",
            ProviderNativeAccess::Read,
            "runxhq/runx",
            &["repo.read".to_owned()],
        )?;
        let input = JsonObject::from([(
            "issue_number".to_owned(),
            JsonValue::String("442".to_owned()),
        )]);
        let readback = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "issue.read",
            ProviderNativeAccess::Read,
            &input,
        )?;
        assert_eq!(
            readback.get("schema").and_then(JsonValue::as_str),
            Some("runx.provider.operation.v1")
        );
        assert_eq!(
            readback.get("transport").and_then(JsonValue::as_str),
            Some("local_github")
        );
        assert_eq!(
            readback
                .get("result")
                .and_then(JsonValue::as_object)
                .and_then(|result| result.get("number"))
                .and_then(JsonValue::as_str),
            Some("442")
        );
        let log = fs::read_to_string(fixture.log_path())?;
        assert_eq!(log.lines().count(), 2, "preflight plus one issue read");
        assert!(!log.contains("auth token"));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_collection_refs_are_exact_and_compact_by_default()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/runx", false)?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "issues.read",
            ProviderNativeAccess::Read,
            "runxhq/runx",
            &["repo.read".to_owned()],
        )?;
        let readback = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "issues.read",
            ProviderNativeAccess::Read,
            &JsonObject::from([(
                "resource_selector".to_owned(),
                JsonValue::Object(JsonObject::from([
                    ("kind".to_owned(), JsonValue::String("issues".to_owned())),
                    (
                        "refs".to_owned(),
                        JsonValue::Array(vec![JsonValue::String("issues/442".to_owned())]),
                    ),
                    ("include_body".to_owned(), JsonValue::Bool(false)),
                ])),
            )]),
        )?;
        let item = readback
            .get("result")
            .and_then(JsonValue::as_object)
            .and_then(|result| result.get("items"))
            .and_then(JsonValue::as_array)
            .and_then(|items| items.first())
            .and_then(JsonValue::as_object)
            .ok_or("missing compact issue item")?;
        assert!(item.get("body").is_none());
        let expected_body_digest = sha256_prefixed(b"body");
        assert_eq!(
            item.get("body_digest").and_then(JsonValue::as_str),
            Some(expected_body_digest.as_str())
        );
        let log = fs::read_to_string(fixture.log_path())?;
        assert_eq!(
            log.lines().count(),
            2,
            "preflight plus one exact issue read"
        );
        assert!(log.contains("repos/runxhq/runx/issues/442"));
        assert!(!log.contains("repos/runxhq/runx/issues?"));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_mutation_uses_stable_idempotency_and_independent_readback()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/runx", false)?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "issues.write",
            ProviderNativeAccess::Mutate,
            "runxhq/runx",
            &["repo.write".to_owned()],
        )?;
        let original = JsonObject::from([(
            "mutation".to_owned(),
            JsonValue::Object(JsonObject::from([
                ("ref".to_owned(), JsonValue::String("issues/442".to_owned())),
                ("op".to_owned(), JsonValue::String("update".to_owned())),
                (
                    "payload".to_owned(),
                    JsonValue::Object(JsonObject::from([(
                        "labels".to_owned(),
                        JsonValue::Array(vec![JsonValue::String("triage".to_owned())]),
                    )])),
                ),
            ])),
        )]);
        let mut input = original.clone();
        input.insert(
            "idempotency_key".to_owned(),
            JsonValue::String("runx:sha256:stable-test-key".to_owned()),
        );
        let readback = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "issues.write",
            ProviderNativeAccess::Mutate,
            &input,
        )?;
        assert_eq!(
            readback.get("idempotency_key").and_then(JsonValue::as_str),
            Some("runx:sha256:stable-test-key")
        );
        assert_eq!(
            readback.get("operation_id").and_then(JsonValue::as_str),
            Some("issues/442")
        );
        let log = fs::read_to_string(fixture.log_path())?;
        assert_eq!(log.lines().count(), 3, "preflight, mutation, readback");
        assert!(log.contains("--method PATCH repos/runxhq/runx/issues/442 --input -"));
        let body: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(fixture.body_path())?)?;
        assert_eq!(body.get("labels"), Some(&serde_json::json!(["triage"])));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_sync_read_returns_fresh_compact_evidence()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/runx", false)?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "sync.read",
            ProviderNativeAccess::Read,
            "runxhq/runx",
            &["repo.read".to_owned()],
        )?;
        let mutation = JsonObject::from([
            ("ref".to_owned(), JsonValue::String("issues/442".to_owned())),
            ("op".to_owned(), JsonValue::String("update".to_owned())),
            (
                "payload".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "labels".to_owned(),
                    JsonValue::Array(vec![JsonValue::String("triage".to_owned())]),
                )])),
            ),
        ]);
        let mutation_value = JsonValue::Object(mutation.clone());
        let mutation_digest = sha256_prefixed(&serde_json::to_vec(&mutation_value)?);
        let result = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "sync.read",
            ProviderNativeAccess::Read,
            &JsonObject::from([
                (
                    "sync_ref".to_owned(),
                    JsonValue::String("issues/442".to_owned()),
                ),
                (
                    "mutation_digest".to_owned(),
                    JsonValue::String(mutation_digest),
                ),
                ("mutation".to_owned(), mutation_value),
                (
                    "resources".to_owned(),
                    JsonValue::Array(vec![JsonValue::Object(JsonObject::from([(
                        "ref".to_owned(),
                        JsonValue::String("stale/issues/442".to_owned()),
                    )]))]),
                ),
            ]),
        )?;
        let resource = result
            .get("result")
            .and_then(JsonValue::as_object)
            .and_then(|result| result.get("resources"))
            .and_then(JsonValue::as_array)
            .and_then(|resources| resources.first())
            .and_then(JsonValue::as_object)
            .ok_or("missing fresh sync resource")?;
        assert_eq!(
            resource.get("ref").and_then(JsonValue::as_str),
            Some("issues/442")
        );
        assert!(
            result
                .get("result")
                .and_then(JsonValue::as_object)
                .and_then(|result| result.get("resources"))
                .is_some_and(|resources| !serde_json::to_string(resources)
                    .unwrap_or_default()
                    .contains("stale/issues/442"))
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_batch_reuses_one_mutation_envelope_per_item()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/runx", false)?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "sync.write_batch",
            ProviderNativeAccess::Mutate,
            "runxhq/runx",
            &["repo.write".to_owned()],
        )?;
        let mutation = JsonObject::from([
            ("ref".to_owned(), JsonValue::String("issues/442".to_owned())),
            ("op".to_owned(), JsonValue::String("update".to_owned())),
            (
                "payload".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "labels".to_owned(),
                    JsonValue::Array(vec![JsonValue::String("triage".to_owned())]),
                )])),
            ),
        ]);
        let readback = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "sync.write_batch",
            ProviderNativeAccess::Mutate,
            &JsonObject::from([
                (
                    "mutations".to_owned(),
                    JsonValue::Array(vec![JsonValue::Object(mutation)]),
                ),
                (
                    "idempotency_key".to_owned(),
                    JsonValue::String("runx:sha256:batch-test".to_owned()),
                ),
            ]),
        )?;
        let result = readback
            .get("result")
            .and_then(JsonValue::as_object)
            .ok_or("missing batch result")?;
        assert_eq!(
            result.get("batch_status").and_then(JsonValue::as_str),
            Some("applied")
        );
        let item = result
            .get("mutations")
            .and_then(JsonValue::as_array)
            .and_then(|items| items.first())
            .and_then(JsonValue::as_object)
            .ok_or("missing batch item")?;
        assert_eq!(
            item.get("status").and_then(JsonValue::as_str),
            Some("applied")
        );
        assert_eq!(
            item.get("sync_ref").and_then(JsonValue::as_str),
            Some("issues/442")
        );
        assert_eq!(
            item.get("resource")
                .and_then(JsonValue::as_object)
                .and_then(|resource| resource.get("ref"))
                .and_then(JsonValue::as_str),
            Some("issues/442")
        );
        let log = fs::read_to_string(fixture.log_path())?;
        assert_eq!(log.lines().count(), 3, "preflight, mutation, readback");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_batch_readback_reconciles_unknown_items_before_retry()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/runx", false)?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "sync.read",
            ProviderNativeAccess::Read,
            "runxhq/runx",
            &["repo.read".to_owned()],
        )?;
        let mutation = JsonObject::from([
            ("ref".to_owned(), JsonValue::String("issues/442".to_owned())),
            ("op".to_owned(), JsonValue::String("update".to_owned())),
            (
                "payload".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "labels".to_owned(),
                    JsonValue::Array(vec![JsonValue::String("triage".to_owned())]),
                )])),
            ),
        ]);
        let mutation_value = JsonValue::Object(mutation.clone());
        let mutation_digest = sha256_prefixed(&serde_json::to_vec(&mutation_value)?);
        let result = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "sync.read",
            ProviderNativeAccess::Read,
            &JsonObject::from([
                (
                    "batch_digest".to_owned(),
                    JsonValue::String("sha256:batch".to_owned()),
                ),
                (
                    "mutations".to_owned(),
                    JsonValue::Array(vec![JsonValue::Object(JsonObject::from([
                        ("status".to_owned(), JsonValue::String("unknown".to_owned())),
                        (
                            "sync_ref".to_owned(),
                            JsonValue::String("issues/442".to_owned()),
                        ),
                        (
                            "mutation_digest".to_owned(),
                            JsonValue::String(mutation_digest),
                        ),
                        ("mutation".to_owned(), mutation_value),
                        ("resource".to_owned(), JsonValue::Null),
                    ]))]),
                ),
            ]),
        )?;
        let batch = result
            .get("result")
            .and_then(JsonValue::as_object)
            .ok_or("missing reconciled batch result")?;
        assert_eq!(
            batch.get("batch_status").and_then(JsonValue::as_str),
            Some("applied")
        );
        assert_eq!(
            batch
                .get("mutations")
                .and_then(JsonValue::as_array)
                .and_then(|items| items.first())
                .and_then(JsonValue::as_object)
                .and_then(|item| item.get("status"))
                .and_then(JsonValue::as_str),
            Some("applied")
        );
        let log = fs::read_to_string(fixture.log_path())?;
        assert_eq!(log.lines().count(), 2, "preflight plus reconciliation read");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_thread_mutation_returns_comment_ref_for_sync_readback()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/runx", false)?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "threads.write",
            ProviderNativeAccess::Mutate,
            "runxhq/runx",
            &["repo.write".to_owned()],
        )?;
        let mutation = JsonObject::from([
            (
                "ref".to_owned(),
                JsonValue::String("issues/442/comments".to_owned()),
            ),
            ("op".to_owned(), JsonValue::String("comment".to_owned())),
            (
                "payload".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "body".to_owned(),
                    JsonValue::String("Applied once.".to_owned()),
                )])),
            ),
        ]);
        let mut write_input = JsonObject::from([
            ("mutation".to_owned(), JsonValue::Object(mutation.clone())),
            (
                "idempotency_key".to_owned(),
                JsonValue::String("runx:sha256:thread-write".to_owned()),
            ),
        ]);
        let write = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "threads.write",
            ProviderNativeAccess::Mutate,
            &write_input,
        )?;
        assert_eq!(
            write
                .get("result")
                .and_then(JsonValue::as_object)
                .and_then(|result| result.get("sync_ref"))
                .and_then(JsonValue::as_str),
            Some("issues/comments/9001")
        );

        write_input.extend(
            write
                .get("result")
                .and_then(JsonValue::as_object)
                .cloned()
                .unwrap_or_default(),
        );
        let read = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "sync.read",
            ProviderNativeAccess::Read,
            &write_input,
        )?;
        assert_eq!(
            read.get("result")
                .and_then(JsonValue::as_object)
                .and_then(|result| result.get("sync_ref"))
                .and_then(JsonValue::as_str),
            Some("issues/comments/9001")
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_pull_request_open_and_read_use_exact_bounded_argv()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/runx", false)?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "pullrequest.open",
            ProviderNativeAccess::Mutate,
            "runxhq/runx",
            &["pr.write".to_owned()],
        )?;
        let input = JsonObject::from([
            (
                "title".to_owned(),
                JsonValue::String("Make issue-to-PR operator-first".to_owned()),
            ),
            (
                "body".to_owned(),
                JsonValue::String("Closes #442.".to_owned()),
            ),
            (
                "head".to_owned(),
                JsonValue::String("fix/442-operator-first".to_owned()),
            ),
            ("base".to_owned(), JsonValue::String("main".to_owned())),
            ("draft".to_owned(), JsonValue::Bool(false)),
            (
                "idempotency_key".to_owned(),
                JsonValue::String("runx:sha256:pr-open".to_owned()),
            ),
        ]);
        let opened = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "pullrequest.open",
            ProviderNativeAccess::Mutate,
            &input,
        )?;
        assert_eq!(
            opened.get("operation_id").and_then(JsonValue::as_str),
            Some("pulls/77")
        );
        assert_eq!(
            opened
                .get("result")
                .and_then(JsonValue::as_object)
                .and_then(|result| result.get("head"))
                .and_then(JsonValue::as_str),
            Some("fix/442-operator-first")
        );

        let read = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "pullrequest.read",
            ProviderNativeAccess::Read,
            &JsonObject::from([("number".to_owned(), JsonValue::String("77".to_owned()))]),
        )?;
        assert_eq!(
            read.get("result")
                .and_then(JsonValue::as_object)
                .and_then(|result| result.get("number"))
                .and_then(JsonValue::as_str),
            Some("77")
        );
        let log = fs::read_to_string(fixture.log_path())?;
        assert_eq!(
            log.lines()
                .filter(|line| line.contains("--method POST repos/runxhq/runx/pulls --input -"))
                .count(),
            1
        );
        assert_eq!(
            log.lines()
                .filter(|line| line.contains("--method GET repos/runxhq/runx/pulls/77"))
                .count(),
            1
        );
        let body: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(fixture.body_path())?)?;
        assert_eq!(body["title"], "Make issue-to-PR operator-first");
        assert_eq!(body["head"], "fix/442-operator-first");
        assert_eq!(body["base"], "main");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_publish_pushes_exact_ref_once_and_recovers_by_readback()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/runx", false)?;
        let commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        fixture.install_fake_git(commit)?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "pullrequest.publish",
            ProviderNativeAccess::Mutate,
            "runxhq/runx",
            &["repo.write".to_owned(), "pr.write".to_owned()],
        )?;
        let input = JsonObject::from([
            ("commit".to_owned(), JsonValue::String(commit.to_owned())),
            (
                "title".to_owned(),
                JsonValue::String("Make issue-to-PR operator-first".to_owned()),
            ),
            (
                "body".to_owned(),
                JsonValue::String("Closes #442.".to_owned()),
            ),
            (
                "head".to_owned(),
                JsonValue::String("fix/442-operator-first".to_owned()),
            ),
            ("base".to_owned(), JsonValue::String("main".to_owned())),
            ("draft".to_owned(), JsonValue::Bool(false)),
            (
                "idempotency_key".to_owned(),
                JsonValue::String("runx:sha256:publish".to_owned()),
            ),
        ]);

        for _ in 0..2 {
            let published = invoke(
                &env,
                fixture.root.path(),
                &binding,
                "pullrequest.publish",
                ProviderNativeAccess::Mutate,
                &input,
            )?;
            assert_eq!(
                published
                    .get("result")
                    .and_then(JsonValue::as_object)
                    .and_then(|result| result.get("published_commit"))
                    .and_then(JsonValue::as_str),
                Some(commit)
            );
        }
        let git_log = fs::read_to_string(fixture.root.path().join("git-argv.log"))?;
        assert_eq!(
            git_log
                .lines()
                .filter(|line| line.contains("push --porcelain origin"))
                .count(),
            1,
            "retry must reuse remote ref readback instead of pushing twice"
        );
        let gh_log = fs::read_to_string(fixture.log_path())?;
        assert_eq!(
            gh_log
                .lines()
                .filter(|line| line.contains("--method POST repos/runxhq/runx/pulls"))
                .count(),
            1,
            "retry must reuse the matching open PR"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_mutation_fails_when_independent_readback_does_not_match()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::with_readback_label("runxhq/runx", "wrong")?;
        let env = fixture.env();
        let binding = preflight(
            &env,
            fixture.root.path(),
            "issues.write",
            ProviderNativeAccess::Mutate,
            "runxhq/runx",
            &["repo.write".to_owned()],
        )?;
        let input = JsonObject::from([
            (
                "mutation".to_owned(),
                JsonValue::Object(JsonObject::from([
                    ("ref".to_owned(), JsonValue::String("issues/442".to_owned())),
                    ("op".to_owned(), JsonValue::String("update".to_owned())),
                    (
                        "payload".to_owned(),
                        JsonValue::Object(JsonObject::from([(
                            "labels".to_owned(),
                            JsonValue::Array(vec![JsonValue::String("triage".to_owned())]),
                        )])),
                    ),
                ])),
            ),
            (
                "idempotency_key".to_owned(),
                JsonValue::String("runx:sha256:readback-mismatch".to_owned()),
            ),
        ]);
        let Err(error) = invoke(
            &env,
            fixture.root.path(),
            &binding,
            "issues.write",
            ProviderNativeAccess::Mutate,
            &input,
        ) else {
            return Err("mismatched readback unexpectedly passed".into());
        };
        assert!(error.to_string().contains("did not match"));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn local_github_rejects_injection_missing_executable_timeout_and_wrong_repository()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = FakeGh::new("runxhq/other", false)?;
        let env = fixture.env();
        assert!(resolve_target(&env, fixture.root.path(), "runxhq/runx;touch-no").is_err());
        assert!(GithubOperation::parse("issues.read;touch-no").is_err());
        let Err(wrong) = preflight(
            &env,
            fixture.root.path(),
            "issue.read",
            ProviderNativeAccess::Read,
            "runxhq/runx",
            &["repo.read".to_owned()],
        ) else {
            return Err("wrong repository unexpectedly passed preflight".into());
        };
        assert!(wrong.to_string().contains("not requested repository"));

        let mut missing = env.clone();
        missing.insert("PATH".to_owned(), "/nonexistent".to_owned());
        let Err(error) = preflight(
            &missing,
            fixture.root.path(),
            "issue.read",
            ProviderNativeAccess::Read,
            "runxhq/runx",
            &["repo.read".to_owned()],
        ) else {
            return Err("missing gh unexpectedly passed preflight".into());
        };
        assert!(error.to_string().contains("gh is unavailable"));

        let timeout_fixture = FakeGh::new("runxhq/runx", true)?;
        let mut timeout_env = timeout_fixture.env();
        timeout_env.insert("RUNX_TEST_GH_TIMEOUT_MS".to_owned(), "20".to_owned());
        let Err(error) = preflight(
            &timeout_env,
            timeout_fixture.root.path(),
            "issue.read",
            ProviderNativeAccess::Read,
            "runxhq/runx",
            &["repo.read".to_owned()],
        ) else {
            return Err("timed out gh unexpectedly passed preflight".into());
        };
        assert!(error.to_string().contains("runtime bound"));
        Ok(())
    }

    #[cfg(unix)]
    struct FakeGh {
        root: tempfile::TempDir,
    }

    #[cfg(unix)]
    impl FakeGh {
        fn new(repository: &str, delay: bool) -> Result<Self, Box<dyn std::error::Error>> {
            Self::build(repository, delay, "triage")
        }

        fn with_readback_label(
            repository: &str,
            readback_label: &str,
        ) -> Result<Self, Box<dyn std::error::Error>> {
            Self::build(repository, false, readback_label)
        }

        fn build(
            repository: &str,
            delay: bool,
            readback_label: &str,
        ) -> Result<Self, Box<dyn std::error::Error>> {
            let root = tempfile::tempdir()?;
            let gh = root.path().join("gh");
            let delay = if delay { "/bin/sleep 1\n" } else { "" };
            fs::write(
                &gh,
                format!(
                    r#"#!/bin/sh
dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd)
printf '%s\n' "$*" >> "$dir/argv.log"
case "$*" in
  *graphql*)
    /bin/cat >/dev/null
    {delay}printf '%s\n' '{{"data":{{"viewer":{{"id":"U_1","login":"operator"}},"repository":{{"nameWithOwner":"{repository}","viewerPermission":"WRITE"}}}}}}'
    ;;
  *"--method POST repos/runxhq/runx/pulls"*)
    /bin/cat > "$dir/body.json"
    : > "$dir/pr-created"
    printf '%s\n' '{{"number":77,"title":"Make issue-to-PR operator-first","state":"open","body":"Closes #442.","html_url":"https://github.test/runxhq/runx/pull/77","head":{{"ref":"fix/442-operator-first","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"base":{{"ref":"main"}},"draft":false}}'
    ;;
  *"--method GET repos/runxhq/runx/pulls/77"*)
    printf '%s\n' '{{"number":77,"title":"Make issue-to-PR operator-first","state":"open","body":"Closes #442.","html_url":"https://github.test/runxhq/runx/pull/77","head":{{"ref":"fix/442-operator-first","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"base":{{"ref":"main"}},"draft":false}}'
    ;;
  *"--method GET repos/runxhq/runx/pulls?"*)
    if [ -f "$dir/pr-created" ]; then
      printf '%s\n' '[{{"number":77,"title":"Make issue-to-PR operator-first","state":"open","body":"Closes #442.","html_url":"https://github.test/runxhq/runx/pull/77","head":{{"ref":"fix/442-operator-first","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"base":{{"ref":"main"}},"draft":false}}]'
    else
      printf '%s\n' '[]'
    fi
    ;;
  *"--method PATCH"*)
    /bin/cat > "$dir/body.json"
    printf '%s\n' '{{"number":442,"title":"Operator contract","state":"open","body":"body","html_url":"https://github.test/runxhq/runx/issues/442","labels":[{{"name":"triage"}}]}}'
    ;;
  *"--method POST repos/runxhq/runx/issues/442/comments"*)
    /bin/cat > "$dir/body.json"
    printf '%s\n' '{{"id":9001,"body":"Applied once.","issue_url":"https://github.test/repos/runxhq/runx/issues/442","html_url":"https://github.test/runxhq/runx/issues/442#issuecomment-9001"}}'
    ;;
  *"--method GET repos/runxhq/runx/issues/comments/9001"*)
    printf '%s\n' '{{"id":9001,"body":"Applied once.","issue_url":"https://github.test/repos/runxhq/runx/issues/442","html_url":"https://github.test/runxhq/runx/issues/442#issuecomment-9001"}}'
    ;;
  *"repos/runxhq/runx/issues/442"*)
    printf '%s\n' '{{"number":442,"title":"Operator contract","state":"open","body":"body","html_url":"https://github.test/runxhq/runx/issues/442","labels":[{{"name":"{readback_label}"}}]}}'
    ;;
  *)
    printf '%s\n' '{{"message":"unexpected fake gh invocation"}}' >&2
    exit 2
    ;;
esac
"#
                ),
            )?;
            let mut permissions = fs::metadata(&gh)?.permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&gh, permissions)?;
            Ok(Self { root })
        }

        fn install_fake_git(&self, commit: &str) -> Result<(), Box<dyn std::error::Error>> {
            let git = self.root.path().join("git");
            fs::write(
                &git,
                format!(
                    r#"#!/bin/sh
dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd)
printf '%s\n' "$*" >> "$dir/git-argv.log"
case "$*" in
  *"remote get-url origin"*)
    printf '%s\n' 'https://github.com/runxhq/runx.git'
    ;;
  *"rev-parse --verify"*)
    printf '%s\n' '{commit}'
    ;;
  *"ls-remote --refs origin"*)
    if [ -f "$dir/git-remote-state" ]; then /bin/cat "$dir/git-remote-state"; fi
    ;;
  *"push --porcelain origin"*)
    for arg do last=$arg; done
    ref=${{last#*:}}
    printf '%s\t%s\n' '{commit}' "$ref" > "$dir/git-remote-state"
    ;;
  *)
    printf '%s\n' 'unexpected fake git invocation' >&2
    exit 2
    ;;
esac
"#
                ),
            )?;
            let mut permissions = fs::metadata(&git)?.permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&git, permissions)?;
            Ok(())
        }

        fn env(&self) -> BTreeMap<String, String> {
            BTreeMap::from([
                (
                    "PATH".to_owned(),
                    self.root.path().to_string_lossy().into_owned(),
                ),
                (
                    "HOME".to_owned(),
                    self.root.path().to_string_lossy().into_owned(),
                ),
                (
                    crate::RUNX_CWD_ENV.to_owned(),
                    self.root.path().to_string_lossy().into_owned(),
                ),
            ])
        }

        fn log_path(&self) -> PathBuf {
            self.root.path().join("argv.log")
        }

        fn body_path(&self) -> PathBuf {
            self.root.path().join("body.json")
        }
    }
}
