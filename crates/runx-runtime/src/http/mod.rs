// Module rationale: the runtime HTTP transport keeps
// reqwest wiring, SSRF guards, response limits, and security-focused unit tests
// in one review unit.
mod types;

#[cfg(feature = "async-http")]
use std::collections::BTreeMap;
#[cfg(feature = "async-http")]
use std::error::Error as StdError;
#[cfg(feature = "async-http")]
use std::fmt;
#[cfg(feature = "async-http")]
use std::net::SocketAddr;
#[cfg(any(feature = "async-http", test))]
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
#[cfg(feature = "async-http")]
use std::sync::{Mutex, OnceLock};
#[cfg(feature = "async-http")]
use std::time::Duration;

#[cfg(any(feature = "async-http", test))]
use url::Url;

#[cfg(feature = "async-http")]
pub(crate) use self::types::sensitive_header_name;
pub use self::types::{
    HttpMethod, ReqwestHttpTransport, RuntimeHttpHeader, RuntimeHttpRequest, RuntimeHttpResponse,
    RuntimeHttpTransport,
};

/// Standard decoded response-body bound for runtime-owned HTTP. Callers may
/// select a lower bound for a narrower operation, but must not invent a second
/// generic ceiling.
#[cfg(feature = "async-http")]
pub(crate) const STANDARD_HTTP_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
#[cfg(feature = "async-http")]
const DEFAULT_HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(feature = "async-http")]
const DEFAULT_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(feature = "async-http")]
const MANAGED_AGENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
#[cfg(feature = "async-http")]
const MAX_SAFE_READ_ATTEMPTS: usize = 3;
#[cfg(feature = "async-http")]
const DEFAULT_SAFE_READ_RETRY_DELAY: Duration = Duration::from_millis(100);
#[cfg(feature = "async-http")]
const MAX_SAFE_READ_RETRY_DELAY: Duration = Duration::from_secs(2);
#[cfg(feature = "async-http")]
static HTTP_CLIENT_RUNTIME: RetryableCell<tokio::runtime::Runtime> = RetryableCell::new();
#[cfg(feature = "async-http")]
const HTTP_CLIENT_PROFILE_COUNT: usize = 3;
#[cfg(feature = "async-http")]
static HTTP_CLIENTS: [RetryableCell<reqwest::Client>; HTTP_CLIENT_PROFILE_COUNT] =
    [const { RetryableCell::new() }; HTTP_CLIENT_PROFILE_COUNT];

#[cfg(feature = "async-http")]
struct RetryableCell<T> {
    value: OnceLock<T>,
    initialize: Mutex<()>,
}

#[cfg(feature = "async-http")]
impl<T> RetryableCell<T> {
    const fn new() -> Self {
        Self {
            value: OnceLock::new(),
            initialize: Mutex::new(()),
        }
    }

    fn get_or_try_init<E>(&self, initialize: impl FnOnce() -> Result<T, E>) -> Result<&T, E> {
        if let Some(value) = self.value.get() {
            return Ok(value);
        }
        let _guard = self
            .initialize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(value) = self.value.get() {
            return Ok(value);
        }
        let value = initialize()?;
        Ok(self.value.get_or_init(|| value))
    }
}

#[cfg(feature = "async-http")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
enum TransportProfile {
    PublicStandard = 0,
    PrivateStandard = 1,
    PublicPatient = 2,
}

#[cfg(feature = "async-http")]
#[derive(Clone, Copy)]
struct TransportConfig {
    request_timeout: Duration,
    connect_timeout: Duration,
    allow_private_networks: bool,
}

#[cfg(feature = "async-http")]
impl TransportProfile {
    const fn config(self) -> TransportConfig {
        match self {
            Self::PublicStandard => TransportConfig {
                request_timeout: DEFAULT_HTTP_REQUEST_TIMEOUT,
                connect_timeout: DEFAULT_HTTP_CONNECT_TIMEOUT,
                allow_private_networks: false,
            },
            Self::PrivateStandard => TransportConfig {
                request_timeout: DEFAULT_HTTP_REQUEST_TIMEOUT,
                connect_timeout: DEFAULT_HTTP_CONNECT_TIMEOUT,
                allow_private_networks: true,
            },
            Self::PublicPatient => TransportConfig {
                request_timeout: MANAGED_AGENT_REQUEST_TIMEOUT,
                connect_timeout: DEFAULT_HTTP_CONNECT_TIMEOUT,
                allow_private_networks: false,
            },
        }
    }

    fn cache(self) -> &'static RetryableCell<reqwest::Client> {
        &HTTP_CLIENTS[self as usize]
    }
}

#[cfg(feature = "async-http")]
impl ReqwestHttpTransport {
    pub fn new() -> Result<Self, RuntimeHttpError> {
        Self::from_profile(TransportProfile::PublicStandard)
    }

    fn from_profile(profile: TransportProfile) -> Result<Self, RuntimeHttpError> {
        let config = profile.config();
        let client = profile
            .cache()
            .get_or_try_init(|| build_http_client(config))
            .map_err(|message| RuntimeHttpError::Transport { message })?
            .clone();
        Ok(Self {
            client,
            allow_private_networks: config.allow_private_networks,
            request_timeout: config.request_timeout,
        })
    }

    #[cfg(test)]
    fn uncached(
        request_timeout: Duration,
        connect_timeout: Duration,
        allow_private_networks: bool,
    ) -> Result<Self, RuntimeHttpError> {
        let client = build_http_client(TransportConfig {
            request_timeout,
            connect_timeout,
            allow_private_networks,
        })
        .map_err(|message| RuntimeHttpError::Transport { message })?;
        Ok(Self {
            client,
            allow_private_networks,
            request_timeout,
        })
    }

    /// Build a transport that may reach private or loopback networks. This is the
    /// explicit, opt-in escape from the default SSRF/private-network block; callers
    /// must require an operator-declared opt-in before choosing it, never as a
    /// default.
    pub fn with_private_network_access() -> Result<Self, RuntimeHttpError> {
        Self::from_profile(TransportProfile::PrivateStandard)
    }

