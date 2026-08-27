use super::intent::{digest_json, safe_value};
use super::{
    ProviderAcknowledgementEvidence, ProviderApprovalEvidence, ProviderEffectAcknowledged,
    ProviderEffectApproval, ProviderEffectAttempt, ProviderEffectClass, ProviderEffectError,
    ProviderEffectFinality, ProviderEffectReadback, ProviderEffectReadbackEvidence,
    ProviderEffectResolved, ProviderEffectUnknown,
};

impl ProviderEffectResolved {
    pub fn begin(
        self,
        approval: Option<ProviderApprovalEvidence>,
    ) -> Result<ProviderEffectAttempt, ProviderEffectError> {
        let approval = match (self.intent.class, self.intent.requires_approval(), approval) {
            (ProviderEffectClass::Draft, _, _) => {
                return Err(ProviderEffectError::DraftCannotExecute);
            }
            (ProviderEffectClass::Read, _, Some(_)) => {
                return Err(ProviderEffectError::GratuitousApproval {
                    class: ProviderEffectClass::Read,
                });
            }
            (ProviderEffectClass::Read, _, None) => None,
            (ProviderEffectClass::Mutation, true, None) => {
                return Err(ProviderEffectError::ApprovalRequired);
            }
            (ProviderEffectClass::Mutation, false, Some(_)) => {
                return Err(ProviderEffectError::GratuitousApproval {
                    class: ProviderEffectClass::Mutation,
                });
            }
            (ProviderEffectClass::Mutation, false, None) => None,
            (ProviderEffectClass::Mutation, true, Some(evidence)) => {
                if evidence.plan_digest != self.plan_digest {
                    return Err(ProviderEffectError::ApprovalDrift);
                }
                if evidence.actor != "human" && evidence.actor != "paid_external_job" {
                    return Err(ProviderEffectError::ApprovalActorInvalid);
                }
                Some(ProviderEffectApproval {
                    actor: safe_value(evidence.actor, "approval.actor")?,
                    approval_key: safe_value(evidence.approval_key, "approval.key")?,
                    plan_digest: evidence.plan_digest,
                })
            }
        };
        let idempotency_key = format!("runx:{}", self.plan_digest);
        Ok(ProviderEffectAttempt {
            resolved: self,
            approval,
            idempotency_key,
            attempt: 1,
        })
    }

    pub fn begin_retry(
        self,
        approval: Option<ProviderApprovalEvidence>,
        previous_attempt: u32,
    ) -> Result<ProviderEffectAttempt, ProviderEffectError> {
        if previous_attempt == 0 {
            return Err(ProviderEffectError::InvalidRecoveryAttempt);
        }
        let mut attempt = self.begin(approval)?;
        attempt.attempt = previous_attempt.saturating_add(1);
        Ok(attempt)
    }
}

impl ProviderEffectAttempt {
    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    #[must_use]
    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    #[must_use]
    pub fn resolved(&self) -> &ProviderEffectResolved {
        &self.resolved
    }

    #[must_use]
    pub fn approval_key(&self) -> Option<&str> {
        self.approval
            .as_ref()
            .map(|approval| approval.approval_key.as_str())
    }

    #[must_use]
    pub fn approval_actor(&self) -> Option<&str> {
        self.approval
            .as_ref()
            .map(|approval| approval.actor.as_str())
    }

