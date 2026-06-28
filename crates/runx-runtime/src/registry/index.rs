//! Cloud registry index endpoint (`POST /v1/index`).
//!
//! This module is the canonical client for indexing a GitHub repository into
//! the hosted runx registry. It is consumed by the `runx add <github-url>` CLI
//! path and by any future flow that needs to publish a remote repo through the
//! hosted index. Single responsibility: parse a GitHub ref, POST it, return a
//! typed envelope; presentation and arg parsing live in the CLI.

use serde::{Deserialize, Serialize};
use url::Url;

use super::types::TrustTier;
use crate::http::{
    HttpMethod, RuntimeHttpError, RuntimeHttpHeader, RuntimeHttpRequest as HttpRequest,
    RuntimeHttpTransport as Transport,
};

/// Structured GitHub repository reference parsed from a user-provided URL.
///
/// Returning a structured value (rather than a `bool` predicate over the raw
/// string) lets callers show a friendly progress message and validates that the
/// URL has both owner and repo segments before the network call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubRepoRef {
    /// Canonical `https://github.com/<owner>/<repo>` form of the input.
    pub canonical_url: String,
    pub owner: String,
    pub repo: String,
}

/// Inputs to [`index_github_repo`]. Borrowed so callers don't have to clone.
#[derive(Clone, Debug)]
pub struct IndexGithubRepoOptions<'a> {
    /// Base URL of the hosted registry (no trailing slash required).
    pub base_url: &'a str,
    /// The repo URL to send to the cloud (canonical form preferred).
    pub repo_url: &'a str,
    /// Optional branch/tag forwarded as `ref` in the request body.
    pub repo_ref: Option<&'a str>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct IndexedRepo {
    pub owner: String,
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sha: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct IndexedListing {
    pub owner: String,
    pub name: String,
    pub skill_id: String,
    pub version: String,
    pub permalink: String,
    pub trust_tier: TrustTier,
    pub skill_path: String,
    pub digest_unchanged: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct IndexWarning {
    #[serde(default)]
    pub skill_path: Option<String>,
    pub code: String,
    pub detail: String,
}

/// Successful `POST /v1/index` envelope returned by the cloud.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct IndexResponse {
    pub repo: IndexedRepo,
    pub listings: Vec<IndexedListing>,
    #[serde(default)]
    pub warnings: Vec<IndexWarning>,
}

/// Errors returned by [`parse_github_repo_ref`] and [`index_github_repo`].
///
/// Distinct from [`crate::registry::RegistryClientError`] because the `/v1/index`
/// endpoint has its own error envelope shape (`{ status: "error", error: { code,
/// detail, hint?, retry_after_seconds? } }`) that callers want to match on. We
/// surface those structured fields directly so the CLI can render hints and
/// retry guidance without re-parsing strings.
#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error(
        "'{0}' is not a recognized GitHub repository URL. Expected https://github.com/<owner>/<repo>."
    )]
    NotAGithubRepoUrl(String),
    #[error(transparent)]
    RuntimeHttp(#[from] RuntimeHttpError),
    #[error("runx-api index returned HTTP {status}: {body}")]
    HttpStatus { status: u16, body: String },
    #[error("runx-api index returned invalid JSON: {0}")]
    InvalidJson(String),
    #[error("runx-api index returned error envelope [{code}]: {detail}")]
    RunxApi {
        code: String,
        detail: String,
        hint: Option<String>,
        retry_after_seconds: Option<u32>,
    },
}

/// Parse a user-supplied GitHub repo URL into a structured reference.
///
/// Accepts `https://github.com/<owner>/<repo>[/...]`, the same with `http://`,
/// or bare `github.com/<owner>/<repo>[/...]`. Anything else is rejected.
pub fn parse_github_repo_ref(input: &str) -> Result<GithubRepoRef, IndexError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(IndexError::NotAGithubRepoUrl(input.to_owned()));
    }
    let normalized: String = if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        trimmed.to_owned()
    } else if let Some(rest) = trimmed.strip_prefix("github.com/") {
        format!("https://github.com/{rest}")
    } else {
        return Err(IndexError::NotAGithubRepoUrl(input.to_owned()));
    };
    let parsed =
        Url::parse(&normalized).map_err(|_| IndexError::NotAGithubRepoUrl(input.to_owned()))?;
    if parsed.host_str() != Some("github.com") {
        return Err(IndexError::NotAGithubRepoUrl(input.to_owned()));
    }
    let mut segments = parsed
        .path_segments()
        .map(|iter| iter.filter(|segment| !segment.is_empty()))
        .ok_or_else(|| IndexError::NotAGithubRepoUrl(input.to_owned()))?;
    let owner = segments
        .next()
        .ok_or_else(|| IndexError::NotAGithubRepoUrl(input.to_owned()))?;
    let repo = segments
        .next()
        .ok_or_else(|| IndexError::NotAGithubRepoUrl(input.to_owned()))?;
    Ok(GithubRepoRef {
        canonical_url: format!("https://github.com/{owner}/{repo}"),
        owner: owner.to_owned(),
        repo: repo.to_owned(),
    })
}