    /// Build the model-provider transport for managed-agent calls. These calls can
    /// legitimately take longer than the generic governed HTTP timeout while the
    /// provider thinks and emits tool use, but they still keep the same public-DNS
    /// guard and short connect timeout.
    pub fn for_managed_agent() -> Result<Self, RuntimeHttpError> {
        Self::from_profile(TransportProfile::PublicPatient)
    }

    #[cfg(test)]
    fn with_private_network_access_for_tests() -> Result<Self, RuntimeHttpError> {
        Self::with_private_network_access()
    }

    #[cfg(test)]
    fn with_private_network_timeouts_for_tests(
        request_timeout: Duration,
        connect_timeout: Duration,
    ) -> Result<Self, RuntimeHttpError> {
        Self::uncached(request_timeout, connect_timeout, true)
    }
}

/// Runtime-owned transport selection for native HTTP capabilities. Exact
/// fixture responses can enter only through the private harness registry;
/// ordinary executions always construct the live guarded transport.
#[cfg(feature = "async-http")]
pub(crate) enum NativeHttpTransport<'a> {
    Live(ReqwestHttpTransport),
    Harness(&'a BTreeMap<String, RuntimeHttpResponse>),
}

#[cfg(feature = "async-http")]
impl<'a> NativeHttpTransport<'a> {
    pub(crate) fn new(
        harness_responses: Option<&'a BTreeMap<String, RuntimeHttpResponse>>,
    ) -> Result<Self, RuntimeHttpError> {
        match harness_responses {
            Some(responses) => Ok(Self::Harness(responses)),
            None => Ok(Self::Live(ReqwestHttpTransport::new()?)),
        }
    }

    pub(crate) fn for_hosted_api(
        harness_responses: Option<&'a BTreeMap<String, RuntimeHttpResponse>>,
        allow_private_network: bool,
    ) -> Result<Self, RuntimeHttpError> {
        match harness_responses {
            Some(responses) => Ok(Self::Harness(responses)),
            None if allow_private_network => Ok(Self::Live(
                ReqwestHttpTransport::with_private_network_access()?,
            )),
            None => Self::new(None),
        }
    }

    pub(crate) fn send_bounded(
        &self,
        request: RuntimeHttpRequest,
        response_limit: usize,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        match self {
            Self::Live(transport) => transport.send_bounded(request, response_limit),
            Self::Harness(responses) => Ok(bound_harness_response(
                exact_harness_response(responses, &request, false)?,
                response_limit,
            )),
        }
    }
}

#[cfg(feature = "async-http")]
impl RuntimeHttpTransport for NativeHttpTransport<'_> {
    fn send(&self, request: RuntimeHttpRequest) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        match self {
            Self::Live(transport) => transport.send(request),
            Self::Harness(responses) => exact_harness_response(responses, &request, false),
        }
    }

    fn send_limited(
        &self,
        request: RuntimeHttpRequest,
        response_limit: usize,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        match self {
            Self::Live(transport) => transport.send_limited(request, response_limit),
            Self::Harness(responses) => enforce_harness_response_limit(
                exact_harness_response(responses, &request, false)?,
                response_limit,
            ),
        }
    }

    fn send_idempotent(
        &self,
        request: RuntimeHttpRequest,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        match self {
            Self::Live(transport) => transport.send_idempotent(request),
            Self::Harness(responses) => exact_harness_response(responses, &request, true),
        }
    }

    fn send_idempotent_limited(
        &self,
        request: RuntimeHttpRequest,
        response_limit: usize,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        match self {
            Self::Live(transport) => transport.send_idempotent_limited(request, response_limit),
            Self::Harness(responses) => enforce_harness_response_limit(
                exact_harness_response(responses, &request, true)?,
                response_limit,
            ),
        }
    }
}

#[cfg(feature = "async-http")]
fn exact_harness_response(
    responses: &BTreeMap<String, RuntimeHttpResponse>,
    request: &RuntimeHttpRequest,
    admit_idempotent_query: bool,
) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
    if request.method != HttpMethod::Get
        && !(admit_idempotent_query && request.method == HttpMethod::Post)
    {
        return Err(RuntimeHttpError::Transport {
            message: format!(
                "deterministic harness HTTP responses admit GET reads and runtime-declared idempotent POST requests only, not {}",
                request.method.as_str()
            ),
        });
    }
    responses
        .get(&request.url)
        .cloned()
        .ok_or_else(|| RuntimeHttpError::Transport {
            message: format!(
                "the harness declared deterministic HTTP responses but none matched {}",
                request.url
            ),
        })
}

#[cfg(feature = "async-http")]
fn enforce_harness_response_limit(
    response: RuntimeHttpResponse,
    response_limit: usize,
) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
    if response.body_bytes > response_limit {
        return Err(RuntimeHttpError::ResponseBodyTooLarge {
            limit: response_limit,
        });
    }
    Ok(response)
}

#[cfg(feature = "async-http")]
fn bound_harness_response(
    mut response: RuntimeHttpResponse,
    response_limit: usize,
) -> RuntimeHttpResponse {
    if response.body_bytes <= response_limit {
        return response;
    }
    let bounded = response.body.as_bytes()[..response_limit].to_vec();
    response.body = String::from_utf8_lossy(&bounded).into_owned();
    response.body_digest = runx_contracts::sha256_prefixed(&bounded);
    response.body_bytes = bounded.len();
    response.truncated = true;
    response
}