    pub fn acknowledge(
        self,
        evidence: ProviderAcknowledgementEvidence,
    ) -> Result<ProviderEffectAcknowledged, ProviderEffectError> {
        require_equal(
            evidence.provider.as_str(),
            self.resolved.intent.provider.as_str(),
            "provider",
            true,
        )?;
        require_equal(
            evidence.operation.as_str(),
            self.resolved.intent.operation.as_str(),
            "operation",
            true,
        )?;
        require_equal(
            evidence.target.as_str(),
            self.resolved.intent.target.as_str(),
            "target",
            true,
        )?;
        if self.resolved.intent.class == ProviderEffectClass::Mutation {
            let operation_id = non_empty(evidence.operation_id.as_deref()).ok_or(
                ProviderEffectError::MissingAcknowledgement {
                    field: "operation_id",
                },
            )?;
            let idempotency_key = non_empty(evidence.idempotency_key.as_deref()).ok_or(
                ProviderEffectError::MissingAcknowledgement {
                    field: "idempotency_key",
                },
            )?;
            require_equal(
                idempotency_key,
                &self.idempotency_key,
                "idempotency_key",
                true,
            )?;
            return Ok(ProviderEffectAcknowledged {
                attempt: self,
                operation_id: Some(operation_id.to_owned()),
            });
        }
        Ok(ProviderEffectAcknowledged {
            attempt: self,
            operation_id: evidence.operation_id,
        })
    }

    #[must_use]
    pub fn unknown(self, reason: impl Into<String>) -> ProviderEffectUnknown {
        ProviderEffectUnknown {
            attempt: self,
            reason: reason.into(),
        }
    }
}

impl ProviderEffectUnknown {
    #[must_use]
    pub fn attempt(&self) -> &ProviderEffectAttempt {
        &self.attempt
    }

    #[must_use]
    pub fn retry(mut self) -> ProviderEffectAttempt {
        self.attempt.attempt = self.attempt.attempt.saturating_add(1);
        self.attempt
    }

    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

impl ProviderEffectAcknowledged {
    pub fn readback(
        self,
        evidence: ProviderEffectReadbackEvidence,
    ) -> Result<ProviderEffectReadback, ProviderEffectError> {
        require_equal(
            evidence.provider.as_str(),
            self.attempt.resolved.intent.provider.as_str(),
            "provider",
            false,
        )?;
        require_equal(
            evidence.operation.as_str(),
            self.attempt.resolved.intent.operation.as_str(),
            "operation",
            false,
        )?;
        require_equal(
            evidence.target.as_str(),
            self.attempt.resolved.intent.target.as_str(),
            "target",
            false,
        )?;
        require_optional_equal(
            evidence.operation_id.as_deref(),
            self.operation_id.as_deref(),
            "operation_id",
        )?;
        let readback_ref = non_empty(Some(evidence.readback_ref.as_str()))
            .ok_or(ProviderEffectError::MissingReadback)?
            .to_owned();
        let result_digest = digest_json(&evidence.result)?;
        Ok(ProviderEffectReadback {
            acknowledgement: self,
            readback_ref,
            result_digest,
        })
    }
}

impl ProviderEffectReadback {
    #[must_use]
    pub fn finalize(self) -> ProviderEffectFinality {
        ProviderEffectFinality {
            plan_digest: self.acknowledgement.attempt.resolved.plan_digest,
            idempotency_key: self.acknowledgement.attempt.idempotency_key,
            operation_id: self.acknowledgement.operation_id,
            readback_ref: self.readback_ref,
            result_digest: self.result_digest,
        }
    }
}

impl ProviderEffectFinality {
    #[must_use]
    pub fn plan_digest(&self) -> &str {
        &self.plan_digest
    }

    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    #[must_use]
    pub fn operation_id(&self) -> Option<&str> {
        self.operation_id.as_deref()
    }

    #[must_use]
    pub fn readback_ref(&self) -> &str {
        &self.readback_ref
    }

    #[must_use]
    pub fn result_digest(&self) -> &str {
        &self.result_digest
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn require_equal(
    actual: &str,
    expected: &str,
    field: &'static str,
    acknowledgement: bool,
) -> Result<(), ProviderEffectError> {
    if actual == expected {
        Ok(())
    } else if acknowledgement {
        Err(ProviderEffectError::AcknowledgementMismatch { field })
    } else {
        Err(ProviderEffectError::ReadbackMismatch { field })
    }
}

fn require_optional_equal(
    actual: Option<&str>,
    expected: Option<&str>,
    field: &'static str,
) -> Result<(), ProviderEffectError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ProviderEffectError::ReadbackMismatch { field })
    }
}
