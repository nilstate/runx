---
name: pay-quote
description: Deterministically normalize one structured payment signal into a bounded quote and requested payment authority derived from the caller's real parent authority.
---

# Pay Quote

Use this internal stage only through the canonical `spend` graph. It invokes
the native `payment.quote` tool; no model authors amounts, rails, authority
terms, ids, or evidence.

The caller must supply a full typed parent `AuthorityTerm`. A grant reference
alone is not authority and is refused. The native boundary checks amount,
currency, rail, realm, counterparty, operation, aggregate limits, single-use
capability, and idempotency material before emitting `runx.payment.quote.v1`.

This stage is read-only. It does not reserve budget, mint a capability, request
approval, contact a payment rail, or claim settlement.
