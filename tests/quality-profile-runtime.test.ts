import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "@runxhq/core/runner-local";

describe("skill quality profile runtime", () => {
  it("injects Quality Profile into agent envelopes and pins its hash in receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-quality-profile-"));
    const skillDir = path.join(tempDir, "quality-skill");
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: quality-skill
source:
  type: agent-step
  agent: codex
  task: quality-skill
---
# Quality Skill

Produce a bounded artifact.

## Quality Profile

- Purpose: produce a maintainer-grade artifact.
- Evidence bar: connect each claim to concrete evidence.
- Voice bar: no machine-framed prose.

## Outputs

- artifact
`,
      );

      let profileHash: string | undefined;
      const caller: Caller = {
        resolve: async (request) => {
          if (request.kind !== "cognitive_work") {
            return undefined;
          }
          expect(request.work.envelope.quality_profile).toMatchObject({
            source: "SKILL.md#quality-profile",
            content: expect.stringContaining("maintainer-grade artifact"),
          });
          profileHash = request.work.envelope.quality_profile?.sha256;
          expect(profileHash).toMatch(/^[a-f0-9]{64}$/);
          return {
            actor: "agent",
            payload: {
              artifact: "Maintainer-grade artifact grounded in repository evidence.",
            },
          };
        },
        report: () => undefined,
      };

      const result = await runLocalSkill({
        skillPath: skillDir,
        caller,
        receiptDir,
        runxHome,
        env: { ...process.env, RUNX_CWD: tempDir, INIT_CWD: tempDir },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      const receipt = JSON.parse(await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8")) as {
        readonly metadata?: {
          readonly quality_profiles?: Record<string, { readonly source: string; readonly sha256: string }>;
        };
      };
      expect(receipt.metadata?.quality_profiles?.["quality-skill"]).toEqual({
        source: "SKILL.md#quality-profile",
        heading: "Quality Profile",
        sha256: profileHash,
      });
      expect(JSON.stringify(receipt)).not.toContain("maintainer-grade artifact");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
