use runx_contracts::{JsonObject, JsonValue, ThreadOutboxProviderOperation};

use crate::adapter::{
    CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA, InvocationOutput, InvocationStatus,
};
use crate::outbox_provider::ThreadOutboxProviderProcessOutcome;

use super::{ThreadOutboxProviderSkillAdapterError, json_error};

const OBSERVATION_METADATA: &str = "thread_outbox_provider_observation";
const OPERATION_METADATA: &str = "thread_outbox_provider_operation";
const PROVIDER_LOCATOR_METADATA: &str = "thread_outbox_provider_locator";
const PROVIDER_EVENT_HASH_METADATA: &str = "thread_outbox_provider_event_hash";

pub(super) fn skill_output_from_outcome(
    outcome: ThreadOutboxProviderProcessOutcome,
) -> Result<InvocationOutput, ThreadOutboxProviderSkillAdapterError> {
    let observation_value = contract_json_value(&outcome.observation, "serializing observation")?;
    let value = value_from_outcome(&outcome, observation_value.clone());
    let mut metadata = JsonObject::new();
    metadata.insert(OBSERVATION_METADATA.to_owned(), observation_value);
    metadata.insert(
        OPERATION_METADATA.to_owned(),
        JsonValue::String(operation_label(&outcome.observation.operation).to_owned()),
    );
    if let Some(locator) = &outcome.observation.provider_locator {
        metadata.insert(
            PROVIDER_LOCATOR_METADATA.to_owned(),
            JsonValue::String(locator.locator.to_string()),
        );
    }
    if let Some(event_hash) = &outcome.observation.provider_event_id_hash {
        metadata.insert(
            PROVIDER_EVENT_HASH_METADATA.to_owned(),
            JsonValue::String(event_hash.to_string()),
        );
    }
    if let Some(delivery_observations) = &outcome.observation.delivery_observations {
        metadata.insert(
            CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA.to_owned(),
            contract_json_value(delivery_observations, "serializing delivery observations")?,
        );
    }
    if let Some(execution_boundary) = &outcome.execution_boundary {
        metadata.extend(execution_boundary.clone());
    }
    Ok(InvocationOutput::process_value(
        InvocationStatus::Success,
        value,
        outcome.redacted_stderr,
        outcome.process_exit_code,
        outcome.duration_ms,
        metadata,
    ))
}

fn value_from_outcome(
    outcome: &ThreadOutboxProviderProcessOutcome,
    observation_value: JsonValue,
) -> JsonValue {
    match outcome.provider_output.clone() {
        Some(mut output) => {
            output.insert(OBSERVATION_METADATA.to_owned(), observation_value);
            JsonValue::Object(output)
        }
        None => observation_value,
    }
}

fn operation_label(operation: &ThreadOutboxProviderOperation) -> &'static str {
    match operation {
        ThreadOutboxProviderOperation::Push => "push",
        ThreadOutboxProviderOperation::Fetch => "fetch",
    }
}

fn contract_json_value(
    value: &impl serde::Serialize,
    context: &'static str,
) -> Result<JsonValue, ThreadOutboxProviderSkillAdapterError> {
    let value = serde_json::to_value(value).map_err(|source| json_error(context, source))?;
    serde_json::from_value(value).map_err(|source| json_error(context, source))
}
