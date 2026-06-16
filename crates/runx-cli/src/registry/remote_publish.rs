use std::collections::BTreeMap;
use std::path::Path;

use runx_runtime::registry::{HttpMethod, HttpRequest, RuntimeHttpHeader, Transport};
use serde::{Deserialize, Serialize};

use super::package::{HostedSkillPackageFile, SkillPackage};
use super::{RegistryCliError, RegistryPlan, internal_error, usage_error};

pub(super) fn publish_remote_skill_package(
    registry_url: &str,
    plan: &RegistryPlan,
    package: &SkillPackage,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<HostedSkillPublishResult, RegistryCliError> {
    if plan.owner.is_some() {
        return Err(usage_error(
            "remote registry publish derives owner from runx login; --owner is local-only",
        ));
    }
    if plan.trust_tier.is_some() {
        return Err(usage_error(
            "remote registry publish derives trust from hosted verification; --trust-tier is local-only",
        ));
    }
    if plan.upsert {
        return Err(usage_error(
            "remote registry publish does not accept --upsert; publish a new content version",
        ));
    }
    let token = crate::public_api_token::resolve(None, env, cwd)?.ok_or_else(|| {
        usage_error("remote registry publish requires `runx login` or RUNX_PUBLIC_API_TOKEN")
    })?;
    let transport = crate::public_api::transport(registry_private_network_allowed(env))
        .map_err(|error| internal_error(error.to_string()))?;
    publish_remote_skill_package_with_transport(
        &transport,
        registry_url,
        &token,
        plan.version.as_deref(),
        package,
    )
}

pub(super) fn publish_remote_skill_package_with_transport<T: Transport>(
    transport: &T,
    registry_url: &str,
    token: &str,
    version: Option<&str>,
    package: &SkillPackage,
) -> Result<HostedSkillPublishResult, RegistryCliError> {
    let body = serde_json::to_string(&HostedSkillPublishRequest {
        markdown: &package.markdown,
        profile_document: package.profile_document.as_deref(),
        version,
        package_files: &package.package_files,
    })
    .map_err(|error| internal_error(error.to_string()))?;
    let response = transport
        .send(HttpRequest {
            method: HttpMethod::Post,
            url: format!("{}/v1/skills", registry_url.trim_end_matches('/')),
            headers: vec![
                RuntimeHttpHeader::new("authorization", format!("Bearer {token}")),
                RuntimeHttpHeader::new("content-type", "application/json"),
            ],
            body: Some(body),
        })
        .map_err(|error| internal_error(error.to_string()))?;
    if !(200..=299).contains(&response.status) {
        if let Some(error) = crate::public_api::parse_error(&response.body) {
            return Err(internal_error(format!(
                "remote registry publish failed [{}]: {}",
                error.code, error.detail
            )));
        }
        return Err(internal_error(format!(
            "remote registry publish returned HTTP {}: {}",
            response.status, response.body
        )));
    }
    let envelope =
        serde_json::from_str::<HostedSkillPublishEnvelope>(&response.body).map_err(|error| {
            internal_error(format!(
                "remote registry publish returned invalid JSON: {error}"
            ))
        })?;
    Ok(envelope.publish)
}

fn registry_private_network_allowed(env: &BTreeMap<String, String>) -> bool {
    crate::public_api::private_network_allowed(false, env, "RUNX_REGISTRY_ALLOW_LOCAL_API")
}

#[derive(Serialize)]
struct HostedSkillPublishRequest<'a> {
    markdown: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_document: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    package_files: &'a Vec<HostedSkillPackageFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct HostedSkillPublishEnvelope {
    status: String,
    publish: HostedSkillPublishResult,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct HostedSkillPublishResult {
    pub(super) status: String,
    pub(super) skill_id: String,
    pub(super) owner: String,
    pub(super) name: String,
    pub(super) version: String,
    pub(super) digest: String,
    #[serde(default)]
    pub(super) profile_digest: Option<String>,
    pub(super) trust_tier: String,
    pub(super) install_command: String,
    pub(super) run_command: String,
    pub(super) public_url: String,
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use runx_runtime::registry::{
        HttpMethod, HttpRequest, HttpResponse, RuntimeHttpError, Transport,
    };

    use super::*;

    #[test]
    fn remote_registry_publish_posts_skill_artifacts() -> Result<(), Box<dyn std::error::Error>> {
        let transport = StubTransport::new(HttpResponse {
            status: 201,
            body: serde_json::json!({
                "status": "success",
                "publish": {
                    "status": "published",
                    "skill_id": "kam/hello",
                    "owner": "kam",
                    "name": "hello",
                    "version": "sha-123",
                    "digest": "abc",
                    "trust_tier": "community",
                    "install_command": "runx skill add kam/hello@sha-123",
                    "run_command": "runx skill hello",
                    "public_url": "https://runx.test/x/kam/hello"
                }
            })
            .to_string(),
        });
        let package = SkillPackage {
            markdown: "---\nname: hello\nsource:\n  type: cli-tool\n  command: echo\n---\nHello.\n"
                .to_owned(),
            profile_document: Some("skill: hello\nversion: \"0.1.0\"\nrunners: {}\n".to_owned()),
            harness_path: None,
            harness_temp_dir: None,
            package_files: vec![HostedSkillPackageFile {
                path: "run.mjs".to_owned(),
                content: "console.log('hello');\n".to_owned(),
            }],
        };

        let result = publish_remote_skill_package_with_transport(
            &transport,
            "https://runx.test/",
            "rxk_secret",
            Some("sha-123"),
            &package,
        )?;

        assert_eq!(result.skill_id, "kam/hello");
        let requests = transport.requests.borrow();
        assert_eq!(requests[0].method, HttpMethod::Post);
        assert_eq!(requests[0].url, "https://runx.test/v1/skills");
        assert!(requests[0].headers.iter().any(|header| {
            header.name == "authorization" && header.value == "Bearer rxk_secret"
        }));
        let body: serde_json::Value =
            serde_json::from_str(requests[0].body.as_deref().unwrap_or_default())?;
        assert_eq!(body["markdown"], package.markdown);
        assert_eq!(body["profile_document"], package.profile_document.unwrap());
        assert_eq!(body["version"], "sha-123");
        assert_eq!(body["package_files"][0]["path"], "run.mjs");
        assert_eq!(
            body["package_files"][0]["content"],
            "console.log('hello');\n"
        );
        Ok(())
    }

    struct StubTransport {
        requests: RefCell<Vec<HttpRequest>>,
        response: RefCell<Option<HttpResponse>>,
    }

    impl StubTransport {
        fn new(response: HttpResponse) -> Self {
            Self {
                requests: RefCell::new(Vec::new()),
                response: RefCell::new(Some(response)),
            }
        }
    }

    impl Transport for StubTransport {
        fn send(&self, request: HttpRequest) -> Result<HttpResponse, RuntimeHttpError> {
            self.requests.borrow_mut().push(request);
            Ok(self.response.borrow_mut().take().expect("stub response"))
        }
    }
}
