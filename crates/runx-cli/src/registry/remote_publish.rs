use std::collections::BTreeMap;
use std::path::Path;

use runx_runtime::registry::{
    HttpMethod, HttpRequest, HttpResponse, RegistryPublishHarnessReport, RuntimeHttpHeader,
    Transport,
};

#[cfg(test)]
use super::package::HostedSkillPackageFile;
use super::package::SkillPackage;
use super::{RegistryCliError, RegistryPlan, internal_error, usage_error};

mod payloads;

pub(super) use payloads::HostedSkillPublishResult;
use payloads::{
    HostedAdminSkillPublishEnvelope, HostedAdminSkillPublishRequest, HostedSkillPublishEnvelope,
    HostedSkillPublishRequest,
};

pub(super) fn publish_remote_skill_package(
    registry_url: &str,
    plan: &RegistryPlan,
    package: &SkillPackage,
    harness: &RegistryPublishHarnessReport,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<HostedSkillPublishResult, RegistryCliError> {
    if plan.trust_tier.is_some() {
        return Err(usage_error(
            "remote registry publish derives trust from hosted verification; --trust-tier is local-only",
        ));
    }
    if admin_publish_requested(plan) {
        let token = admin_publish_token(env).ok_or_else(|| {
            usage_error(
                "remote registry admin publish requires RUNX_HOSTED_REGISTRY_PUBLISH_TOKEN or RUNX_HOSTED_API_ADMIN_TOKEN",
            )
        })?;
        let owner = admin_publish_owner(plan, env)?;
        let transport = crate::public_api::transport(registry_private_network_allowed(env))
            .map_err(|error| internal_error(error.to_string()))?;
        return publish_remote_admin_skill_package_with_transport(
            &transport,
            registry_url,
            &token,
            &AdminPublishTarget {
                owner: &owner,
                version: plan.version.as_deref(),
                upsert: plan.upsert,
            },
            package,
            harness,
        );
    }
    let environment =
        crate::public_api::ApiEnvironment::resolve(Some(registry_url), None, env, cwd)
            .map_err(|error| usage_error(error.to_string()))?;
    let transport = crate::public_api::transport(registry_private_network_allowed(env))
        .map_err(|error| internal_error(error.to_string()))?;
    let authenticated = environment
        .authenticate(&transport)
        .map_err(|error| usage_error(error.to_string()))?;
    publish_remote_skill_package_with_transport(
        &transport,
        authenticated.base_url(),
        authenticated.token(),
        plan.version.as_deref(),
        package,
    )
}

fn admin_publish_requested(plan: &RegistryPlan) -> bool {
    plan.owner.is_some() || plan.upsert
}

fn admin_publish_token(env: &BTreeMap<String, String>) -> Option<String> {
    [
        "RUNX_HOSTED_REGISTRY_PUBLISH_TOKEN",
        "RUNX_HOSTED_API_ADMIN_TOKEN",
    ]
    .iter()
    .find_map(|name| {
        env.get(*name)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn admin_publish_owner(
    plan: &RegistryPlan,
    env: &BTreeMap<String, String>,
) -> Result<String, RegistryCliError> {
    plan.owner
        .as_deref()
        .or_else(|| {
            env.get("RUNX_HOSTED_REGISTRY_PUBLISH_OWNER")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            usage_error("remote registry admin publish requires --owner or RUNX_HOSTED_REGISTRY_PUBLISH_OWNER")
        })
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
    if envelope.status != "success" || envelope.publish.status != "published" {
        return Err(internal_error(format!(
            "remote registry publish returned unsuccessful status: envelope={}, publish={}",
            envelope.status, envelope.publish.status
        )));
    }
    Ok(envelope.publish)
}

pub(super) struct AdminPublishTarget<'a> {
    pub(super) owner: &'a str,
    pub(super) version: Option<&'a str>,
    pub(super) upsert: bool,
}

pub(super) fn publish_remote_admin_skill_package_with_transport<T: Transport>(
    transport: &T,
    registry_url: &str,
    token: &str,
    target: &AdminPublishTarget<'_>,
    package: &SkillPackage,
    harness: &RegistryPublishHarnessReport,
) -> Result<HostedSkillPublishResult, RegistryCliError> {
    let body = hosted_admin_publish_request_body(target, package, harness)?;
    let response = send_hosted_admin_publish_request(transport, registry_url, token, body)?;
    parse_hosted_admin_publish_response(response)
}

fn hosted_admin_publish_request_body(
    target: &AdminPublishTarget<'_>,
    package: &SkillPackage,
    harness: &RegistryPublishHarnessReport,
) -> Result<String, RegistryCliError> {
    serde_json::to_string(&HostedAdminSkillPublishRequest {
        owner: target.owner,
        markdown: &package.markdown,
        profile_document: package.profile_document.as_deref(),
        version: target.version,
        upsert: target.upsert,
        package_files: &package.package_files,
        harness,
    })
    .map_err(|error| internal_error(error.to_string()))
}

fn send_hosted_admin_publish_request<T: Transport>(
    transport: &T,
    registry_url: &str,
    token: &str,
    body: String,
) -> Result<HttpResponse, RegistryCliError> {
    transport
        .send(HttpRequest {
            method: HttpMethod::Post,
            url: format!(
                "{}/v1/admin/registry/publish",
                registry_url.trim_end_matches('/')
            ),
            headers: vec![
                RuntimeHttpHeader::new("authorization", format!("Bearer {token}")),
                RuntimeHttpHeader::new("content-type", "application/json"),
            ],
            body: Some(body),
        })
        .map_err(|error| internal_error(error.to_string()))
}

fn parse_hosted_admin_publish_response(
    response: HttpResponse,
) -> Result<HostedSkillPublishResult, RegistryCliError> {
    if !(200..=299).contains(&response.status) {
        if let Some(error) = crate::public_api::parse_error(&response.body) {
            return Err(internal_error(format!(
                "remote registry admin publish failed [{}]: {}",
                error.code, error.detail
            )));
        }
        return Err(internal_error(format!(
            "remote registry admin publish returned HTTP {}: {}",
            response.status, response.body
        )));
    }
    let envelope = serde_json::from_str::<HostedAdminSkillPublishEnvelope>(&response.body)
        .map_err(|error| {
            internal_error(format!(
                "remote registry admin publish returned invalid JSON: {error}"
            ))
        })?;
    if envelope.status != "success"
        || !matches!(envelope.publish.status.as_str(), "published" | "unchanged")
    {
        return Err(internal_error(format!(
            "remote registry admin publish returned unsuccessful status: envelope={}, publish={}",
            envelope.status, envelope.publish.status
        )));
    }
    Ok(envelope.publish.into_hosted_result())
}

fn registry_private_network_allowed(env: &BTreeMap<String, String>) -> bool {
    crate::public_api::private_network_allowed(false, env)
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
                    "install_command": "runx add kam/hello@sha-123",
                    "run_command": "runx skill kam/hello@sha-123",
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
        let profile_document = package
            .profile_document
            .as_deref()
            .ok_or("profile document missing")?;
        assert_eq!(body["profile_document"], profile_document);
        assert_eq!(body["version"], "sha-123");
        assert_eq!(body["package_files"][0]["path"], "run.mjs");
        assert_eq!(
            body["package_files"][0]["content"],
            "console.log('hello');\n"
        );
        Ok(())
    }

    #[test]
    fn remote_registry_publish_rejects_unsuccessful_2xx_envelope()
    -> Result<(), Box<dyn std::error::Error>> {
        let transport = StubTransport::new(HttpResponse {
            status: 200,
            body: serde_json::json!({
                "status": "failure",
                "publish": {
                    "status": "rejected",
                    "skill_id": "kam/hello",
                    "owner": "kam",
                    "name": "hello",
                    "version": "sha-123",
                    "digest": "abc",
                    "trust_tier": "community",
                    "install_command": "runx add kam/hello@sha-123",
                    "run_command": "runx skill kam/hello@sha-123",
                    "public_url": "https://runx.test/x/kam/hello"
                }
            })
            .to_string(),
        });
        let package = SkillPackage {
            markdown: "---\nname: hello\nsource:\n  type: cli-tool\n  command: echo\n---\nHello.\n"
                .to_owned(),
            profile_document: None,
            harness_path: None,
            harness_temp_dir: None,
            package_files: Vec::new(),
        };

        let result = publish_remote_skill_package_with_transport(
            &transport,
            "https://runx.test/",
            "rxk_secret",
            None,
            &package,
        );
        let Err(error) = result else {
            return Err("unsuccessful 2xx envelope must be rejected".into());
        };

        assert!(error.to_string().contains("unsuccessful status"));
        Ok(())
    }

    #[test]
    fn remote_registry_admin_publish_posts_owner_harness_and_upsert()
    -> Result<(), Box<dyn std::error::Error>> {
        let transport = StubTransport::new(HttpResponse {
            status: 200,
            body: serde_json::json!({
                "status": "success",
                "publish": {
                    "status": "published",
                    "skill_id": "runx/hello",
                    "name": "hello",
                    "version": "sha-123",
                    "digest": "abc",
                    "profile_digest": "profile-abc",
                    "link": {
                        "link": "runx://skill/runx%2Fhello@sha-123",
                        "install_command": "runx add runx/hello@sha-123",
                        "run_command": "runx skill runx/hello@sha-123"
                    },
                    "record": {
                        "owner": "runx",
                        "trust_tier": "first_party"
                    }
                },
                "harness": {
                    "status": "passed",
                    "case_count": 1,
                    "assertion_error_count": 0,
                    "assertion_errors": [],
                    "case_names": ["smoke"],
                    "receipt_ids": ["rx_harness_1"],
                    "graph_case_count": 0
                }
            })
            .to_string(),
        });
        let package = SkillPackage {
            markdown: "---\nname: hello\n---\nHello.\n".to_owned(),
            profile_document: Some("skill: hello\nrunners: {}\n".to_owned()),
            harness_path: None,
            harness_temp_dir: None,
            package_files: vec![HostedSkillPackageFile {
                path: "run.mjs".to_owned(),
                content: "console.log('hello');\n".to_owned(),
            }],
        };
        let harness = RegistryPublishHarnessReport {
            status: "passed".to_owned(),
            case_count: 1,
            assertion_error_count: 0,
            assertion_errors: Vec::new(),
            case_names: vec!["smoke".to_owned()],
            receipt_ids: vec!["rx_harness_1".to_owned()],
            graph_case_count: 0,
        };

        let result = publish_remote_admin_skill_package_with_transport(
            &transport,
            "https://runx.test/",
            "admin-token",
            &AdminPublishTarget {
                owner: "runx",
                version: Some("sha-123"),
                upsert: true,
            },
            &package,
            &harness,
        )?;

        assert_eq!(result.skill_id, "runx/hello");
        assert_eq!(result.owner, "runx");
        assert_eq!(result.trust_tier, "first_party");
        assert_eq!(result.public_url, "https://runx.ai/x/runx/hello@sha-123");
        let requests = transport.requests.borrow();
        assert_eq!(requests[0].method, HttpMethod::Post);
        assert_eq!(
            requests[0].url,
            "https://runx.test/v1/admin/registry/publish"
        );
        let body: serde_json::Value =
            serde_json::from_str(requests[0].body.as_deref().unwrap_or_default())?;
        assert_eq!(body["owner"], "runx");
        assert_eq!(body["version"], "sha-123");
        assert_eq!(body["upsert"], true);
        assert_eq!(body["harness"]["status"], "passed");
        assert_eq!(body["package_files"][0]["path"], "run.mjs");
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
            self.response
                .borrow_mut()
                .take()
                .ok_or_else(|| RuntimeHttpError::Transport {
                    message: "missing stub response".to_owned(),
                })
        }
    }
}
