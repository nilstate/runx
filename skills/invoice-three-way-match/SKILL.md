# runx skill: invoice intake and three-way match

## What this skill does

Given structured invoice data, a purchase order, and a goods receipt, this skill performs an automated three-way match and produces a payment approval proposal. It validates line-item quantities and prices, applies general ledger coding, and flags discrepancies for review.

## Input

The skill expects a JSON object with four fields:

| Field | Type | Description |
|-------|------|-------------|
| `invoice` | object | Invoice header and line items (vendor, number, date, line_items with description/quantity/unit_price/total/category) |
| `purchase_order` | object | PO header and line items (po_number, vendor, line_items with description/quantity/unit_price/total) |
| `goods_receipt` | object | Receiving record (receipt_number, received_items with description/quantity_received) |
| `gl_codes` | object | GL mapping (category_to_account: { "category": "GL-XXXX" }) |

### Input example

```json
{
  "meeting_context": {
    "invoice": {
      "vendor": "Acme Office Supplies",
      "invoice_number": "INV-2024-0789",
      "date": "2024-06-15",
      "due_date": "2024-07-15",
      "line_items": [
        { "description": "Premium copy paper A4 case", "quantity": 10, "unit_price": 45.00, "total": 450.00, "category": "office_supplies" },
        { "description": "Toner cartridge HP 26X", "quantity": 5, "unit_price": 120.00, "total": 600.00, "category": "printer_supplies" },
        { "description": "Desk chair ergonomic mesh", "quantity": 2, "unit_price": 350.00, "total": 700.00, "category": "furniture" }
      ],
      "subtotal": 1750.00,
      "tax": 140.00,
      "total": 1890.00
    },
    "purchase_order": {
      "po_number": "PO-2024-0314",
      "vendor": "Acme Office Supplies",
      "date": "2024-06-01",
      "line_items": [
        { "description": "Premium copy paper A4 case", "quantity": 10, "unit_price": 42.00, "total": 420.00 },
        { "description": "Toner cartridge HP 26X", "quantity": 5, "unit_price": 118.00, "total": 590.00 },
        { "description": "Desk chair ergonomic mesh", "quantity": 2, "unit_price": 340.00, "total": 680.00 }
      ]
    },
    "goods_receipt": {
      "receipt_number": "GR-2024-0215",
      "date": "2024-06-12",
      "received_items": [
        { "description": "Premium copy paper A4 case", "quantity_received": 10 },
        { "description": "Toner cartridge HP 26X", "quantity_received": 4 },
        { "description": "Desk chair ergonomic mesh", "quantity_received": 2 }
      ]
    },
    "gl_codes": {
      "category_to_account": {
        "office_supplies": "GL-5100",
        "printer_supplies": "GL-5105",
        "furniture": "GL-5200"
      }
    }
  }
}
```

## Output

The skill produces a JSON object with payment approval proposal fields:

| Field | Type | Description |
|-------|------|-------------|
| `approval_status` | string | `approved`, `conditional`, or `rejected` |
| `matched_lines` | array | Per-line match results against PO and receipt |
| `exceptions` | array | Discrepancies found during matching |
| `total_matched_amount` | number | Sum of fully matched lines |
| `total_exception_amount` | number | Sum of lines with exceptions |
| `gl_summary` | array | GL coding by account |
| `approval_recommendation` | string | Human-readable explanation |

### Output example

```json
{
  "prep_brief": {
    "approval_status": "conditional",
    "matched_lines": [
      { "line_number": 1, "description": "Premium copy paper A4 case", "invoice_amount": 450.00, "po_amount": 420.00, "receipt_qty": 10, "match_status": "price_mismatch", "gl_account": "GL-5100" },
      { "line_number": 2, "description": "Toner cartridge HP 26X", "invoice_amount": 600.00, "po_amount": 590.00, "receipt_qty": 4, "match_status": "quantity_mismatch", "gl_account": "GL-5105" },
      { "line_number": 3, "description": "Desk chair ergonomic mesh", "invoice_amount": 700.00, "po_amount": 680.00, "receipt_qty": 2, "match_status": "price_mismatch", "gl_account": "GL-5200" }
    ],
    "exceptions": [
      { "type": "price_mismatch", "line_number": 1, "description": "Premium copy paper A4 case", "expected": "42.00 per unit (PO)", "actual": "45.00 per unit (invoice)", "severity": "medium" },
      { "type": "quantity_mismatch", "line_number": 2, "description": "Toner cartridge HP 26X", "expected": "5 received (PO qty)", "actual": "4 received (goods receipt)", "severity": "medium" },
      { "type": "price_mismatch", "line_number": 3, "description": "Desk chair ergonomic mesh", "expected": "340.00 per unit (PO)", "actual": "350.00 per unit (invoice)", "severity": "low" }
    ],
    "total_matched_amount": 0,
    "total_exception_amount": 1750.00,
    "gl_summary": [
      { "account": "GL-5100", "description": "Office supplies", "amount": 450.00 },
      { "account": "GL-5105", "description": "Printer supplies", "amount": 600.00 },
      { "account": "GL-5200", "description": "Furniture", "amount": 700.00 }
    ],
    "approval_recommendation": "Conditional approval recommended. Three price variances and one quantity variance found. Total variance of $90.00 is within 5% threshold. Recommend approving with price adjustment to PO rates."
  }
}
```

## Procedure

1. The agent receives the input JSON with invoice, purchase_order, goods_receipt, and gl_codes
2. For each invoice line item, the agent:
   a. Finds the matching line in the purchase order by description
   b. Checks the goods receipt for received quantity
   c. Compares invoice unit_price against PO unit_price
   d. Compares invoice quantity against receipt quantity
3. If all three match (description, price, quantity), the line is marked as `matched`
4. Discrepancies are recorded as `exceptions` with severity:
   - `low`: variance under 3%
   - `medium`: variance 3-10%
   - `high`: variance over 10% or item missing from PO/receipt
5. GL codes are applied based on the category_to_account mapping
6. The final approval status is determined:
   - `approved`: no exceptions
   - `conditional`: exceptions exist but within threshold
   - `rejected`: high-severity exceptions or missing critical data
7. Output the structured JSON response

## Worked example

See the fixture at `fixtures/full-match/` for a clean three-way match scenario and `fixtures/partial-exception/` for a case with price and quantity discrepancies.
