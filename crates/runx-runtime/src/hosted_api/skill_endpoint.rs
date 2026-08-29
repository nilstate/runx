use url::Url;

use crate::http::{
    HttpMethod, ReqwestHttpTransport, RuntimeHttpError, RuntimeHttpRequest, RuntimeHttpResponse,
    RuntimeHttpTransport,
};

const MAX_HOSTED_SKILL_CHALLENGE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug)]
pub struct HostedSkillChallenge {
    pub resource_url: String,
    pub response: RuntimeHttpResponse,
}

#[derive(Debug, thiserror::Error)]
pub enum HostedSkillEndpointError {
    #[error(transparent)]
    Http(#[from] RuntimeHttpError),
    #[error("invalid hosted skill id: {0}")]
    InvalidSkillId(String),
    #[error("invalid hosted skill base URL: {0}")]
    InvalidBaseUrl(String),
}

/// Request the bounded challenge for one hosted skill endpoint. The runtime
/// owns URL construction, guarded transport selection, and response bounds;
/// callers own presentation of the returned protocol payload.
pub fn request_hosted_skill_challenge(
    base_url: &str,
    skill_id: &str,
    allow_private_network: bool,
) -> Result<HostedSkillChallenge, HostedSkillEndpointError> {
    let transport = if allow_private_network {
        ReqwestHttpTransport::with_private_network_access()?
    } else {
        ReqwestHttpTransport::new()?
    };
    request_hosted_skill_challenge_with_transport(&transport, base_url, skill_id)
}

fn request_hosted_skill_challenge_with_transport<T: RuntimeHttpTransport + ?Sized>(
    transport: &T,
    base_url: &str,
    skill_id: &str,
) -> Result<HostedSkillChallenge, HostedSkillEndpointError> {
    let resource_url = hosted_skill_resource_url(base_url, skill_id)?;
    let response = transport.send_limited(
        RuntimeHttpRequest {
            method: HttpMethod::Post,
            url: resource_url.clone(),
            headers: Vec::new(),
            body: None,
        },
        MAX_HOSTED_SKILL_CHALLENGE_BYTES,
    )?;
    Ok(HostedSkillChallenge {
        resource_url,
        response,
    })
}

fn hosted_skill_resource_url(
    base_url: &str,
    skill_id: &str,
) -> Result<String, HostedSkillEndpointError> {
    let (owner, name) = crate::registry::split_skill_id(skill_id)
        .map_err(|error| HostedSkillEndpointError::InvalidSkillId(error.to_string()))?;
    let mut url = Url::parse(base_url)
        .map_err(|error| HostedSkillEndpointError::InvalidBaseUrl(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.cannot_be_a_base() {
        return Err(HostedSkillEndpointError::InvalidBaseUrl(
            "URL must use HTTP(S) and support path segments".to_owned(),
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .map_err(|_| {
            HostedSkillEndpointError::InvalidBaseUrl(
                "URL cannot carry hosted skill routes".to_owned(),
            )
        })?
        .pop_if_empty()
        .extend(["v1", "skills", owner, name, "run"]);
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct StubTransport {
        response: RuntimeHttpResponse,
        requests: RefCell<Vec<RuntimeHttpRequest>>,
    }

    impl RuntimeHttpTransport for StubTransport {
        fn send(
            &self,
            request: RuntimeHttpRequest,
        ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
            self.requests.borrow_mut().push(request);
            Ok(self.response.clone())
        }
    }

    #[test]
    fn hosted_skill_challenge_uses_the_bounded_runtime_transport()
    -> Result<(), Box<dyn std::error::Error>> {
        let transport = StubTransport {
            response: RuntimeHttpResponse::new(402, "{}"),
            requests: RefCell::new(Vec::new()),
        };

        let challenge = request_hosted_skill_challenge_with_transport(
            &transport,
            "https://api.runx.test/registry?ignored=yes#fragment",
            "ausca/document-ocr",
        )?;

        assert_eq!(
            challenge.resource_url,
            "https://api.runx.test/registry/v1/skills/ausca/document-ocr/run"
        );
        let requests = transport.requests.borrow();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, HttpMethod::Post);
        assert_eq!(requests[0].url, challenge.resource_url);
        assert!(requests[0].headers.is_empty());
        assert!(requests[0].body.is_none());
        Ok(())
    }

    #[test]
    fn hosted_skill_challenge_rejects_invalid_identity_before_transport() {
        let transport = StubTransport {
            response: RuntimeHttpResponse::new(402, "{}"),
            requests: RefCell::new(Vec::new()),
        };

        let result = request_hosted_skill_challenge_with_transport(
            &transport,
            "https://api.runx.test",
            "../escape",
        );

        assert!(matches!(
            result,
            Err(HostedSkillEndpointError::InvalidSkillId(_))
        ));
        assert!(transport.requests.borrow().is_empty());
    }

    #[test]
    fn hosted_skill_challenge_rejects_an_oversized_response() {
        let transport = StubTransport {
            response: RuntimeHttpResponse::new(
                402,
                "x".repeat(MAX_HOSTED_SKILL_CHALLENGE_BYTES + 1),
            ),
            requests: RefCell::new(Vec::new()),
        };

        let result = request_hosted_skill_challenge_with_transport(
            &transport,
            "https://api.runx.test",
            "ausca/document-ocr",
        );

        assert!(matches!(
            result,
            Err(HostedSkillEndpointError::Http(
                RuntimeHttpError::ResponseBodyTooLarge {
                    limit: MAX_HOSTED_SKILL_CHALLENGE_BYTES
                }
            ))
        ));
    }
}
