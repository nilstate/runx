---
name: agency-health-prepare
description: Normalize an agency-health case key, bounded period, declared baseline, and receipt-ledger query without adding authority or performing effects.
---

# Agency Health Prepare

Internal deterministic stage for `agency-health`. It validates the public
inputs, resolves the optional `case_id`, and emits the read-only query plan used
by the projection, event, and ledger reads. It never accesses a provider or
changes state.
