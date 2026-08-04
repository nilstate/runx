use runx_contracts::{JsonNumber, JsonObject, JsonValue, sha256_prefixed};

use super::{
    ProviderEffectAuthority, ProviderEffectClass, ProviderEffectError, ProviderEffectIntent,
    ProviderEffectIntentInput, ProviderEffectResolved,
};

impl ProviderEffectIntent {
    pub fn new(input: ProviderEffectIntentInput<'_>) -> Result<Self, ProviderEffectError> {
        let provider = safe_value(input.provider.to_owned(), "provider")?;
        let operation = safe_value(input.operation.to_owned(), "operation")?;
        let target = safe_value(input.target.to_owned(), "target")?;
        let required_scopes = normalize_scopes(input.required_scopes)?;
        let amount = input.amount;
        if let Some(amount) = &amount {
            safe_value(amount.unit.clone(), "amount.unit")?;
        }
        let payload_digest = digest_json(&JsonValue::Object(input.payload.clone()))?;
        let request_key_digest = input
            .request_key
            .map(|value| safe_value(value.to_owned(), "request_key"))
            .transpose()?
            .map(|value| sha256_prefixed(value.as_bytes()));
        Ok(Self {
            class: input.class,
            provider,
            operation,
            target,
            payload_digest,
            required_scopes,
            amount,
            request_key_digest,
        })
    }

    #[must_use]
    pub fn class(&self) -> ProviderEffectClass {
        self.class
    }

    #[must_use]
    pub fn provider(&self) -> &str {
        &self.provider
    }

    #[must_use]
    pub fn operation(&self) -> &str {
        &self.operation
    }

    #[must_use]
    pub fn target(&self) -> &str {
        &self.target
    }

    #[must_use]
    pub fn payload_digest(&self) -> &str {
        &self.payload_digest
    }

    #[must_use]
    pub fn required_scopes(&self) -> &[String] {
        &self.required_scopes
    }
}

impl ProviderEffectAuthority {
    pub fn new(
        grant_id: impl Into<String>,
        principal_ref: impl Into<String>,
    ) -> Result<Self, ProviderEffectError> {
        Ok(Self {
            grant_id: safe_value(grant_id.into(), "grant_id")?,
            principal_ref: safe_value(principal_ref.into(), "principal_ref")?,
        })
    }

    #[must_use]
    pub fn grant_id(&self) -> &str {
        &self.grant_id
    }

    #[must_use]
    pub fn principal_ref(&self) -> &str {
        &self.principal_ref
    }
}

impl ProviderEffectResolved {
    pub fn new(
        intent: ProviderEffectIntent,
        authority: ProviderEffectAuthority,
    ) -> Result<Self, ProviderEffectError> {
        let plan_digest = digest_json(&resolved_digest_value(&intent, &authority)?)?;
        Ok(Self {
            intent,
            authority,
            plan_digest,
        })
    }

    #[must_use]
    pub fn intent(&self) -> &ProviderEffectIntent {
        &self.intent
    }

    #[must_use]
    pub fn authority(&self) -> &ProviderEffectAuthority {
        &self.authority
    }

    #[must_use]
    pub fn plan_digest(&self) -> &str {
        &self.plan_digest
    }

    #[must_use]
    pub fn approval_summary(&self) -> JsonObject {
        let mut summary = JsonObject::from([
            (
                "provider".to_owned(),
                JsonValue::String(self.intent.provider.clone()),
            ),
            (
                "grant_ref".to_owned(),
                JsonValue::String(format!("runx:grant:{}", self.authority.grant_id)),
            ),
            (
                "principal_ref".to_owned(),
                JsonValue::String(self.authority.principal_ref.clone()),
            ),
            (
                "operation".to_owned(),
                JsonValue::String(self.intent.operation.clone()),
            ),
            (
                "target".to_owned(),
                JsonValue::String(self.intent.target.clone()),
            ),
            (
                "payload_digest".to_owned(),
                JsonValue::String(self.intent.payload_digest.clone()),
            ),
            (
                "required_scopes".to_owned(),
                JsonValue::Array(
                    self.intent
                        .required_scopes
                        .iter()
                        .cloned()
                        .map(JsonValue::String)
                        .collect(),
                ),
            ),
            (
                "plan_digest".to_owned(),
                JsonValue::String(self.plan_digest.clone()),
            ),
        ]);
        if let Some(amount) = &self.intent.amount {
            summary.insert(
                "amount".to_owned(),
                JsonValue::Object(JsonObject::from([
                    (
                        "units".to_owned(),
                        JsonValue::Number(JsonNumber::U64(amount.units)),
                    ),
                    ("unit".to_owned(), JsonValue::String(amount.unit.clone())),
                ])),
            );
        }
        summary
    }
}

fn resolved_digest_value(
    intent: &ProviderEffectIntent,
    authority: &ProviderEffectAuthority,
) -> Result<JsonValue, ProviderEffectError> {
    let value = serde_json::json!({
        "schema": "runx.provider.effect_plan.v1",
        "class": intent.class,
        "provider": intent.provider,
        "grant_id": authority.grant_id,
        "principal_ref": authority.principal_ref,
        "operation": intent.operation,
        "target": intent.target,
        "payload_digest": intent.payload_digest,
        "required_scopes": intent.required_scopes,
        "amount": intent.amount,
        "request_key_digest": intent.request_key_digest,
    });
    serde_json::from_value(value).map_err(|error| ProviderEffectError::Digest(error.to_string()))
}

fn normalize_scopes(scopes: Vec<String>) -> Result<Vec<String>, ProviderEffectError> {
    if scopes.is_empty() {
        return Err(ProviderEffectError::MissingScopes);
    }
    if scopes.iter().any(|scope| scope.trim().is_empty()) {
        return Err(ProviderEffectError::InvalidField { field: "scope" });
    }
    Ok(scopes)
}

pub(super) fn safe_value(
    value: String,
    field: &'static str,
) -> Result<String, ProviderEffectError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(ProviderEffectError::InvalidField { field });
    }
    Ok(value.to_owned())
}

pub(super) fn digest_json(value: &JsonValue) -> Result<String, ProviderEffectError> {
    serde_json::to_vec(value)
        .map(|bytes| sha256_prefixed(&bytes))
        .map_err(|error| ProviderEffectError::Digest(error.to_string()))
}
