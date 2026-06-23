import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();
const invoice = objectInput(inputs.invoice, "invoice");
const po = objectInput(inputs.po, "po");
const goodsReceipt = objectInput(inputs.goods_receipt, "goods_receipt");
const policy = objectInput(inputs.policy, "policy");

const decision = decide(invoice, po, goodsReceipt, policy);
process.stdout.write(`${JSON.stringify(decision.output, null, 2)}\n`);
if (!decision.ok) process.exit(64);

function decide(invoiceInput, poInput, receiptInput, policyInput) {
  const extracted = extractInvoice(invoiceInput);
  const po = extractOrder(poInput);
  const receipt = extractReceipt(receiptInput);
  const autoApproveUnder = numberValue(policyInput.auto_approve_under);
  const exceptions = [];
  const discrepancies = [];

  requireField(extracted.invoice_ref, "invoice.invoice_number", exceptions);
  requireField(extracted.vendor, "invoice.vendor", exceptions);
  requireField(extracted.po_number, "invoice.po_number", exceptions);
  requireField(extracted.total, "invoice.total", exceptions);
  requireField(extracted.currency, "invoice.currency", exceptions);
  requireField(po.po_number, "po.po_number", exceptions);
  requireField(po.vendor, "po.vendor", exceptions);
  requireField(receipt.po_number, "goods_receipt.po_number", exceptions);
  requireField(autoApproveUnder, "policy.auto_approve_under", exceptions);

  if (extracted.line_items.length === 0) {
    exceptions.push("invoice.line_items missing");
  }
  if (po.line_items.length === 0) {
    exceptions.push("po.line_items missing");
  }
  if (receipt.line_items.length === 0) {
    exceptions.push("goods_receipt.line_items missing");
  }

  if (extracted.po_number && po.po_number && extracted.po_number !== po.po_number) {
    discrepancies.push(`invoice PO ${extracted.po_number} does not match PO ${po.po_number}`);
  }
  if (receipt.po_number && po.po_number && receipt.po_number !== po.po_number) {
    discrepancies.push(`receipt PO ${receipt.po_number} does not match PO ${po.po_number}`);
  }
  if (extracted.vendor && po.vendor && normalizeText(extracted.vendor) !== normalizeText(po.vendor)) {
    discrepancies.push(`invoice vendor ${extracted.vendor} does not match PO vendor ${po.vendor}`);
  }
  if (extracted.currency && po.currency && extracted.currency !== po.currency) {
    discrepancies.push(`invoice currency ${extracted.currency} does not match PO currency ${po.currency}`);
  }
  if (Number.isFinite(extracted.total) && Number.isFinite(autoApproveUnder) && extracted.total > autoApproveUnder) {
    discrepancies.push(`invoice total ${extracted.total} exceeds auto approval threshold ${autoApproveUnder}`);
  }

  for (const line of extracted.line_items) {
    const poLine = findLine(po.line_items, line);
    const receiptLine = findLine(receipt.line_items, line);
    if (!poLine) {
      discrepancies.push(`invoice line ${line.key} not found on PO`);
      continue;
    }
    if (!receiptLine) {
      discrepancies.push(`invoice line ${line.key} not found on goods receipt`);
      continue;
    }
    if (!sameNumber(line.quantity, poLine.quantity)) {
      discrepancies.push(`line ${line.key} invoice quantity ${line.quantity} differs from PO quantity ${poLine.quantity}`);
    }
    if (!sameNumber(line.unit_price, poLine.unit_price)) {
      discrepancies.push(`line ${line.key} invoice unit price ${line.unit_price} differs from PO unit price ${poLine.unit_price}`);
    }
    if (Number.isFinite(line.quantity) && Number.isFinite(receiptLine.quantity_received) && line.quantity > receiptLine.quantity_received) {
      discrepancies.push(`line ${line.key} invoice quantity ${line.quantity} exceeds received quantity ${receiptLine.quantity_received}`);
    }
  }

  const allExceptions = [...exceptions, ...discrepancies];
  const glCoding = codeGl(extracted.line_items, extracted.currency);
  const base = {
    summary: "",
    extracted,
    match: {
      status: allExceptions.length === 0 ? "matched" : "exception",
      discrepancies,
    },
    gl_coding: glCoding,
    payment_proposal: null,
    exceptions: allExceptions,
  };

  if (allExceptions.length > 0) {
    return refused(base);
  }

  const proposalId = proposalKey(extracted, po, receipt);
  return {
    ok: true,
    output: {
      ...base,
      summary: `Invoice ${extracted.invoice_ref} matched PO ${po.po_number} and receipt ${receipt.receipt_ref}; payment proposal ${proposalId} is ready for settle-invoice.`,
      payment_proposal: {
        idempotency_key: proposalId,
        invoice_ref: extracted.invoice_ref,
        po_number: po.po_number,
        goods_receipt_ref: receipt.receipt_ref,
        amount: extracted.total,
        currency: extracted.currency,
        vendor: extracted.vendor,
        gl_coding: glCoding,
        effect: {
          kind: "payment_approval_proposal",
          gated: true,
          consumer: "settle-invoice",
          performs_money_movement: false,
        },
      },
    },
  };
}

