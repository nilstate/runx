import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { createFileRegistryStore } from "../packages/registry/src/index.js";

describe("CLI skill registry execution profile", () => {
  it("publishes, searches, and adds folder package execution profile", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-registry-x-"));
    const registryDir = path.join(tempDir, "registry");
    const skillsDir = path.join(tempDir, "skills");

    try {
      const publishOut = createMemoryStream();
      const publishErr = createMemoryStream();
      await expect(
        runCli(
          ["skill", "publish", "skills/sourcey", "--owner", "0state", "--version", "1.0.0", "--registry", registryDir, "--json"],
          { stdin: process.stdin, stdout: publishOut, stderr: publishErr },
          { ...process.env, RUNX_CWD: process.cwd() },
        ),
      ).resolves.toBe(0);
      expect(publishErr.contents()).toBe("");
      expect(JSON.parse(publishOut.contents()).publish).toMatchObject({
        skill_id: "0state/sourcey",
        runner_names: ["agent", "sourcey"],
        profile_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      const searchOut = createMemoryStream();
      const searchErr = createMemoryStream();
      await expect(
        runCli(
          ["skill", "search", "sourcey", "--json"],
          { stdin: process.stdin, stdout: searchOut, stderr: searchErr },
          { ...process.env, RUNX_CWD: process.cwd(), RUNX_REGISTRY_DIR: registryDir },
        ),
      ).resolves.toBe(0);
      expect(searchErr.contents()).toBe("");
      expect(JSON.parse(searchOut.contents()).results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            skill_id: "0state/sourcey",
            profile_mode: "profiled",
            runner_names: ["agent", "sourcey"],
            profile_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ]),
      );

      const addOut = createMemoryStream();
      const addErr = createMemoryStream();
      await expect(
        runCli(
          ["skill", "add", "0state/sourcey@1.0.0", "--to", skillsDir, "--json"],
          { stdin: process.stdin, stdout: addOut, stderr: addErr },
          { ...process.env, RUNX_CWD: process.cwd(), RUNX_REGISTRY_DIR: registryDir },
        ),
      ).resolves.toBe(0);
      expect(addErr.contents()).toBe("");
      expect(JSON.parse(addOut.contents()).install).toMatchObject({
        destination: path.join(skillsDir, "0state", "sourcey", "SKILL.md"),
        profileStatePath: path.join(skillsDir, "0state", "sourcey", ".runx", "profile.json"),
        runnerNames: ["agent", "sourcey"],
      });
      await expect(readFile(path.join(skillsDir, "0state", "sourcey", ".runx", "profile.json"), "utf8")).resolves.toContain(
        "tool: sourcey.build",
      );
      await expect(createFileRegistryStore(registryDir).getVersion("0state/sourcey", "1.0.0")).resolves.toMatchObject({
        runner_names: ["agent", "sourcey"],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
  } as NodeJS.WriteStream & { contents: () => string };
}
