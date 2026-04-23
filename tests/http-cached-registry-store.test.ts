import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileRegistryStore,
  HttpCachedRegistryStore,
} from "@runxhq/core/registry";

const ECHO_MARKDOWN = `---
name: echo
description: Echo skill for HTTP cached store tests.
---

Echo a message.
`;

const ECHO_PROFILE = `skill: echo
runners:
  echo:
    default: true
    type: cli-tool
    command: node
`;

function buildAcquirePayload(overrides: {
  readonly skillId?: string;
  readonly owner?: string;
  readonly name?: string;
  readonly version?: string;
  readonly digest?: string;
} = {}) {
  return {
    status: "success",
    install_count: 1,
    acquisition: {
      skill_id: overrides.skillId ?? "acme/echo",
      owner: overrides.owner ?? "acme",
      name: overrides.name ?? "echo",
      version: overrides.version ?? "0.1.0",
      digest: overrides.digest ?? "a".repeat(64),
      markdown: ECHO_MARKDOWN,
      profile_document: ECHO_PROFILE,
      profile_digest: "b".repeat(64),
      runner_names: ["echo"],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpCachedRegistryStore", () => {
  it("fetches a missing skill over HTTP and caches it locally", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-http-cache-"));
    try {
      const cache = createFileRegistryStore(path.join(tempDir, "cache"));
      let fetches = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        fetches += 1;
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        expect(url).toContain("/v1/skills/acme/echo/acquire");
        expect(init?.method).toBe("POST");
        return jsonResponse(buildAcquirePayload());
      };
      const store = new HttpCachedRegistryStore({
        remoteBaseUrl: "https:/@runxhq/core/registry.example",
        installationId: "inst_test",
        cache,
        fetchImpl,
      });

      const first = await store.getVersion("acme/echo");
      expect(first?.skill_id).toBe("acme/echo");
      expect(first?.markdown).toBe(ECHO_MARKDOWN);
      expect(first?.profile_document).toBe(ECHO_PROFILE);
      expect(fetches).toBe(1);

      const second = await store.getVersion("acme/echo");
      expect(second?.skill_id).toBe("acme/echo");
      expect(fetches).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the registry responds with 404", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-http-cache-404-"));
    try {
      const cache = createFileRegistryStore(path.join(tempDir, "cache"));
      const fetchImpl: typeof fetch = async () => new Response("not found", { status: 404 });
      const store = new HttpCachedRegistryStore({
        remoteBaseUrl: "https:/@runxhq/core/registry.example",
        installationId: "inst_test",
        cache,
        fetchImpl,
      });

      const result = await store.getVersion("acme/missing");
      expect(result).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forwards pinned versions to the acquire endpoint", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-http-cache-pin-"));
    try {
      const cache = createFileRegistryStore(path.join(tempDir, "cache"));
      let seenVersion: unknown;
      const fetchImpl: typeof fetch = async (_input, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        seenVersion = body.version;
        return jsonResponse(buildAcquirePayload({ version: "1.2.3" }));
      };
      const store = new HttpCachedRegistryStore({
        remoteBaseUrl: "https:/@runxhq/core/registry.example",
        installationId: "inst_test",
        cache,
        fetchImpl,
      });

      const result = await store.getVersion("acme/echo", "1.2.3");
      expect(seenVersion).toBe("1.2.3");
      expect(result?.version).toBe("1.2.3");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists HTTP fetches in the underlying cache store", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-http-cache-persist-"));
    try {
      const cacheRoot = path.join(tempDir, "cache");
      const cache = createFileRegistryStore(cacheRoot);
      let fetches = 0;
      const fetchImpl: typeof fetch = async () => {
        fetches += 1;
        return jsonResponse(buildAcquirePayload());
      };
      const store = new HttpCachedRegistryStore({
        remoteBaseUrl: "https:/@runxhq/core/registry.example",
        installationId: "inst_test",
        cache,
        fetchImpl,
      });

      await store.getVersion("acme/echo");
      expect(fetches).toBe(1);

      const detachedCache = createFileRegistryStore(cacheRoot);
      const persisted = await detachedCache.getVersion("acme/echo");
      expect(persisted?.skill_id).toBe("acme/echo");
      expect(persisted?.markdown).toBe(ECHO_MARKDOWN);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