#[cfg(feature = "async-http")]
fn build_http_client(config: TransportConfig) -> Result<reqwest::Client, String> {
    // reqwest is built with `rustls-no-provider`, so the process needs a
    // default crypto provider before a TLS client can be constructed.
    // Install ring once; an Err means another transport already set it.
    let _ = rustls::crypto::ring::default_provider().install_default();
    // Decode like a browser (the decoders also advertise the matching
    // Accept-Encoding) and let ALPN negotiate HTTP/2; a no-compression,
    // http1-only client is a bot tell. The response cap measures DECODED
    // bytes (read_limited_response_body), so a decompression bomb stays bounded.
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(config.request_timeout)
        .connect_timeout(config.connect_timeout)
        .gzip(true)
        .brotli(true)
        .deflate(true)
        .zstd(true)
        // Verify against the compiled-in Mozilla root program instead of the
        // host trust store. The governed front then has one deterministic
        // trust surface everywhere it runs; a sandbox with no system CA
        // bundle (hosted publish harness) behaves exactly like a developer
        // laptop.
        .tls_certs_only(
            webpki_root_certs::TLS_SERVER_ROOT_CERTS
                .iter()
                .filter_map(|der| reqwest::Certificate::from_der(der).ok()),
        );
    let builder = if config.allow_private_networks {
        builder
    } else {
        builder.dns_resolver(GuardedDnsResolver::new(TokioDnsResolver))
    };
    builder
        .build()
        .map_err(|error| transport_error_message(&error))
}

#[cfg(feature = "async-http")]
impl RuntimeHttpTransport for ReqwestHttpTransport {
    fn send(&self, request: RuntimeHttpRequest) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        self.send_with_limit(request, STANDARD_HTTP_RESPONSE_BYTES, false, false)
    }

    fn send_limited(
        &self,
        request: RuntimeHttpRequest,
        response_limit: usize,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        self.send_with_limit(request, response_limit, false, false)
    }

    fn send_idempotent(
        &self,
        request: RuntimeHttpRequest,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        self.send_with_limit(request, STANDARD_HTTP_RESPONSE_BYTES, false, true)
    }

    fn send_idempotent_limited(
        &self,
        request: RuntimeHttpRequest,
        response_limit: usize,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        self.send_with_limit(request, response_limit, false, true)
    }
}

#[cfg(feature = "async-http")]
impl ReqwestHttpTransport {
    /// Send one governed request with a caller-selected response cap. The body is
    /// returned truncated at the cap instead of allocating beyond it.
    pub fn send_bounded(
        &self,
        request: RuntimeHttpRequest,
        response_limit: usize,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        self.send_with_limit(request, response_limit, true, false)
    }

    fn send_with_limit(
        &self,
        request: RuntimeHttpRequest,
        response_limit: usize,
        truncate: bool,
        retry_as_idempotent: bool,
    ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
        validate_http_url(&request.url, self.allow_private_networks)?;
        let client = self.client.clone();
        let request_timeout = self.request_timeout;
        let headers = reqwest_headers(&request.headers)?;
        block_on_http(async move {
            tokio::time::timeout(
                request_timeout,
                send_reqwest_with_safe_read_retries(
                    client,
                    request,
                    headers,
                    response_limit,
                    truncate,
                    retry_as_idempotent,
                ),
            )
            .await
            .map_err(|_| RuntimeHttpError::Transport {
                message: format!(
                    "request deadline exceeded after {}ms",
                    request_timeout.as_millis()
                ),
            })?
        })
    }
}

#[cfg(feature = "async-http")]
fn reqwest_headers(
    headers: &[RuntimeHttpHeader],
) -> Result<reqwest::header::HeaderMap, RuntimeHttpError> {
    let mut output = reqwest::header::HeaderMap::new();
    for header in headers {
        validate_header(header)?;
        let name = reqwest::header::HeaderName::from_bytes(header.name.trim().as_bytes()).map_err(
            |error| RuntimeHttpError::InvalidHeaderName {
                name: header.name.clone(),
                message: error.to_string(),
            },
        )?;
        let value = reqwest::header::HeaderValue::from_str(&header.value).map_err(|error| {
            RuntimeHttpError::InvalidHeaderValue {
                name: header.name.clone(),
                message: error.to_string(),
            }
        })?;
        output.insert(name, value);
    }
    Ok(output)
}

#[cfg(feature = "async-http")]
async fn send_reqwest_with_safe_read_retries(
    client: reqwest::Client,
    request: RuntimeHttpRequest,
    headers: reqwest::header::HeaderMap,
    response_limit: usize,
    truncate: bool,
    retry_as_idempotent: bool,
) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
    let mut attempt = 1_usize;
    loop {
        let mut builder = client
            .request(reqwest_method(request.method), &request.url)
            .headers(headers.clone());
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let response = builder
            .send()
            .await
            .map_err(|error| RuntimeHttpError::Transport {
                message: transport_error_message(&error),
            })?;
        let status = response.status().as_u16();
        if (request.method == HttpMethod::Get || retry_as_idempotent)
            && retryable_read_status(status)
            && attempt < MAX_SAFE_READ_ATTEMPTS
        {
            let delay = safe_read_retry_delay(&response, attempt);
            drop(response);
            tokio::time::sleep(delay).await;
            attempt += 1;
            continue;
        }
        let response_headers = safe_response_headers(&response);
        let (body, truncated) =
            read_limited_response_body(response, response_limit, truncate).await?;
        let body_bytes = body.len();
        let body_digest = runx_contracts::sha256_prefixed(&body);
        return Ok(RuntimeHttpResponse {
            status,
            body: String::from_utf8_lossy(&body).into_owned(),
            headers: response_headers,
            body_digest,
            body_bytes,
            truncated,
        });
    }
}

#[cfg(feature = "async-http")]
fn safe_response_headers(response: &reqwest::Response) -> Vec<RuntimeHttpHeader> {
    response
        .headers()
        .iter()
        .filter(|(name, _)| !types::sensitive_header_name(name.as_str()))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| RuntimeHttpHeader::new(name.as_str(), value))
        })
        .collect()
}

#[cfg(feature = "async-http")]
fn retryable_read_status(status: u16) -> bool {
    matches!(status, 429 | 502 | 503 | 504)
}

#[cfg(feature = "async-http")]
fn safe_read_retry_delay(response: &reqwest::Response, completed_attempts: usize) -> Duration {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after)
        .unwrap_or_else(|| {
            DEFAULT_SAFE_READ_RETRY_DELAY
                .saturating_mul(u32::try_from(completed_attempts).unwrap_or(u32::MAX))
        })
        .min(MAX_SAFE_READ_RETRY_DELAY)
}

