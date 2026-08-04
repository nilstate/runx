import { describe, expect, it } from "vitest";

import auditLeastPrivilege from "../skills/least-privilege/least-privilege.mjs";

describe("least-privilege scope normalization", () => {
  it("reads canonical Runx scopes as resource:verb", () => {
    const report = auditLeastPrivilege({
      subject: "growth/lifecycle-campaign-send",
      granted_scopes: ["email:send", "repo:write", "payment:spend"],
      receipt_ids: ["rcpt_campaign_1"],
      ledger_evidence: {
        matched_receipts: [{ receipt_id: "rcpt_campaign_1" }],
        receipt_details: [{
          id: "rcpt_campaign_1",
          authority: { exercised_scopes: [{ scope: "email:send" }, { scope: "repo:read" }] },
        }],
      },
    }).audit_report;

    expect(report.scope_diff.map(({ normalized }: { normalized: unknown }) => normalized)).toEqual([
      { verb: "send", resource: "email", conditions: null },
      { verb: "write", resource: "repo", conditions: null },
      { verb: "spend", resource: "payment", conditions: null },
    ]);
    expect(report.narrowed_scopes).toEqual([{ from: "repo:write", to: "repo:read" }]);
  });
});
