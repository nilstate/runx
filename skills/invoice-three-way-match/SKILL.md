---
name: invoice-three-way-match
version: 0.1.0
description: Extract an invoice, match it against a purchase order and goods receipt, code GL expense lines, and emit a gated payment proposal only when the evidence matches policy.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/zdfgu113/runx/tree/codex/invoice-three-way-match/skills/invoice-three-way-match
runx:
  category: finance
  input_resolution:
    required:
      - invoice
      - po
      - goods_receipt
      - policy
---

# Invoice Three-Way Match

Extract an invoice, compare it with the purchase order and goods receipt, assign
general-ledger coding, and emit a bounded `payment_proposal` only when the three
documents agree and the invoice is below the approval threshold.

The proposal is a gated Effect for the `settle-invoice` catalog skill. This
skill does not move money, sign payment instructions, call a rail, or mutate
external state.

## When to use this skill

Use it during accounts-payable intake when an operator needs a checkable packet
showing whether an invoice can proceed to payment approval. The sealed receipt
contains the extracted invoice facts, match status, discrepancies, GL coding,
proposal details when eligible, and named exceptions when not eligible.

## When not to use this skill

Do not use it to execute payment, override a purchase policy, infer missing line
items, or force a match from incomplete evidence. If the invoice, purchase order,
or goods receipt lacks the facts needed to support a match, the skill refuses and
routes the issue into `exceptions[]`.

## Procedure

1. Require typed inputs `invoice`, `po`, `goods_receipt`, and `policy`.
2. Extract invoice number, vendor, PO number, total, currency, and line items
   from explicit invoice fields.
3. Extract PO number, vendor, currency, and ordered line items from the purchase
   order.
4. Extract receipt number, PO number, and received line quantities from the goods
   receipt.
5. Compare invoice PO number, receipt PO number, vendor, currency, line
   quantity, unit price, and received quantity.
6. Compare invoice total with `policy.auto_approve_under`.
7. Code invoice lines into GL buckets using explicit category or description
   signals.
8. Emit `match.status: matched` and `payment_proposal` only when every comparison
   passes.
9. Emit `match.status: exception`, named `discrepancies`, and `exceptions[]`
   with no proposal when any required fact is missing or any comparison fails.

## Output

The runner emits `runx.invoice_three_way_match.v1` with:

- `summary`: short decision summary.
- `extracted`: invoice facts used for the decision.
- `match`: `{ status, discrepancies }`.
- `gl_coding`: account allocations derived from the invoice lines.
- `payment_proposal`: gated proposal for `settle-invoice` when matched.
- `exceptions`: explicit reasons that block payment approval.

## Example

```bash
runx skill ./skills/invoice-three-way-match \
  --input-json invoice='{"invoice_number":"INV-2026-0101","vendor":"Northwind Software","po_number":"PO-2026-044","receipt_number":"GR-2026-044","currency":"USD","total":1800,"line_items":[{"sku":"SAAS-SEATS","description":"Platform seats","category":"software","quantity":3,"unit_price":600,"amount":1800}]}' \
  --input-json po='{"po_number":"PO-2026-044","vendor":"Northwind Software","currency":"USD","line_items":[{"sku":"SAAS-SEATS","description":"Platform seats","category":"software","quantity":3,"unit_price":600,"amount":1800}]}' \
  --input-json goods_receipt='{"receipt_number":"GR-2026-044","po_number":"PO-2026-044","vendor":"Northwind Software","line_items":[{"sku":"SAAS-SEATS","description":"Platform seats","quantity_received":3}]}' \
  --input-json policy='{"auto_approve_under":2500}' \
  --json
```

## Inputs

- `invoice` (required): object with invoice reference, vendor, PO number, total,
  currency, and explicit line items.
- `po` (required): object with PO number, vendor, currency, and ordered line
  items.
- `goods_receipt` (required): object with receipt reference, PO number, and
  received line quantities.
- `policy` (required): object with `auto_approve_under`, expressed in the same
  units and currency as `invoice.total`.