#[cfg(feature = "async-http")]
fn parse_retry_after(value: &str) -> Option<Duration> {
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let deadline = httpdate::parse_http_date(value).ok()?;
    Some(
        deadline
            .duration_since(std::time::SystemTime::now())
            .unwrap_or(Duration::ZERO),
    )
}

#[cfg(feature = "async-http")]
fn transport_error_message(error: &(dyn StdError + 'static)) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(error) = source {
        parts.push(error.to_string());
        source = error.source();
    }
    parts.dedup();
    parts.join(": ")
}

#[cfg(feature = "async-http")]
#[derive(Clone, Debug)]
struct GuardedDnsResolver<R> {
    inner: R,
}

#[cfg(feature = "async-http")]
impl<R> GuardedDnsResolver<R> {
    fn new(inner: R) -> Self {
        Self { inner }
    }
}

#[cfg(feature = "async-http")]
impl<R> reqwest::dns::Resolve for GuardedDnsResolver<R>
where
    R: reqwest::dns::Resolve + Clone + Send + Sync + 'static,
{
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        let inner = self.inner.clone();
        Box::pin(async move {
            let addrs = inner.resolve(name).await?;
            let mut public_addrs = Vec::new();
            for addr in addrs {
                if is_private_network_ip(addr.ip()) {
                    return Err(PrivateDnsResolutionError { host, addr }.into());
                }
                public_addrs.push(addr);
            }
            if public_addrs.is_empty() {
                return Err(EmptyDnsResolutionError { host }.into());
            }
            Ok(Box::new(public_addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[cfg(feature = "async-http")]
#[derive(Clone, Copy, Debug, Default)]
struct TokioDnsResolver;

#[cfg(feature = "async-http")]
impl reqwest::dns::Resolve for TokioDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|error| Box::new(error) as Box<dyn StdError + Send + Sync>)?;
            let addrs = addrs.collect::<Vec<_>>();
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[cfg(feature = "async-http")]
#[derive(Debug)]
struct PrivateDnsResolutionError {
    host: String,
    addr: SocketAddr,
}

#[cfg(feature = "async-http")]
impl fmt::Display for PrivateDnsResolutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "runtime HTTP DNS resolved '{}' to non-public address {}",
            self.host, self.addr
        )
    }
}

#[cfg(feature = "async-http")]
impl StdError for PrivateDnsResolutionError {}

#[cfg(feature = "async-http")]
#[derive(Debug)]
struct EmptyDnsResolutionError {
    host: String,
}

#[cfg(feature = "async-http")]
impl fmt::Display for EmptyDnsResolutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "runtime HTTP DNS returned no addresses for '{}'",
            self.host
        )
    }
}

#[cfg(feature = "async-http")]
impl StdError for EmptyDnsResolutionError {}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeHttpError {
    #[error("invalid runtime HTTP url: {0}")]
    InvalidUrl(#[from] url::ParseError),
    #[error("runtime HTTP transport failed: {message}")]
    Transport { message: String },
    #[error("runtime HTTP transport cannot block inside an active async runtime")]
    BlockingHttpInsideAsyncRuntime,
    #[error("runtime HTTP async runtime is unavailable: {message}")]
    AsyncRuntimeUnavailable { message: String },
    #[error("runtime HTTP transport returned invalid output: {message}")]
    TransportDecode { message: String },
    #[error("runtime HTTP response body exceeds {limit} byte limit")]
    ResponseBodyTooLarge { limit: usize },
    #[error("unsupported runtime HTTP url scheme '{scheme}': only http and https are allowed")]
    UnsupportedUrlScheme { scheme: String },
    #[error("runtime HTTP url host '{host}' is not publicly routable")]
    PrivateNetworkUrl { host: String },
    #[error("invalid runtime HTTP header name '{name}': {message}")]
    InvalidHeaderName { name: String, message: String },
    #[error("invalid runtime HTTP header value for '{name}': {message}")]
    InvalidHeaderValue { name: String, message: String },
}

pub(crate) fn strip_one_trailing_slash(value: &str) -> String {
    value.strip_suffix('/').unwrap_or(value).to_owned()
}

#[cfg(feature = "async-http")]
fn validate_header(header: &RuntimeHttpHeader) -> Result<(), RuntimeHttpError> {
    let name = header.name.trim();
    if name.is_empty() || !name.bytes().all(is_header_token_byte) {
        return Err(RuntimeHttpError::InvalidHeaderName {
            name: header.name.clone(),
            message: "header names must be HTTP token characters".to_owned(),
        });
    }
    if header.value.contains('\r') || header.value.contains('\n') {
        return Err(RuntimeHttpError::InvalidHeaderValue {
            name: header.name.clone(),
            message: "header values must not contain line breaks".to_owned(),
        });
    }
    Ok(())
}

#[cfg(any(feature = "async-http", test))]
fn validate_http_url(value: &str, allow_private_networks: bool) -> Result<(), RuntimeHttpError> {
    let url = Url::parse(value)?;
    match url.scheme() {
        "http" | "https" => validate_public_host(&url, allow_private_networks),
        scheme => Err(RuntimeHttpError::UnsupportedUrlScheme {
            scheme: scheme.to_owned(),
        }),
    }
}

#[cfg(any(feature = "async-http", test))]
fn validate_public_host(url: &Url, allow_private_networks: bool) -> Result<(), RuntimeHttpError> {
    if allow_private_networks {
        return Ok(());
    }
    let Some(host) = url.host_str() else {
        return Err(RuntimeHttpError::PrivateNetworkUrl {
            host: "<missing>".to_owned(),
        });
    };
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized == "metadata.google.internal"
    {
        return Err(RuntimeHttpError::PrivateNetworkUrl {
            host: host.to_owned(),
        });
    }
    let ip_host = normalized
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(&normalized);
    if let Ok(ip) = ip_host.parse::<IpAddr>()
        && is_private_network_ip(ip)
    {
        return Err(RuntimeHttpError::PrivateNetworkUrl {
            host: host.to_owned(),
        });
    }
    Ok(())
}

#[cfg(any(feature = "async-http", test))]
fn is_private_network_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_private_network_ipv4(ip),
        IpAddr::V6(ip) => is_private_network_ipv6(ip),
    }
}

