//! Credential-delivery redaction for external adapter responses.
//!
//! Every string-shaped field on `ExternalAdapterResponse` is rewritten through
//! the credential delivery's `redact_text` so adapter stdout, stderr,
//! telemetry, and structured artifacts cannot leak credential material.

use runx_contracts::{ExternalAdapterResponse, ExternalAdapterTelemetryValue};

use crate::credentials::CredentialDelivery;

pub(super) fn redact_response(
    response: &mut ExternalAdapterResponse,
    credential_delivery: &CredentialDelivery,
) {
    response.schema = credential_delivery.redact_text(std::mem::take(&mut response.schema));
    response.protocol_version =
        credential_delivery.redact_text(std::mem::take(&mut response.protocol_version));
    response.invocation_id =
        credential_delivery.redact_text(std::mem::take(&mut response.invocation_id));
    response.adapter_id = credential_delivery.redact_text(std::mem::take(&mut response.adapter_id));
    response.observed_at =
        credential_delivery.redact_text(std::mem::take(&mut response.observed_at));
    if let Some(stdout) = response.stdout.take() {
        response.stdout = Some(credential_delivery.redact_text(stdout));
    }
    if let Some(stderr) = response.stderr.take() {
        response.stderr = Some(credential_delivery.redact_text(stderr));
    }
    if let Some(output) = response.output.as_mut() {
        credential_delivery.redact_json_object(output);
    }
    if let Some(metadata) = response.metadata.as_mut() {
        credential_delivery.redact_json_object(metadata);
    }
    if let Some(artifacts) = response.artifacts.as_mut() {
        for artifact in artifacts {
            if let Some(summary) = artifact.summary.take() {
                artifact.summary = Some(credential_delivery.redact_text(summary));
            }
        }
    }
    if let Some(errors) = response.errors.as_mut() {
        for error in errors {
            error.code = credential_delivery.redact_text(std::mem::take(&mut error.code));
            error.message = credential_delivery.redact_text(std::mem::take(&mut error.message));
        }
    }
    if let Some(telemetry) = response.telemetry.as_mut() {
        for observation in telemetry {
            observation.name =
                credential_delivery.redact_text(std::mem::take(&mut observation.name));
            if let Some(unit) = observation.unit.take() {
                observation.unit = Some(credential_delivery.redact_text(unit));
            }
            if let ExternalAdapterTelemetryValue::String(value) = &mut observation.value {
                *value = credential_delivery.redact_text(std::mem::take(value));
            }
        }
    }
}
