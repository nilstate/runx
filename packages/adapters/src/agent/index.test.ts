import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDefaultSkillAdapters } from "../index.js";
import { formatManagedAgentLabel, loadManagedAgentConfig } from "./index.js";

describe("managed agent adapters", () => {
  it("loads OpenAI managed agent config from explicit env and prepends native adapters", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-managed-agent-openai-"));

    try {
      const env = {
        ...process.env,
        RUNX_HOME: tempDir,
        RUNX_AGENT_PROVIDER: "openai",
        RUNX_AGENT_MODEL: "gpt-test",
        RUNX_AGENT_API_KEY: "sk-test-secret",
      };

      await expect(loadManagedAgentConfig(env)).resolves.toEqual({
        provider: "openai",
        model: "gpt-test",
        apiKey: "sk-test-secret",
      });
      await expect(resolveDefaultSkillAdapters(env)).resolves.toSatisfy((adapters: readonly { type: string }[]) =>
        adapters.map((adapter) => adapter.type).join(",") === "agent,agent-step,cli-tool,mcp,a2a");
      expect(formatManagedAgentLabel({
        provider: "openai",
        model: "gpt-test",
        apiKey: "sk-test-secret",
      })).toBe("OpenAI gpt-test");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads Anthropic managed agent config from the provider-specific env var", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-managed-agent-anthropic-"));

    try {
      const env = {
        ...process.env,
        RUNX_HOME: tempDir,
        RUNX_AGENT_PROVIDER: "anthropic",
        RUNX_AGENT_MODEL: "claude-test",
        ANTHROPIC_API_KEY: "anthropic-secret",
      };

      await expect(loadManagedAgentConfig(env)).resolves.toEqual({
        provider: "anthropic",
        model: "claude-test",
        apiKey: "anthropic-secret",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