#[cfg(any(feature = "async-http", test))]
fn is_private_network_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || octets[0] == 0
        || (octets[0] == 100 && (octets[1] & 0xc0) == 0x40)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || octets[0] >= 240
        || octets == [169, 254, 169, 254]
}

#[cfg(any(feature = "async-http", test))]
fn is_private_network_ipv6(ip: Ipv6Addr) -> bool {
    ip.to_ipv4_mapped().is_some_and(is_private_network_ipv4)
        || ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || is_unique_local_ipv6(ip)
        || is_unicast_link_local_ipv6(ip)
        || is_documentation_ipv6(ip)
        || nat64_embedded_ipv4(ip).is_some_and(is_private_network_ipv4)
        || six_to_four_embedded_ipv4(ip).is_some_and(is_private_network_ipv4)
}

#[cfg(any(feature = "async-http", test))]
fn is_unique_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

#[cfg(any(feature = "async-http", test))]
fn is_unicast_link_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

#[cfg(any(feature = "async-http", test))]
fn is_documentation_ipv6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8
}

#[cfg(any(feature = "async-http", test))]
fn nat64_embedded_ipv4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let segments = ip.segments();
    if segments[..6] != [0x0064, 0xff9b, 0, 0, 0, 0] {
        return None;
    }
    Some(Ipv4Addr::new(
        (segments[6] >> 8) as u8,
        segments[6] as u8,
        (segments[7] >> 8) as u8,
        segments[7] as u8,
    ))
}

#[cfg(any(feature = "async-http", test))]
fn six_to_four_embedded_ipv4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let segments = ip.segments();
    if segments[0] != 0x2002 {
        return None;
    }
    Some(Ipv4Addr::new(
        (segments[1] >> 8) as u8,
        segments[1] as u8,
        (segments[2] >> 8) as u8,
        segments[2] as u8,
    ))
}

#[cfg(feature = "async-http")]
async fn read_limited_response_body(
    mut response: reqwest::Response,
    limit: usize,
    truncate: bool,
) -> Result<(Vec<u8>, bool), RuntimeHttpError> {
    if declared_response_length(&response)?.is_some_and(|length| length > limit as u64) && !truncate
    {
        return Err(RuntimeHttpError::ResponseBodyTooLarge { limit });
    }
    let mut body = Vec::new();
    while let Some(chunk) =
        response
            .chunk()
            .await
            .map_err(|error| RuntimeHttpError::TransportDecode {
                message: error.to_string(),
            })?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            if !truncate {
                return Err(RuntimeHttpError::ResponseBodyTooLarge { limit });
            }
            let remaining = limit.saturating_sub(body.len());
            body.extend_from_slice(&chunk[..remaining]);
            return Ok((body, true));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, false))
}

#[cfg(feature = "async-http")]
fn declared_response_length(response: &reqwest::Response) -> Result<Option<u64>, RuntimeHttpError> {
    let Some(value) = response.headers().get(reqwest::header::CONTENT_LENGTH) else {
        return Ok(response.content_length());
    };
    let value = value
        .to_str()
        .map_err(|error| RuntimeHttpError::TransportDecode {
            message: format!("invalid Content-Length header: {error}"),
        })?;
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| RuntimeHttpError::TransportDecode {
            message: format!("invalid Content-Length header: {error}"),
        })
}

#[cfg(feature = "async-http")]
fn reqwest_method(method: HttpMethod) -> reqwest::Method {
    match method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
        HttpMethod::Put => reqwest::Method::PUT,
        HttpMethod::Patch => reqwest::Method::PATCH,
        HttpMethod::Delete => reqwest::Method::DELETE,
    }
}

#[cfg(feature = "async-http")]
fn block_on_http<F, T>(future: F) -> Result<T, RuntimeHttpError>
where
    F: std::future::Future<Output = Result<T, RuntimeHttpError>>,
{
    if tokio::runtime::Handle::try_current().is_ok() {
        return Err(RuntimeHttpError::BlockingHttpInsideAsyncRuntime);
    }
    http_runtime()?.block_on(future)
}

#[cfg(feature = "async-http")]
fn http_runtime() -> Result<&'static tokio::runtime::Runtime, RuntimeHttpError> {
    HTTP_CLIENT_RUNTIME
        .get_or_try_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("runx-http")
                .enable_all()
                .build()
                .map_err(|error| error.to_string())
        })
        .map_err(|message| RuntimeHttpError::AsyncRuntimeUnavailable { message })
}

