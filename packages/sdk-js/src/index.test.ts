import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileRegistryStore, ingestSkillMarkdown } from "../../registry/src/index.js";
import { hashString } from "../../receipts/src/index.js";
import {
  connectPreprovision,
  createRunxSdk,
  createStructuredCaller,
  inspect,
  type ConnectService,
} from "./index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

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

  it("runs declared inline harnesses before registry publish", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sdk-js-publish-"));
    const registryDir = path.join(tempDir, "registry");

    try {
      const sdk = createRunxSdk({
        env: { ...process.env, RUNX_CWD: process.cwd() },
        registryStore: createFileRegistryStore(registryDir),
      });

      const published = await sdk.publishSkill({
        skillPath: "skills/sourcey",
        owner: "0state",
        version: "1.0.0",
      });

      expect(published).toMatchObject({
        status: "published",
        skill_id: "0state/sourcey",
        harness: {
          status: "passed",
          case_count: 1,
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports remote registry search/add through the hosted public API", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sdk-js-remote-registry-"));
    const installDir = path.join(tempDir, "skills");
    const markdown = await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8");
    const profileDocument = await readFile(path.resolve("skills/sourcey/X.yaml"), "utf8");

    try {
      globalThis.fetch = vi.fn(async (input, init) => {
        const url = String(input);
        if (url === "https://runx.example.test/v1/skills?q=sourcey&limit=20") {
          return new Response(JSON.stringify({
            status: "success",
            skills: [
              {
                skill_id: "runx/sourcey",
                owner: "runx",
                name: "sourcey",
                version: "1.0.0",
                source_type: "agent",
                profile_mode: "profiled",
                runner_names: ["agent", "sourcey"],
                required_scopes: [],
                tags: [],
                trust_signals: [],
                install_command: "runx add runx/sourcey@1.0.0 --registry https://runx.example.test",
                run_command: "runx sourcey",
              },
            ],
          }), { status: 200 });
        }
        expect(url).toBe("https://runx.example.test/v1/skills/runx/sourcey/acquire");
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({
          status: "success",
          install_count: 1,
          acquisition: {
            skill_id: "runx/sourcey",
            owner: "runx",
            name: "sourcey",
            version: "1.0.0",
            digest: hashString(markdown),
            markdown,
            profile_document: profileDocument,
            profile_digest: hashString(profileDocument),
            runner_names: ["agent", "sourcey"],
          },
        }), { status: 200 });
      }) as typeof fetch;

      const sdk = createRunxSdk({
        env: {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: path.join(tempDir, "home"),
          RUNX_REGISTRY_URL: "https://runx.example.test",
        },
      });

      const searchResults = await sdk.searchSkills({ query: "sourcey" });
      expect(searchResults).toMatchObject([
        {
          skill_id: "runx/sourcey",
          source: "runx-registry",
        },
      ]);

      const install = await sdk.addSkill({ ref: "runx/sourcey@1.0.0", to: installDir });
      expect(install).toMatchObject({
        destination: path.join(installDir, "runx", "sourcey", "SKILL.md"),
        skill_id: "runx/sourcey",
        version: "1.0.0",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