/// POST the repo URL to the hosted registry's `/v1/index` endpoint.
///
/// The transport handles timeouts/retries/TLS per the runtime's standard HTTP
/// discipline. Generic over `T: Transport` so tests can inject a stub without
/// touching the network.
pub fn index_github_repo<T: Transport>(
    transport: &T,
    options: &IndexGithubRepoOptions<'_>,
) -> Result<IndexResponse, IndexError> {
    let base = options.base_url.trim_end_matches('/');
    let url = format!("{base}/v1/index");
    let body = serde_json::json!({
        "repo_url": options.repo_url,
        "ref": options.repo_ref,
    })
    .to_string();
    let request = HttpRequest {
        method: HttpMethod::Post,
        url,
        headers: vec![RuntimeHttpHeader {
            name: "content-type".to_owned(),
            value: "application/json".to_owned(),
        }],
        body: Some(body),
    };
    let response = transport.send(request)?;
    if !(200..=299).contains(&response.status) {
        if let Ok(envelope) = serde_json::from_str::<ErrorEnvelope>(&response.body) {
            return Err(IndexError::RunxApi {
                code: envelope.error.code,
                detail: envelope.error.detail,
                hint: envelope.error.hint,
                retry_after_seconds: envelope.error.retry_after_seconds,
            });
        }
        return Err(IndexError::HttpStatus {
            status: response.status,
            body: response.body,
        });
    }
    let envelope: SuccessEnvelope = serde_json::from_str(&response.body)
        .map_err(|error| IndexError::InvalidJson(error.to_string()))?;
    if envelope.status != "success" {
        return Err(IndexError::InvalidJson(format!(
            "expected status \"success\", received \"{}\"",
            envelope.status
        )));
    }
    Ok(IndexResponse {
        repo: envelope.repo,
        listings: envelope.listings,
        warnings: envelope.warnings,
    })
}

#[derive(Deserialize)]
struct SuccessEnvelope {
    status: String,
    repo: IndexedRepo,
    listings: Vec<IndexedListing>,
    #[serde(default)]
    warnings: Vec<IndexWarning>,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorPayload,
}

#[derive(Deserialize)]
struct ErrorPayload {
    code: String,
    detail: String,
    #[serde(default)]
    hint: Option<String>,
    #[serde(default)]
    retry_after_seconds: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_github_url() -> Result<(), IndexError> {
        let parsed = parse_github_repo_ref("https://github.com/runxhq/runx")?;
        assert_eq!(parsed.canonical_url, "https://github.com/runxhq/runx");
        assert_eq!(parsed.owner, "runxhq");
        assert_eq!(parsed.repo, "runx");
        Ok(())
    }

    #[test]
    fn parses_http_url_normalizes_to_https_canonical_form() -> Result<(), IndexError> {
        let parsed = parse_github_repo_ref("http://github.com/runxhq/runx")?;
        assert_eq!(parsed.canonical_url, "https://github.com/runxhq/runx");
        Ok(())
    }

    #[test]
    fn parses_bare_github_form_with_canonical_https_url() -> Result<(), IndexError> {
        let parsed = parse_github_repo_ref("github.com/runxhq/runx")?;
        assert_eq!(parsed.canonical_url, "https://github.com/runxhq/runx");
        assert_eq!(parsed.owner, "runxhq");
        Ok(())
    }

    #[test]
    fn parses_url_with_trailing_path_taking_first_two_segments_only() -> Result<(), IndexError> {
        let parsed = parse_github_repo_ref("https://github.com/runxhq/runx/tree/main/skills")?;
        assert_eq!(parsed.canonical_url, "https://github.com/runxhq/runx");
        assert_eq!(parsed.owner, "runxhq");
        assert_eq!(parsed.repo, "runx");
        Ok(())
    }

    #[test]
    fn trims_whitespace_from_input() -> Result<(), IndexError> {
        let parsed = parse_github_repo_ref("  https://github.com/runxhq/runx  ")?;
        assert_eq!(parsed.canonical_url, "https://github.com/runxhq/runx");
        Ok(())
    }

    #[test]
    fn rejects_non_github_host() {
        let result = parse_github_repo_ref("https://gitlab.com/foo/bar");
        assert!(matches!(result, Err(IndexError::NotAGithubRepoUrl(_))));
    }

    #[test]
    fn rejects_missing_repo_segment() {
        let result = parse_github_repo_ref("https://github.com/runxhq");
        assert!(matches!(result, Err(IndexError::NotAGithubRepoUrl(_))));
    }

    #[test]
    fn rejects_empty_input() {
        assert!(matches!(
            parse_github_repo_ref(""),
            Err(IndexError::NotAGithubRepoUrl(_))
        ));
        assert!(matches!(
            parse_github_repo_ref("   "),
            Err(IndexError::NotAGithubRepoUrl(_))
        ));
    }

    #[test]
    fn rejects_unsupported_scheme() {
        let result = parse_github_repo_ref("ftp://github.com/runxhq/runx");
        assert!(matches!(result, Err(IndexError::NotAGithubRepoUrl(_))));
    }
}
