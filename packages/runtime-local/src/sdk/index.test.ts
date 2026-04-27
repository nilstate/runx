import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultSkillAdapters } from "@runxhq/adapters";

import { createFileRegistryStore, ingestSkillMarkdown } from "@runxhq/core/registry";
import { hashString } from "@runxhq/core/receipts";
import {
  connectPreprovision,
  createRunxHostBridge,
  createRunxSdk,
  createStructuredCaller,
  createTrustedHostOutcome,
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
        adapters: createDefaultSkillAdapters(),
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
      adapters: createDefaultSkillAdapters(),
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

  it("exposes run, inspect, and resume through the shared host bridge", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sdk-host-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      const bridge = createRunxHostBridge({
        env: { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
        receiptDir,
        adapters: createDefaultSkillAdapters(),
      });

      const paused = await bridge.run({
        skillPath: "fixtures/skills/echo",
      });
      expect(paused.status).toBe("paused");
      if (paused.status !== "paused") {
        return;
      }
      expect(paused).toMatchObject({
        skillName: "echo",
        requests: [
          {
            kind: "input",
          },
        ],
      });
      expect(paused.requests[0]?.id).toBeTruthy();
      expect(Array.isArray(paused.events)).toBe(true);

      const inspectedPaused = await bridge.inspect(paused.runId, { receiptDir });
      expect(inspectedPaused).toMatchObject({
        status: "paused",
        runId: paused.runId,
        skillName: "echo",
      });
      if (inspectedPaused.status !== "paused") {
        return;
      }
      expect(inspectedPaused.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: paused.requests[0]?.id,
            kind: "input",
          }),
        ]),
      );

      const completed = await bridge.resume(paused.runId, {
        receiptDir,
        resolver: ({ request }) => (
          request.kind === "input"
            ? { message: "from-sdk-host" }
            : undefined
        ),
      });
      expect(completed).toMatchObject({
        status: "completed",
        skillName: "echo",
        output: "from-sdk-host",
      });
      if (completed.status !== "completed") {
        return;
      }
      expect(Array.isArray(completed.events)).toBe(true);

      await expect(bridge.inspect(completed.receiptId, { receiptDir })).resolves.toMatchObject({
        status: "completed",
        receiptId: completed.receiptId,
        kind: "skill_execution",
        skillName: "echo",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects trusted first-party host outcomes without exposing a second public protocol", () => {
    const paused = createTrustedHostOutcome(
      {
        status: "paused",
        skillName: "echo",
        runId: "rx_paused",
        requests: [{ id: "req_1", kind: "input", questions: [] }],
        events: [],
      },
      {
        status: "needs_resolution",
        skill: { name: "echo" },
        skillPath: "fixtures/skills/echo/SKILL.md",
        inputs: {},
        runId: "rx_paused",
        requests: [{ id: "req_1", kind: "input", questions: [] }],
      } as any,
    );
    expect(paused).toMatchObject({
      kernelStatus: "needs_resolution",
      kernelRunId: "rx_paused",
      ledgerRunId: "rx_paused",
      requests: [
        {
          id: "req_1",
          kind: "input",
        },
      ],
    });

    const completed = createTrustedHostOutcome(
      {
        status: "completed",
        skillName: "echo",
        receiptId: "rx_done",
        output: "ok",
        events: [],
      },
      {
        status: "success",
        skill: { name: "echo" },
        inputs: {},
        execution: { stdout: "ok" },
        state: {},
        receipt: { id: "rx_done", kind: "skill_execution", status: "success" },
      } as any,
    );
    expect(completed).toMatchObject({
      kernelStatus: "success",
      ledgerRunId: "rx_done",
      receiptId: "rx_done",
      receiptKind: "skill_execution",
      stdout: "ok",
    });

    const denied = createTrustedHostOutcome(
      {
        status: "denied",
        skillName: "guarded",
        reasons: ["approval required"],
        events: [],
      },
      {
        status: "policy_denied",
        skill: { name: "guarded" },
        reasons: ["approval required"],
      } as any,
    );
    expect(denied).toMatchObject({
      kernelStatus: "policy_denied",
      denialReasons: ["approval required"],
    });

    expect(() =>
      createTrustedHostOutcome(
        {
          status: "completed",
          skillName: "echo",
          receiptId: "rx_wrong",
          output: "",
          events: [],
        },
        {
          status: "failure",
          skill: { name: "echo" },
          inputs: {},
          execution: { stdout: "", errorMessage: "nope" },
          state: {},
          receipt: { id: "rx_wrong", kind: "skill_execution", status: "failure" },
        } as any,
      ),
    ).toThrow(/did not match kernel status/);
  });

  it("can inspect imported tools and local manifest-backed tools", async () => {
    const sdk = createRunxSdk({
      env: {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_ENABLE_FIXTURE_TOOL_CATALOG: "1",
      },
    });

    const imported = await sdk.inspectTool({
      ref: "fixture.echo",
      source: "fixture-mcp",
    });
    expect(imported).toMatchObject({
      name: "fixture.echo",
      execution_source_type: "catalog",
      provenance: {
        origin: "imported",
        source: "fixture-mcp",
        source_type: "mcp",
        catalog_ref: "fixture-mcp:fixture.echo",
      },
    });

    const local = await sdk.inspectTool({ ref: "fs.read" });
    expect(local).toMatchObject({
      name: "fs.read",
      execution_source_type: "cli-tool",
      provenance: {
        origin: "local",
      },
      scopes: ["fs.read"],
      inputs: {
        path: {
          type: "string",
          required: true,
        },
      },
    });
  });

  it("wraps registry search/add and connect without exposing a second engine", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sdk-js-registry-"));
    const registryDir = path.join(tempDir, "registry");
    const installDir = path.join(tempDir, "skills");
    const connectCalls: string[] = [];
    const connect: ConnectService = {
      list: async () => ({ grants: [] }),
      preprovision: async (request) => {
        connectCalls.push(`${request.provider}:${request.scopes.join(",")}`);
        return { status: "created", grant: { provider: request.provider, scopes: request.scopes } };
      },
      revoke: async (grantId) => ({ status: "revoked", grant: { grant_id: grantId } }),
    };

    try {
      const sdk = createRunxSdk({
        env: { ...process.env, RUNX_CWD: process.cwd() },
        registryStore: createFileRegistryStore(registryDir),
        connect,
        adapters: createDefaultSkillAdapters(),
      });
      await ingestSkillMarkdown(
        createFileRegistryStore(registryDir),
        await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8"),
        {
          owner: "acme",
          version: "1.0.0",
          createdAt: "2026-04-10T00:00:00.000Z",
        },
      );

      const searchResults = await sdk.searchSkills({ query: "sourcey" });
      expect(searchResults[0]).toMatchObject({
        skill_id: "acme/sourcey",
        source: "runx-registry",
      });

      const install = await sdk.addSkill({ ref: "acme/sourcey@1.0.0", to: installDir });
      expect(install.destination).toBe(path.join(installDir, "acme", "sourcey", "SKILL.md"));
      expect(install.source).toBe("runx-registry");

      const connectResult = await sdk.connectPreprovision({ provider: "github", scopes: ["repo:read"] });
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
        adapters: createDefaultSkillAdapters(),
      });

      const published = await sdk.publishSkill({
        skillPath: "skills/sourcey",
        owner: "acme",
        version: "1.0.0",
      });

      expect(published).toMatchObject({
        status: "published",
        skill_id: "acme/sourcey",
        harness: {
          status: "passed",
          case_count: 2,
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
                trust_tier: "first_party",
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
            trust_tier: "first_party",
            publisher: {
              id: "runx",
              kind: "organization",
              handle: "runx",
            },
            attestations: [
              {
                kind: "publisher",
                id: "publisher:runx",
                status: "verified",
                summary: "runx",
              },
            ],
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

  it("supports remote imported tools through the hosted public API", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sdk-js-remote-tools-"));

    try {
      globalThis.fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url === "https://runx.example.test/v1/tools?q=echo&limit=20") {
          return new Response(JSON.stringify({
            status: "success",
            query: { q: "echo", source: "all", limit: 20 },
            total: 1,
            tools: [
              {
                tool_id: "fixture-mcp/fixture.echo",
                name: "fixture.echo",
                summary: "Echo a message through the fixture MCP server.",
                source: "fixture-mcp",
                source_label: "Fixture MCP Catalog",
                source_type: "mcp",
                namespace: "fixture",
                external_name: "echo",
                required_scopes: ["fixture.echo"],
                tags: ["fixture", "mcp"],
                catalog_ref: "fixture-mcp:fixture.echo",
              },
            ],
          }), { status: 200 });
        }
        expect(url).toBe("https://runx.example.test/v1/tools/fixture.echo");
        return new Response(JSON.stringify({
          status: "success",
          tool: {
            ref: "fixture.echo",
            name: "fixture.echo",
            description: "Echo a message through the fixture MCP server.",
            execution_source_type: "catalog",
            inputs: {
              message: {
                type: "string",
                required: true,
                description: "Message to echo.",
              },
            },
            scopes: ["fixture.echo"],
            reference_path: "catalog:fixture-mcp:fixture.echo",
            skill_directory: "/srv/runx/catalogs/fixture-mcp",
            provenance: {
              origin: "imported",
              source: "fixture-mcp",
              source_label: "Fixture MCP Catalog",
              source_type: "mcp",
              namespace: "fixture",
              external_name: "echo",
              catalog_ref: "fixture-mcp:fixture.echo",
              tool_id: "fixture-mcp/fixture.echo",
              tags: ["fixture", "mcp"],
            },
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

      const searchResults = await sdk.searchTools({ query: "echo" });
      expect(searchResults).toMatchObject([
        {
          name: "fixture.echo",
          source: "fixture-mcp",
          source_type: "mcp",
        },
      ]);

      const detail = await sdk.inspectTool({ ref: "fixture.echo" });
      expect(detail).toMatchObject({
        name: "fixture.echo",
        execution_source_type: "catalog",
        provenance: {
          origin: "imported",
          source: "fixture-mcp",
          source_type: "mcp",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
