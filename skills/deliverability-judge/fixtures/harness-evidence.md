# Deliverability Judge Harness Evidence

- `sealed_healthy_signals_continue` covers a fully sealed healthy signal set: strong postmaster reputation, low bounce, low complaint, and strong inbox placement.
- `contradictory_signals_escalate` covers a high reputation score contradicted by high bounce and poor inbox placement, which must escalate and emit no recommendation.
- Fixtures contain only synthetic deliverability metadata and no recipients, message bodies, credentials, or private account state.
- The skill emits read-only verdict evidence only. It does not send, throttle, mutate, or mint authority.