#[cfg(feature = "async-http")]
fn is_header_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "async-http")]
    use std::collections::BTreeMap;
    use std::io;
    #[cfg(feature = "async-http")]
    use std::io::{Read, Write};
    #[cfg(feature = "async-http")]
    use std::net::TcpListener;
    #[cfg(feature = "async-http")]
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
    #[cfg(feature = "async-http")]
    use std::time::Duration;

    #[cfg(feature = "async-http")]
    use super::RuntimeHttpResponse;
    #[cfg(feature = "async-http")]
    use super::RuntimeHttpTransport;
    #[cfg(feature = "async-http")]
    use super::{
        GuardedDnsResolver, NativeHttpTransport, ReqwestHttpTransport,
        STANDARD_HTTP_RESPONSE_BYTES, TransportProfile, block_on_http, http_runtime,
    };
    use super::{HttpMethod, RuntimeHttpError, RuntimeHttpHeader, RuntimeHttpRequest};
    #[cfg(feature = "async-http")]
    use reqwest::dns::Resolve as _;

    #[cfg(feature = "async-http")]
    #[derive(Clone, Debug)]
    struct StaticDnsResolver {
        addrs: Vec<SocketAddr>,
    }

    #[cfg(feature = "async-http")]
    impl reqwest::dns::Resolve for StaticDnsResolver {
        fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
            let addrs = self.addrs.clone();
            Box::pin(async move { Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs) })
        }
    }

    #[derive(Debug, thiserror::Error)]
    enum RuntimeHttpTestError {
        #[error(transparent)]
        RuntimeHttp(#[from] RuntimeHttpError),
        #[error(transparent)]
        Io(#[from] io::Error),
        #[cfg(feature = "async-http")]
        #[error("server thread panicked")]
        ServerThread,
    }

    #[cfg(feature = "async-http")]
    #[test]
    fn harness_http_transport_is_exact_bounded_and_never_falls_through()
    -> Result<(), RuntimeHttpTestError> {
        let url = "https://fixture.runx.invalid/source";
        let responses =
            BTreeMap::from([(url.to_owned(), RuntimeHttpResponse::new(200, "hello world"))]);
        let transport = NativeHttpTransport::new(Some(&responses))?;

        let exact = transport.send_bounded(
            RuntimeHttpRequest {
                method: HttpMethod::Get,
                url: url.to_owned(),
                headers: Vec::new(),
                body: None,
            },
            5,
        )?;
        assert_eq!(exact.body, "hello");
        assert!(exact.truncated);

        let missing = transport.send(RuntimeHttpRequest {
            method: HttpMethod::Get,
            url: "https://fixture.runx.invalid/missing".to_owned(),
            headers: Vec::new(),
            body: None,
        });
        assert!(matches!(missing, Err(RuntimeHttpError::Transport { .. })));

        let mutation = transport.send(RuntimeHttpRequest {
            method: HttpMethod::Post,
            url: url.to_owned(),
            headers: Vec::new(),
            body: Some("{}".to_owned()),
        });
        assert!(matches!(mutation, Err(RuntimeHttpError::Transport { .. })));

        let query = transport.send_idempotent(RuntimeHttpRequest {
            method: HttpMethod::Post,
            url: url.to_owned(),
            headers: Vec::new(),
            body: Some("{}".to_owned()),
        })?;
        assert_eq!(query.body, "hello world");
        Ok(())
    }

    #[test]
    fn debug_output_redacts_sensitive_header_values() {
        let request = RuntimeHttpRequest {
            method: HttpMethod::Get,
            url: "https://api.example/v1/grants".to_owned(),
            headers: vec![
                RuntimeHttpHeader::new("authorization", "Bearer SECRET_RUNTIME_TOKEN"),
                RuntimeHttpHeader::new("x-runx-token", "SECRET_HEADER_TOKEN"),
                RuntimeHttpHeader::new("accept", "application/json"),
            ],
            body: Some("SECRET_BODY".to_owned()),
        };

        let debug = format!("{request:?}");
        assert!(!debug.contains("SECRET_RUNTIME_TOKEN"));
        assert!(!debug.contains("SECRET_HEADER_TOKEN"));
        assert!(!debug.contains("SECRET_BODY"));
        assert!(debug.contains("[redacted]"));
        assert!(debug.contains("application/json"));
        assert!(super::types::sensitive_header_name("set-cookie"));
        assert!(super::types::sensitive_header_name("cookie"));
    }

    #[test]
    fn invalid_base_urls_fail_closed() {
        assert!(super::validate_http_url("not a url", false).is_err());
        assert!(matches!(
            super::validate_http_url("file:///tmp/runx.sock", false),
            Err(RuntimeHttpError::UnsupportedUrlScheme { .. })
        ));
    }

    #[test]
    fn private_network_base_urls_fail_closed() {
        for value in [
            "http://localhost",
            "http://service.localhost",
            "http://127.0.0.1",
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://192.168.0.1",
            "http://169.254.169.254",
            "http://100.64.0.1",
            "http://100.127.255.255",
            "http://192.0.0.1",
            "http://198.18.0.1",
            "http://240.0.0.1",
            "http://0.1.2.3",
            "http://[::1]",
            "http://[::ffff:127.0.0.1]",
            "http://[64:ff9b::7f00:1]",
            "http://[2002:7f00:1::]",
            "http://[fc00::1]",
            "http://[fe80::1]",
            "http://metadata.google.internal",
        ] {
            assert!(
                matches!(
                    super::validate_http_url(value, false),
                    Err(RuntimeHttpError::PrivateNetworkUrl { .. })
                ),
                "{value} should be rejected as private"
            );
        }
    }

    #[test]
    fn public_base_urls_are_allowed() -> Result<(), RuntimeHttpTestError> {
        super::validate_http_url("https://api.example", false)?;
        super::validate_http_url("http://8.8.8.8", false)?;
        super::validate_http_url("http://[64:ff9b::808:808]", false)?;
        Ok(())
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn synchronous_http_reuses_one_runtime() -> Result<(), RuntimeHttpTestError> {
        let first = http_runtime()?;
        let second = http_runtime()?;
        assert!(std::ptr::eq(first, second));
        Ok(())
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn retryable_cell_does_not_memoize_transient_initialization_failure() {
        let attempts = std::cell::Cell::new(0);
        let cell = super::RetryableCell::new();
        let first: Result<&u8, &str> = cell.get_or_try_init(|| {
            attempts.set(attempts.get() + 1);
            Err("transient")
        });
        let second: Result<&u8, &str> = cell.get_or_try_init(|| {
            attempts.set(attempts.get() + 1);
            Ok(7)
        });
        let third: Result<&u8, &str> = cell.get_or_try_init(|| {
            attempts.set(attempts.get() + 1);
            Ok(8)
        });

        assert_eq!(first, Err("transient"));
        assert_eq!(second, Ok(&7));
        assert_eq!(third, Ok(&7));
        assert_eq!(attempts.get(), 2);
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn canonical_http_profiles_populate_distinct_policy_cache_slots()
    -> Result<(), RuntimeHttpTestError> {
        let _public_first = ReqwestHttpTransport::new()?;
        let _public_second = ReqwestHttpTransport::new()?;
        let _private_first = ReqwestHttpTransport::with_private_network_access()?;
        let _private_second = ReqwestHttpTransport::with_private_network_access()?;
        let _managed_first = ReqwestHttpTransport::for_managed_agent()?;
        let _managed_second = ReqwestHttpTransport::for_managed_agent()?;

        let (Some(public), Some(private), Some(patient)) = (
            TransportProfile::PublicStandard.cache().value.get(),
            TransportProfile::PrivateStandard.cache().value.get(),
            TransportProfile::PublicPatient.cache().value.get(),
        ) else {
            return Err(RuntimeHttpError::Transport {
                message: "canonical HTTP profile client was not cached".to_owned(),
            }
            .into());
        };
        assert!(!std::ptr::eq(public, private));
        assert!(!std::ptr::eq(public, patient));
        Ok(())
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn shared_http_runtime_supports_concurrent_sync_callers() -> Result<(), RuntimeHttpTestError> {
        let callers = (0..8)
            .map(|value| {
                std::thread::spawn(move || {
                    block_on_http(async move {
                        tokio::task::yield_now().await;
                        Ok(value)
                    })
                })
            })
            .collect::<Vec<_>>();

        let mut values = Vec::new();
        for caller in callers {
            values.push(
                caller
                    .join()
                    .map_err(|_| RuntimeHttpTestError::ServerThread)??,
            );
        }
        values.sort_unstable();
        assert_eq!(values, (0..8).collect::<Vec<_>>());
        Ok(())
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn guarded_dns_resolver_rejects_private_resolved_addresses() -> Result<(), RuntimeHttpTestError>
    {
        let resolver = GuardedDnsResolver::new(StaticDnsResolver {
            addrs: vec![SocketAddr::V4(SocketAddrV4::new(
                Ipv4Addr::new(127, 0, 0, 1),
                0,
            ))],
        });
        let name = "public.example"
            .parse()
            .map_err(|error| RuntimeHttpError::Transport {
                message: format!("test DNS name should parse: {error}"),
            })?;
        let error =
            block_on_http(async {
                resolver.resolve(name).await.map(|_| ()).map_err(|error| {
                    RuntimeHttpError::Transport {
                        message: error.to_string(),
                    }
                })
            })
            .err();

        assert!(
            matches!(error, Some(RuntimeHttpError::Transport { ref message }) if message.contains("non-public address")),
            "expected private DNS resolution to fail closed, got: {error:?}"
        );
        Ok(())
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn reqwest_transport_does_not_follow_redirects() -> Result<(), RuntimeHttpTestError> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> Result<String, std::io::Error> {
            let (mut stream, _) = listener.accept()?;
            let mut buffer = [0_u8; 1024];
            let bytes_read = stream.read(&mut buffer)?;
            stream.write_all(
                b"HTTP/1.1 302 Found\r\nLocation: /redirected\r\nContent-Length: 0\r\n\r\n",
            )?;
            Ok(String::from_utf8_lossy(&buffer[..bytes_read]).into_owned())
        });

        let transport = ReqwestHttpTransport::with_private_network_access_for_tests()?;
        let response = transport.send(RuntimeHttpRequest {
            method: HttpMethod::Get,
            url: format!("http://{address}/start"),
            headers: Vec::new(),
            body: None,
        })?;
        let request = server
            .join()
            .map_err(|_| RuntimeHttpTestError::ServerThread)??;

        assert_eq!(response.status, 302);
        assert!(request.starts_with("GET /start "));
        Ok(())
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn reqwest_transport_retries_bounded_safe_reads() -> Result<(), RuntimeHttpTestError> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> Result<Vec<String>, std::io::Error> {
            let mut requests = Vec::new();
            for attempt in 1..=3 {
                let (mut stream, _) = listener.accept()?;
                let mut buffer = [0_u8; 1024];
                let bytes_read = stream.read(&mut buffer)?;
                requests.push(String::from_utf8_lossy(&buffer[..bytes_read]).into_owned());
                if attempt < 3 {
                    stream.write_all(
                        b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )?;
                } else {
                    stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )?;
                }
            }
            Ok(requests)
        });

        let transport = ReqwestHttpTransport::with_private_network_access_for_tests()?;
        let response = transport.send(RuntimeHttpRequest {
            method: HttpMethod::Get,
            url: format!("http://{address}/retry"),
            headers: Vec::new(),
            body: None,
        })?;
        let requests = server
            .join()
            .map_err(|_| RuntimeHttpTestError::ServerThread)??;

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "ok");
        assert_eq!(requests.len(), 3);
        assert!(requests.iter().all(|request| request.starts_with("GET ")));
        Ok(())
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn reqwest_transport_never_retries_mutations() -> Result<(), RuntimeHttpTestError> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> Result<String, std::io::Error> {
            let (mut stream, _) = listener.accept()?;
            let mut buffer = [0_u8; 1024];
            let bytes_read = stream.read(&mut buffer)?;
            stream.write_all(
                b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )?;
            Ok(String::from_utf8_lossy(&buffer[..bytes_read]).into_owned())
        });

        let transport = ReqwestHttpTransport::with_private_network_access_for_tests()?;
        let response = transport.send(RuntimeHttpRequest {
            method: HttpMethod::Post,
            url: format!("http://{address}/mutate"),
            headers: Vec::new(),
            body: Some("{}".to_owned()),
        })?;
        let request = server
            .join()
            .map_err(|_| RuntimeHttpTestError::ServerThread)??;

        assert_eq!(response.status, 503);
        assert!(request.starts_with("POST "));
        Ok(())
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn reqwest_transport_retries_declared_idempotent_posts() -> Result<(), RuntimeHttpTestError> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> Result<Vec<String>, std::io::Error> {
            let mut requests = Vec::new();
            for attempt in 1..=3 {
                let (mut stream, _) = listener.accept()?;
                let mut buffer = [0_u8; 1024];
                let bytes_read = stream.read(&mut buffer)?;
                requests.push(String::from_utf8_lossy(&buffer[..bytes_read]).into_owned());
                if attempt < 3 {
                    stream.write_all(
                        b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )?;
                } else {
                    stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )?;
                }
            }
            Ok(requests)
        });

        let transport = ReqwestHttpTransport::with_private_network_access_for_tests()?;
        let response = transport.send_idempotent(RuntimeHttpRequest {
            method: HttpMethod::Post,
            url: format!("http://{address}/query"),
            headers: vec![RuntimeHttpHeader::new("content-type", "application/json")],
            body: Some("{}".to_owned()),
        })?;
        let requests = server
            .join()
            .map_err(|_| RuntimeHttpTestError::ServerThread)??;

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "ok");
        assert_eq!(requests.len(), 3);
        assert!(requests.iter().all(|request| request.starts_with("POST ")));
        Ok(())
    }

    #[test]
    #[cfg(feature = "async-http")]
    fn reqwest_transport_rejects_header_injection() -> Result<(), RuntimeHttpTestError> {
        let transport = ReqwestHttpTransport::new()?;
        let error = transport
            .send(RuntimeHttpRequest {
                method: HttpMethod::Get,
                url: "https://api.example/v1".to_owned(),
                headers: vec![RuntimeHttpHeader::new("x-runx", "good\nbad")],
                body: None,
            })
            .err();
        assert!(matches!(
            error,
            Some(RuntimeHttpError::InvalidHeaderValue { .. })
        ));
        Ok(())
    }

    #[cfg(feature = "async-http")]
    #[test]
    fn reqwest_transport_rejects_non_http_urls_before_sending() -> Result<(), RuntimeHttpTestError>
    {
        let transport = ReqwestHttpTransport::new()?;
        let error = transport
            .send(RuntimeHttpRequest {
                method: HttpMethod::Get,
                url: "file:///etc/passwd".to_owned(),
                headers: Vec::new(),
                body: None,
            })
            .err();

        assert!(matches!(
            error,
            Some(RuntimeHttpError::UnsupportedUrlScheme { .. })
        ));
        Ok(())
    }

    #[cfg(feature = "async-http")]
    #[test]
    fn reqwest_transport_rejects_oversized_content_length() -> Result<(), RuntimeHttpTestError> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> Result<(), std::io::Error> {
            let (mut stream, _) = listener.accept()?;
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer)?;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                STANDARD_HTTP_RESPONSE_BYTES + 1
            );
            stream.write_all(response.as_bytes())?;
            Ok(())
        });

        let transport = ReqwestHttpTransport::with_private_network_access_for_tests()?;
        let error = transport
            .send(RuntimeHttpRequest {
                method: HttpMethod::Get,
                url: format!("http://{address}/too-large"),
                headers: Vec::new(),
                body: None,
            })
            .err();
        server
            .join()
            .map_err(|_| RuntimeHttpTestError::ServerThread)??;

        assert!(matches!(
            error,
            Some(RuntimeHttpError::ResponseBodyTooLarge { limit })
                if limit == STANDARD_HTTP_RESPONSE_BYTES
        ));
        Ok(())
    }

    #[cfg(feature = "async-http")]
    #[test]
    fn reqwest_transport_caps_streamed_response_body() -> Result<(), RuntimeHttpTestError> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> Result<(), std::io::Error> {
            let (mut stream, _) = listener.accept()?;
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer)?;
            stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")?;
            let _ = stream.write_all(&vec![b'a'; STANDARD_HTTP_RESPONSE_BYTES + 1]);
            Ok(())
        });

        let transport = ReqwestHttpTransport::with_private_network_access_for_tests()?;
        let error = transport
            .send(RuntimeHttpRequest {
                method: HttpMethod::Get,
                url: format!("http://{address}/stream-too-large"),
                headers: Vec::new(),
                body: None,
            })
            .err();
        server
            .join()
            .map_err(|_| RuntimeHttpTestError::ServerThread)??;

        assert!(matches!(
            error,
            Some(RuntimeHttpError::ResponseBodyTooLarge { limit })
                if limit == STANDARD_HTTP_RESPONSE_BYTES
        ));
        Ok(())
    }

    #[cfg(feature = "async-http")]
    #[test]
    fn bounded_transport_truncates_and_filters_response_secrets() -> Result<(), RuntimeHttpTestError>
    {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> Result<(), std::io::Error> {
            let (mut stream, _) = listener.accept()?;
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer)?;
            stream.write_all(
                b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/plain\r\nSet-Cookie: secret=value\r\n\r\nabcdef",
            )?;
            Ok(())
        });

        let transport = ReqwestHttpTransport::with_private_network_access_for_tests()?;
        let response = transport.send_bounded(
            RuntimeHttpRequest {
                method: HttpMethod::Get,
                url: format!("http://{address}/bounded"),
                headers: Vec::new(),
                body: None,
            },
            3,
        )?;
        server
            .join()
            .map_err(|_| RuntimeHttpTestError::ServerThread)??;

        assert_eq!(response.body, "abc");
        assert_eq!(response.body_bytes, 3);
        assert_eq!(
            response.body_digest,
            runx_contracts::sha256_prefixed(b"abc")
        );
        assert!(response.truncated);
        assert!(response.headers.iter().any(|header| {
            header.name.eq_ignore_ascii_case("content-type") && header.value == "text/plain"
        }));
        assert!(
            response
                .headers
                .iter()
                .all(|header| !header.name.eq_ignore_ascii_case("set-cookie"))
        );
        Ok(())
    }

    #[cfg(feature = "async-http")]
    #[test]
    fn reqwest_transport_times_out_stalled_response() -> Result<(), RuntimeHttpTestError> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> Result<(), std::io::Error> {
            // Stall without ever responding until the client's timeout fires
            // and it drops the connection (read observes EOF or reset), rather
            // than sleeping a fixed window longer than the timeout under test.
            let (mut stream, _) = listener.accept()?;
            let mut buffer = [0_u8; 1024];
            while let Ok(read) = stream.read(&mut buffer) {
                if read == 0 {
                    break;
                }
            }
            Ok(())
        });

        let transport = ReqwestHttpTransport::with_private_network_timeouts_for_tests(
            Duration::from_millis(100),
            Duration::from_millis(100),
        )?;
        let error = transport
            .send(RuntimeHttpRequest {
                method: HttpMethod::Get,
                url: format!("http://{address}/stall"),
                headers: Vec::new(),
                body: None,
            })
            .err();
        server
            .join()
            .map_err(|_| RuntimeHttpTestError::ServerThread)??;

        assert!(matches!(error, Some(RuntimeHttpError::Transport { .. })));
        Ok(())
    }
}
