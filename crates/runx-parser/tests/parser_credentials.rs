use runx_parser::{parse_runner_manifest_yaml, validate_runner_manifest};

fn validate(yaml: &str) -> Result<runx_parser::SkillRunnerManifest, String> {
    let raw = parse_runner_manifest_yaml(yaml).map_err(|error| error.to_string())?;
    validate_runner_manifest(raw).map_err(|error| error.to_string())
}

#[test]
fn runner_references_named_credential_requirement() -> Result<(), String> {
    let manifest = validate(
        r#"
skill: support
credentials:
  nitrosend:
    provider: nitrosend
    audience: https://api.nitrosend.com
    auth:
      api_key:
        delivery:
          env: NITROSEND_API_KEY
runners:
  queue:
    default: true
    type: cli-tool
    command: support
    credential: nitrosend
"#,
    )?;
    let credential = manifest
        .credentials
        .get("nitrosend")
        .ok_or_else(|| "missing credential".to_owned())?;
    assert_eq!(
        credential.deliveries.get("api_key").map(String::as_str),
        Some("NITROSEND_API_KEY")
    );
    assert_eq!(
        manifest
            .runners
            .get("queue")
            .and_then(|runner| runner.credential.as_deref()),
        Some("nitrosend")
    );
    Ok(())
}

#[test]
fn undeclared_runner_credential_fails_closed() -> Result<(), String> {
    let error = match validate(
        r#"
skill: support
runners:
  queue:
    default: true
    type: cli-tool
    command: support
    credential: nitrosend
"#,
    ) {
        Ok(_) => return Err("undeclared credential unexpectedly passed".to_owned()),
        Err(error) => error,
    };
    assert!(error.contains("references undeclared credential nitrosend"));
    Ok(())
}

#[test]
fn credential_requirement_supports_multiple_explicit_auth_modes() -> Result<(), String> {
    let manifest = validate(
        r#"
skill: twitter
credentials:
  twitter-read:
    provider: twitter
    auth:
      oauth1_user:
        delivery:
          env: TWITTER_USER_AUTH
      bearer:
        delivery:
          env: TWITTER_BEARER_TOKEN
runners:
  read:
    default: true
    type: cli-tool
    command: twitter-read
    credential: twitter-read
"#,
    )?;
    let credential = manifest
        .credentials
        .get("twitter-read")
        .ok_or_else(|| "missing credential".to_owned())?;
    assert_eq!(credential.deliveries.len(), 2);
    assert_eq!(
        credential.deliveries.get("bearer").map(String::as_str),
        Some("TWITTER_BEARER_TOKEN")
    );
    assert_eq!(
        credential.deliveries.get("oauth1_user").map(String::as_str),
        Some("TWITTER_USER_AUTH")
    );
    Ok(())
}

#[test]
fn credential_delivery_cannot_be_redeclared_as_non_secret_environment() -> Result<(), String> {
    let error = match validate(
        r#"
skill: support
credentials:
  nitrosend:
    provider: nitrosend
    auth:
      api_key:
        delivery:
          env: NITROSEND_API_KEY
runners:
  queue:
    default: true
    type: cli-tool
    command: support
    credential: nitrosend
    environment:
      required: [NITROSEND_API_KEY]
"#,
    ) {
        Ok(_) => return Err("credential/environment collision unexpectedly passed".to_owned()),
        Err(error) => error,
    };
    assert!(
        error.contains(
            "cannot redeclare credential delivery environment variable NITROSEND_API_KEY"
        )
    );
    Ok(())
}
