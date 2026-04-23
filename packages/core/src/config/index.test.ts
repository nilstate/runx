import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadLocalAgentApiKey,
  resolveRunxGlobalHomeDir,
  resolveRunxKnowledgeDir,
  updateRunxConfigValue,
} from "./index.js";

describe("config package", () => {
  it("round-trips encrypted local agent API keys", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-config-roundtrip-"));

    try {
      const updated = await updateRunxConfigValue({}, "agent.api_key", "sk-test-secret", tempDir);
      const ref = updated.agent?.api_key_ref;

      expect(ref).toMatch(/^local_agent_key_/);
      await expect(loadLocalAgentApiKey(tempDir, ref ?? "")).resolves.toBe("sk-test-secret");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws a specific error when the stored key payload is corrupt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-config-corrupt-"));
    const keysDir = path.join(tempDir, "keys");
    const ref = "local_agent_key_corrupt";

    try {
      await mkdir(keysDir, { recursive: true });
      await writeFile(path.join(keysDir, "local-config-secret"), "test-secret", { mode: 0o600 });
      await writeFile(path.join(keysDir, `${ref}.json`), "{not-json", { mode: 0o600 });
      await expect(loadLocalAgentApiKey(tempDir, ref)).rejects.toThrow(
        new RegExp(`runx local agent key corrupted or unreadable at .*${ref}\\.json`),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("anchors configured knowledge paths to the selected workspace base instead of an unrelated existing directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-config-knowledge-path-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const runDir = path.join(tempDir, "run");
    const cwd = path.join(workspaceDir, "packages", "demo");

    try {
      await mkdir(path.join(workspaceDir, "knowledge"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(workspaceDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

      expect(
        resolveRunxKnowledgeDir(
          {
            ...process.env,
            RUNX_CWD: runDir,
            INIT_CWD: runDir,
            RUNX_KNOWLEDGE_DIR: "knowledge",
          },
          { cwd },
        ),
      ).toBe(path.join(runDir, "knowledge"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("anchors configured home paths to the selected workspace base instead of an unrelated existing directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-config-home-path-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const runDir = path.join(tempDir, "run");
    const cwd = path.join(workspaceDir, "packages", "demo");

    try {
      await mkdir(path.join(workspaceDir, "home"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(workspaceDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

      expect(
        resolveRunxGlobalHomeDir(
          {
            ...process.env,
            RUNX_CWD: runDir,
            INIT_CWD: runDir,
            RUNX_HOME: "home",
          },
          { cwd },
        ),
      ).toBe(path.join(runDir, "home"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
