import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileRegistryStore,
  HttpCachedRegistryStore,
  ingestSkillMarkdown,
} from "@runxhq/core/registry";
import { runLocalGraph, type Caller } from "@runxhq/core/runner-local";
import {
  isRegistryRef,
  parseRegistryRef,
} from "@runxhq/core/runner-local";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

const ECHO_MARKDOWN = `---
name: echo
description: Minimal echo skill for registry-resolution fixtures.
---

Echo a message.
`;

const ECHO_PROFILE = `skill: echo
runners:
  echo:
    default: true
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write(process.env.RUNX_INPUT_MESSAGE || '')"
    inputs:
      message:
        type: string
        required: true
`;

describe("chain registry refs", () => {
  describe("isRegistryRef", () => {
    it("accepts owner/name and owner/name@version", () => {
      expect(isRegistryRef("runx/echo")).toBe(true);
      expect(isRegistryRef("runx/echo@0.1.0")).toBe(true);
      expect(isRegistryRef("aster/skill-lab@2025-04-20")).toBe(true);
    });

    it("rejects filesystem paths", () => {
      expect(isRegistryRef("./scafld")).toBe(false);
      expect(isRegistryRef("../scafld")).toBe(false);
      expect(isRegistryRef("../../skills/echo")).toBe(false);
      expect(isRegistryRef("/abs/skills/echo")).toBe(false);
    });

    it("rejects bare names without an owner", () => {
      expect(isRegistryRef("echo")).toBe(false);
      expect(isRegistryRef("")).toBe(false);
    });
  });

  describe("parseRegistryRef", () => {
    it("splits owner and name", () => {
      expect(parseRegistryRef("runx/echo")).toEqual({
        kind: "registry",
        skillId: "runx/echo",
        owner: "runx",
        name: "echo",
        version: undefined,
        raw: "runx/echo",
      });
    });

    it("captures the version when present", () => {
      expect(parseRegistryRef("runx/echo@1.2.3")).toEqual({
        kind: "registry",
        skillId: "runx/echo",
        owner: "runx",
        name: "echo",
        version: "1.2.3",
        raw: "runx/echo@1.2.3",
      });
    });

    it("throws on bad input", () => {
      expect(() => parseRegistryRef("./local/path")).toThrow();
      expect(() => parseRegistryRef("not-a-ref")).toThrow();
    });
  });

  it("resolves a graph step skill via the registry store", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-registry-"));

    try {
      const store = createFileRegistryStore(path.join(tempDir, "registry"));
      await ingestSkillMarkdown(store, ECHO_MARKDOWN, {
        owner: "testorg",
        version: "0.1.0",
        createdAt: "2026-04-20T00:00:00.000Z",
        profileDocument: ECHO_PROFILE,
      });

      const graphPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        graphPath,
        `name: chain-registry-ref
steps:
  - id: echo
    skill: testorg/echo
    inputs:
      message: hello from registry
`,
      );

      const result = await runLocalGraph({
        graphPath,
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        registryStore: store,
        skillCacheDir: path.join(tempDir, "skill-cache"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0]).toMatchObject({
        skill: "testorg/echo",
        stdout: "hello from registry",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves a pinned version from the registry", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-registry-pin-"));

    try {
      const store = createFileRegistryStore(path.join(tempDir, "registry"));
      await ingestSkillMarkdown(store, ECHO_MARKDOWN, {
        owner: "testorg",
        version: "0.1.0",
        createdAt: "2026-04-20T00:00:00.000Z",
        profileDocument: ECHO_PROFILE,
      });
      await ingestSkillMarkdown(store, ECHO_MARKDOWN, {
        owner: "testorg",
        version: "0.2.0",
        createdAt: "2026-04-21T00:00:00.000Z",
        profileDocument: ECHO_PROFILE,
      });

      const graphPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        graphPath,
        `name: chain-registry-pinned
steps:
  - id: echo
    skill: testorg/echo@0.1.0
    inputs:
      message: pinned version
`,
      );

      const result = await runLocalGraph({
        graphPath,
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        registryStore: store,
        skillCacheDir: path.join(tempDir, "skill-cache"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0]?.stdout).toBe("pinned version");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with a clear message when no registry store is configured", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-registry-missing-"));

    try {
      const graphPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        graphPath,
        `name: chain-registry-missing-store
steps:
  - id: echo
    skill: testorg/echo
    inputs:
      message: should fail
`,
      );

      await expect(
        runLocalGraph({
          graphPath,
          caller,
          receiptDir: path.join(tempDir, "receipts"),
          runxHome: path.join(tempDir, "home"),
          env: process.env,
        }),
      ).rejects.toThrow(/Registry ref 'testorg\/echo' used in graph step/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with a clear message when the skill is not in the registry", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-registry-notfound-"));

    try {
      const store = createFileRegistryStore(path.join(tempDir, "registry"));
      const graphPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        graphPath,
        `name: chain-registry-missing-skill
steps:
  - id: echo
    skill: testorg/missing
    inputs:
      message: should fail
`,
      );

      await expect(
        runLocalGraph({
          graphPath,
          caller,
          receiptDir: path.join(tempDir, "receipts"),
          runxHome: path.join(tempDir, "home"),
          env: process.env,
          registryStore: store,
          skillCacheDir: path.join(tempDir, "skill-cache"),
        }),
      ).rejects.toThrow(/Registry skill 'testorg\/missing' not found in registry/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with available versions when a pinned version is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-registry-badpin-"));

    try {
      const store = createFileRegistryStore(path.join(tempDir, "registry"));
      await ingestSkillMarkdown(store, ECHO_MARKDOWN, {
        owner: "testorg",
        version: "0.1.0",
        createdAt: "2026-04-20T00:00:00.000Z",
        profileDocument: ECHO_PROFILE,
      });

      const graphPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        graphPath,
        `name: chain-registry-missing-pin
steps:
  - id: echo
    skill: testorg/echo@9.9.9
    inputs:
      message: should fail
`,
      );

      await expect(
        runLocalGraph({
          graphPath,
          caller,
          receiptDir: path.join(tempDir, "receipts"),
          runxHome: path.join(tempDir, "home"),
          env: process.env,
          registryStore: store,
          skillCacheDir: path.join(tempDir, "skill-cache"),
        }),
      ).rejects.toThrow(/Registry skill 'testorg\/echo@9\.9\.9' not found \(available: 0\.1\.0\)\./);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fetches a graph step skill from a remote registry via HttpCachedRegistryStore", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-registry-http-"));

    try {
      let fetches = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        fetches += 1;
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!url.includes("/v1/skills/testorg/echo/acquire") || init?.method !== "POST") {
          return new Response("bad request", { status: 400 });
        }
        return new Response(
          JSON.stringify({
            status: "success",
            install_count: 1,
            acquisition: {
              skill_id: "testorg/echo",
              owner: "testorg",
              name: "echo",
              version: "0.1.0",
              digest: "a".repeat(64),
              markdown: ECHO_MARKDOWN,
              profile_document: ECHO_PROFILE,
              profile_digest: "b".repeat(64),
              runner_names: ["echo"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const cache = createFileRegistryStore(path.join(tempDir, "cache"));
      const store = new HttpCachedRegistryStore({
        remoteBaseUrl: "https:/@runxhq/core/registry.example",
        installationId: "inst_test",
        cache,
        fetchImpl,
      });

      const graphPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        graphPath,
        `name: chain-registry-http
steps:
  - id: echo
    skill: testorg/echo
    inputs:
      message: hello from http
`,
      );

      const result = await runLocalGraph({
        graphPath,
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        registryStore: store,
        skillCacheDir: path.join(tempDir, "skill-cache"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0]?.stdout).toBe("hello from http");
      expect(fetches).toBe(1);

      const second = await runLocalGraph({
        graphPath,
        caller,
        receiptDir: path.join(tempDir, "receipts-2"),
        runxHome: path.join(tempDir, "home-2"),
        env: process.env,
        registryStore: store,
        skillCacheDir: path.join(tempDir, "skill-cache"),
      });
      expect(second.status).toBe("success");
      expect(fetches).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("still accepts filesystem-relative skill refs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-registry-compat-"));

    try {
      const skillDir = path.join(tempDir, "skills", "echo");
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), ECHO_MARKDOWN);
      await writeFile(path.join(skillDir, "X.yaml"), ECHO_PROFILE);

      const graphPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        graphPath,
        `name: chain-registry-fs-compat
steps:
  - id: echo
    skill: ./skills/echo
    inputs:
      message: filesystem still works
`,
      );

      const result = await runLocalGraph({
        graphPath,
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0]?.stdout).toBe("filesystem still works");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
