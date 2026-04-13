import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createIdeActionCore, createFixtureConnectService } from "../plugins/ide-core/src/index.js";
import { registerRunxCommands } from "../plugins/antigravity/src/extension.js";
import { createFileRegistryStore, ingestSkillMarkdown } from "../packages/registry/src/index.js";

describe("ide plugin actions", () => {
  it("runs skills and surfaces input-resolution requests as structured output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-ide-actions-"));
    try {
      const core = createIdeActionCore({
        env: { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
        receiptDir: path.join(tempDir, "receipts"),
      });

      const missing = await core.runSkill({ skillPath: "fixtures/skills/echo" });
      expect(missing.status).toBe("needs_resolution");
      expect(missing.data).toMatchObject({
        status: "needs_resolution",
        requests: [
          {
            kind: "input",
            questions: [
              expect.objectContaining({
                id: "message",
                type: "string",
              }),
            ],
          },
        ],
      });

      const success = await core.runSkill({ skillPath: "fixtures/skills/echo", inputs: { message: "from-ide" } });
      expect(success.status).toBe("success");
      expect(JSON.stringify(success.data)).toContain("from-ide");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("wraps receipt inspection, registry, connect, harness, and Antigravity command registration", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-ide-actions-registry-"));
    try {
      const registryStore = createFileRegistryStore(path.join(tempDir, "registry"));
      await ingestSkillMarkdown(registryStore, await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8"), {
        owner: "0state",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
      });
      const core = createIdeActionCore({
        env: { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
        receiptDir: path.join(tempDir, "receipts"),
        registryStore,
        connect: createFixtureConnectService(),
      });

      const skillRun = await core.runSkill({ skillPath: "fixtures/skills/echo", inputs: { message: "from-ide" } });
      expect(skillRun.status).toBe("success");
      const receiptId = receiptIdFrom(skillRun.data);
      expect(receiptId).toBeDefined();

      const inspect = await core.inspectReceipt(receiptId ?? "");
      expect(inspect.status).toBe("success");
      const history = await core.history();
      expect(JSON.stringify(history.data)).toContain(receiptId ?? "");

      const search = await core.searchSkills({ query: "sourcey" });
      expect(JSON.stringify(search.data)).toContain("0state/sourcey");
      const add = await core.addSkill({ ref: "0state/sourcey@1.0.0", to: path.join(tempDir, "installed") });
      expect(add.status).toBe("success");

      await expect(core.connectList()).resolves.toMatchObject({ status: "success" });
      await expect(core.connectPreprovision("github", ["repo:read"])).resolves.toMatchObject({ status: "success" });
      await expect(core.connectRevoke("grant_1")).resolves.toMatchObject({ status: "success" });

      const harness = await core.harnessRun("fixtures/harness/echo-skill.yaml");
      expect(harness.status).toBe("success");
      expect(harness.data?.assertionErrors).toEqual([]);

      const registered: string[] = [];
      const disposables = registerRunxCommands(
        {
          registerCommand: (command) => {
            registered.push(command);
            return {};
          },
        },
        core,
      );
      expect(disposables.length).toBeGreaterThan(5);
      expect(registered).toContain("runx.skill.run");
      expect(registered).toContain("runx.harness.run");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function receiptIdFrom(data: unknown): string | undefined {
  return isRecord(data) && isRecord(data.receipt) && typeof data.receipt.id === "string" ? data.receipt.id : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