function refused(base) {
  return {
    ok: false,
    output: {
      ...base,
      summary: `Invoice three-way match refused: ${base.exceptions.join("; ")}. No payment proposal was emitted.`,
      payment_proposal: null,
    },
  };
}

function extractInvoice(input) {
  const lineItems = Array.isArray(input.line_items) ? input.line_items.map(normalizeLine) : [];
  return {
    invoice_ref: stringValue(input.invoice_number ?? input.invoice_ref ?? input.id),
    vendor: stringValue(input.vendor ?? input.supplier),
    po_number: stringValue(input.po_number ?? input.purchase_order),
    receipt_number: stringValue(input.receipt_number ?? input.goods_receipt_ref),
    total: numberValue(input.total ?? input.amount_due),
    currency: currencyValue(input.currency),
    line_items: lineItems,
  };
}

function extractOrder(input) {
  return {
    po_number: stringValue(input.po_number ?? input.id),
    vendor: stringValue(input.vendor ?? input.supplier),
    currency: currencyValue(input.currency),
    line_items: Array.isArray(input.line_items) ? input.line_items.map(normalizeLine) : [],
  };
}

function extractReceipt(input) {
  return {
    receipt_ref: stringValue(input.receipt_number ?? input.id ?? input.goods_receipt_ref),
    po_number: stringValue(input.po_number ?? input.purchase_order),
    vendor: stringValue(input.vendor ?? input.supplier),
    line_items: Array.isArray(input.line_items) ? input.line_items.map(normalizeLine) : [],
  };
}

function normalizeLine(item) {
  const sku = stringValue(item.sku ?? item.item_id);
  const description = stringValue(item.description ?? item.name);
  const quantity = numberValue(item.quantity ?? item.qty);
  const quantityReceived = numberValue(item.quantity_received ?? item.received_qty ?? item.qty_received ?? quantity);
  const unitPrice = numberValue(item.unit_price ?? item.price);
  const amount = numberValue(item.amount ?? (Number.isFinite(quantity) && Number.isFinite(unitPrice) ? quantity * unitPrice : undefined));
  const category = stringValue(item.category ?? item.gl_category);
  return {
    key: sku ?? normalizeText(description ?? "unknown"),
    sku,
    description,
    category,
    quantity,
    quantity_received: quantityReceived,
    unit_price: unitPrice,
    amount,
  };
}

function codeGl(lines, currency) {
  const byAccount = new Map();
  for (const line of lines) {
    const account = accountFor(line.category ?? line.description);
    const prior = byAccount.get(account.code) ?? { account: account.code, label: account.label, amount: 0, currency };
    prior.amount = round2(prior.amount + (Number.isFinite(line.amount) ? line.amount : 0));
    byAccount.set(account.code, prior);
  }
  return [...byAccount.values()];
}

function accountFor(value) {
  const text = normalizeText(value ?? "");
  if (text.includes("software") || text.includes("saas")) return { code: "6100", label: "Software and subscriptions" };
  if (text.includes("consult") || text.includes("service")) return { code: "6200", label: "Professional services" };
  if (text.includes("hardware") || text.includes("equipment")) return { code: "6500", label: "Equipment" };
  return { code: "6999", label: "Unclassified operating expense" };
}

function findLine(lines, needle) {
  return lines.find((line) => line.sku && needle.sku && line.sku === needle.sku)
    ?? lines.find((line) => normalizeText(line.description) === normalizeText(needle.description));
}

function requireField(value, label, exceptions) {
  if (typeof value === "number" ? !Number.isFinite(value) : !value) {
    exceptions.push(`${label} missing`);
  }
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    invoice: parseInputValue(process.env.RUNX_INPUT_INVOICE),
    po: parseInputValue(process.env.RUNX_INPUT_PO),
    goods_receipt: parseInputValue(process.env.RUNX_INPUT_GOODS_RECEIPT),
    policy: parseInputValue(process.env.RUNX_INPUT_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectInput(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    process.stderr.write(`${name} must be an object\n`);
    process.exit(64);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function currencyValue(value) {
  const text = stringValue(value);
  return text ? text.toUpperCase() : null;
}

function normalizeText(value) {
  return stringValue(value)?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
}

function numberValue(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sameNumber(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.00001;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function proposalKey(invoice, po, receipt) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      invoice: invoice.invoice_ref,
      po: po.po_number,
      receipt: receipt.receipt_ref,
      amount: invoice.total,
      currency: invoice.currency,
    }))
    .digest("hex")
    .slice(0, 24);
  return `invoice-three-way:${digest}`;
}
