import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const completedPaymentFollowUpSpecs = [
  {
    taskId: "payment-charge-skills-v1",
    retiredRegistryId: "runx/x402-charge",
    retiredSkillDir: "x402-charge",
    retiredFlowLabel: "`x402 charge flow`",
  },
  {
    taskId: "payment-refund-skills-v1",
    retiredRegistryId: "runx/x402-refund",
    retiredSkillDir: "x402-refund",
    retiredFlowLabel: "`x402 refund flow`",
  },
] as const;

describe("payment charge/refund follow-up specs", () => {
  it("keeps the follow-up specs archived with post x402-pay cutover boundaries", async () => {
    for (const spec of completedPaymentFollowUpSpecs) {
      const archivePath = path.resolve(".scafld", "specs", "archive", "2026-05", `${spec.taskId}.md`);
      const activePath = path.resolve(".scafld", "specs", "active", `${spec.taskId}.md`);
      const draftPath = path.resolve(".scafld", "specs", "drafts", `${spec.taskId}.md`);

      expect(existsSync(archivePath), `${spec.taskId} archived spec`).toBe(true);
      expect(existsSync(activePath), `${spec.taskId} active spec`).toBe(false);
      expect(existsSync(draftPath), `${spec.taskId} draft spec`).toBe(false);

      const markdown = await readFile(archivePath, "utf8");
      const contractBody = markdown.split("\n## Harden Rounds\n")[0] ?? markdown;

      expect(markdown, `${spec.taskId} frontmatter status`).toMatch(/\nstatus: completed\n/);
      expect(markdown, `${spec.taskId} current-state status`).toMatch(/\nStatus: completed\n/);
      expect(contractBody, `${spec.taskId} Rust/TS boundary`).toContain("## Rust/TypeScript Cutover Boundary");
      expect(contractBody, `${spec.taskId} canonical x402-pay coverage`).toContain(
        `Catalog coverage preserves \`runx/x402-pay\` and rejects \`${spec.retiredRegistryId}\`.`,
      );
      expect(contractBody, `${spec.taskId} no public x402 flow label`).not.toContain(spec.retiredFlowLabel);
    }
  });

  it("keeps retired x402 charge/refund names out of shipped skill catalogs", async () => {
    const entries = JSON.parse(
      await readFile(path.resolve("skills", "official.lock.json"), "utf8"),
    ) as ReadonlyArray<{ readonly skill_id: string }>;
    const registryIds = new Set(entries.map((entry) => entry.skill_id));

    expect(registryIds.has("runx/x402-pay")).toBe(true);
    for (const spec of completedPaymentFollowUpSpecs) {
      expect(existsSync(path.resolve("skills", spec.retiredSkillDir)), spec.retiredSkillDir).toBe(false);
      expect(registryIds.has(spec.retiredRegistryId), spec.retiredRegistryId).toBe(false);
    }
  });
});
