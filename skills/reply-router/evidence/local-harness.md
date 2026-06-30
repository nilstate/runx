# reply-router local harness evidence

Date: 2026-06-30
Runtime: Docker Linux container, node v24.18.0
runx: runx-cli 0.6.14
Command: runx harness ./skills/reply-router

Result: passed
Case count: 3
Assertion errors: 0
Graph case count: 3

Cases:
- sealed_unsubscribe_suppression: sealed
- sealed_interested_route: sealed
- stop_ambiguous_or_unsealed: needs_agent

Local harness receipt ids:
- sha256:2a578af7c2f0c945bbffca33bfd1d9110348e54a8df7d96b3fdc380eda7d512b
- sha256:c8abee8fa3c3355c9aa655074d2bec21948d8de8e5f164cdeadaa83fc8e71519

Notes:
- The unsubscribe case exercises recipient-keyed suppression with append_event, expected_version CAS, and idempotency_key.
- The interested case emits a bounded runx.reply.routing.v1 send-as target without sending.
- The stop case omits the sealed original receipt, has no caller.answers, and blocks to needs_agent without suppression or routing.
