use std::collections::BTreeMap;

use super::credential_delivery_from_invocation;
use crate::credentials::RUNX_HOSTED_CREDENTIAL_HANDLES_JSON_ENV;
use crate::execution::orchestrator::LocalCredentialDescriptor;

#[test]
fn selected_local_credential_wins_over_ambient_hosted_handles()
-> Result<(), Box<dyn std::error::Error>> {
    let local = LocalCredentialDescriptor {
        profile: Some("local-profile".to_owned()),
        provider: "example".to_owned(),
        audience: None,
        auth_mode: "api_key".to_owned(),
        env_var: "EXAMPLE_TOKEN".to_owned(),
        material_ref: "local:example:local-profile".to_owned(),
        scopes: vec!["example:read".to_owned()],
        secret: "selected-local-secret".to_owned(),
    };
    let env = BTreeMap::from([(
        RUNX_HOSTED_CREDENTIAL_HANDLES_JSON_ENV.to_owned(),
        r#"[{"credential_ref":{"type":"credential","uri":"runx:credential:hosted"},"provider":"example","purpose":"provider_api"}]"#.to_owned(),
    )]);

    let delivery = credential_delivery_from_invocation(&env, Some(&local))?;

    assert_eq!(
        delivery.secret_env().get("EXAMPLE_TOKEN"),
        Some("selected-local-secret")
    );
    assert_eq!(
        delivery
            .public_observation()
            .map(|observation| observation.provider.as_str()),
        Some("example")
    );
    Ok(())
}
