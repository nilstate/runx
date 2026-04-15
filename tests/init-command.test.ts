import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

describe("runx init", () => {
  it("creates project-local state without creating global state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-init-project-"));
    const projectDir = path.join(tempDir, "project");
    const globalHomeDir = path.join(tempDir, "global-home");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const exitCode = await runCli(
        ["init", "--json"],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: projectDir, RUNX_HOME: globalHomeDir },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      const report = JSON.parse(stdout.contents()) as {
        init: { action: string; created: boolean; project_dir: string; project_id: string };
      };
      expect(report.init).toMatchObject({
        action: "project",
        created: true,
        project_dir: path.join(projectDir, ".runx"),
        project_id: expect.stringMatching(/^proj_/),
      });
      await expect(readFile(path.join(projectDir, ".runx", "project.json"), "utf8")).resolves.toContain("\"project_id\"");
      expect((await stat(path.join(projectDir, ".runx", "skills"))).isDirectory()).toBe(true);
      expect((await stat(path.join(projectDir, ".runx", "tools"))).isDirectory()).toBe(true);
      await expect(stat(path.join(globalHomeDir, "install.json"))).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates stable global state and optional official cache on repeat init -g", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-init-global-"));
    const projectDir = path.join(tempDir, "project");
    const globalHomeDir = path.join(tempDir, "global-home");

    try {
      const first = createMemoryStream();
      const second = createMemoryStream();
      const stderr = createMemoryStream();

      const firstExit = await runCli(
        ["init", "-g", "--prefetch", "official", "--json"],
        { stdin: process.stdin, stdout: first, stderr },
        { ...process.env, RUNX_CWD: projectDir, RUNX_HOME: globalHomeDir },
      );
      expect(firstExit).toBe(0);
      const firstReport = JSON.parse(first.contents()) as {
        init: { action: string; created: boolean; installation_id: string; official_cache_dir: string };
      };
      expect(firstReport.init).toMatchObject({
        action: "global",
        created: true,
        installation_id: expect.stringMatching(/^inst_/),
        official_cache_dir: path.join(globalHomeDir, "official-skills"),
      });

      const secondExit = await runCli(
        ["init", "--global", "--json"],
        { stdin: process.stdin, stdout: second, stderr },
        { ...process.env, RUNX_CWD: projectDir, RUNX_HOME: globalHomeDir },
      );
      expect(secondExit).toBe(0);
      const secondReport = JSON.parse(second.contents()) as {
        init: { action: string; created: boolean; installation_id: string };
      };
      expect(secondReport.init).toMatchObject({
        action: "global",
        created: false,
        installation_id: firstReport.init.installation_id,
      });
      await expect(readFile(path.join(globalHomeDir, "install.json"), "utf8")).resolves.toContain(firstReport.init.installation_id);
      expect((await stat(path.join(globalHomeDir, "official-skills"))).isDirectory()).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createMemoryStream(): NodeJS.WriteStream & { readonly contents: () => string } {
  let output = "";
  return {
    write(chunk: string | Uint8Array) {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    contents() {
      return output;
    },
    isTTY: false,
  } as NodeJS.WriteStream & { readonly contents: () => string };
}
