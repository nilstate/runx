import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createFileRegistryStore, ingestSkillMarkdown } from "../../registry/src/index.js";
import {
  connectPreprovision,
  createRunxSdk,
  createStructuredCaller,
  inspect,
  type ConnectService,
} from "./index.js";

describe("TypeScript SDK", () => {
  it("runs a fixture skill and inspects its receipt through runner-local", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sdk-js-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      const sdk = createRunxSdk({
        env: { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
        receiptDir,
        caller: createStructuredCaller({ answers: { message: "from-sdk" } }),
      });

      const result = await sdk.runSkill({
        skillPath: "fixtures/skills/echo",
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.execution.stdout).toBe("from-sdk");

      const receipt = await sdk.inspectReceipt({ receiptId: result.receipt.id });
      expect(receipt).toMatchObject({
        id: result.receipt.id,
        kind: "skill_execution",
        status: "success",
      });
      await expect(inspect({ receiptId: result.receipt.id, receiptDir })).resolves.toMatchObject({
        id: result.receipt.id,
      });

      const history = await sdk.history();
      expect(history.map((entry) => entry.id)).toContain(result.receipt.id);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns structured resolution requests without prompting", async () => {
    const caller = createStructuredCaller();
    const sdk = createRunxSdk({
      env: { ...process.env, RUNX_CWD: process.cwd() },
      caller,
    });

    const result = await sdk.runSkill({ skillPath: "fixtures/skills/echo" });

    expect(result.status).toBe("needs_resolution");
    expect(caller.trace.resolutions).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({
          kind: "input",
          questions: [
            expect.objectContaining({
              id: "message",
              type: "string",
            }),
          ],
        }),
      }),
    ]);
  });

  it("wraps registry search/add and connect without exposing a second engine", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sdk-js-registry-"));
    const registryDir = path.join(tempDir, "registry");
    const installDir = path.join(tempDir, "skills");
    const connectCalls: string[] = [];
    const connect: ConnectService = {
      list: async () => ({ grants: [] }),
      preprovision: async (provider, scopes) => {
        connectCalls.push(`${provider}:${scopes.join(",")}`);
        return { status: "created", grant: { provider, scopes } };
      },
      revoke: async (grantId) => ({ status: "revoked", grant: { grant_id: grantId } }),
    };

    try {
      const sdk = createRunxSdk({
        env: { ...process.env, RUNX_CWD: process.cwd() },
        registryStore: createFileRegistryStore(registryDir),
        connect,
      });
      await ingestSkillMarkdown(
        createFileRegistryStore(registryDir),
        await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8"),
        {
          owner: "0state",
          version: "1.0.0",
          createdAt: "2026-04-10T00:00:00.000Z",
        },
      );

      const searchResults = await sdk.searchSkills({ query: "sourcey" });
      expect(searchResults[0]).toMatchObject({
        skill_id: "0state/sourcey",
        source: "runx-registry",
      });

      const install = await sdk.addSkill({ ref: "0state/sourcey@1.0.0", to: installDir });
      expect(install.destination).toBe(path.join(installDir, "0state", "sourcey", "SKILL.md"));
      expect(install.source).toBe("runx-registry");

      const connectResult = await sdk.connectPreprovision("github", ["repo:read"]);
      expect(connectResult).toMatchObject({ status: "created" });
      await expect(connectPreprovision({ provider: "slack", scopes: ["chat:write"], connect })).resolves.toMatchObject({
        status: "created",
      });
      expect(connectCalls).toEqual(["github:repo:read", "slack:chat:write"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
