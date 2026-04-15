import { execFile } from "node:child_process";
import { readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspaceRoot = process.cwd();
const cliPackageRoot = path.join(workspaceRoot, "packages", "cli");
const cliDistEntry = path.join(cliPackageRoot, "dist", "index.js");
const cliBinEntry = path.join(cliPackageRoot, "bin", "runx.js");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

describe("Node CLI package", () => {
  beforeAll(async () => {
    await execFileAsync(pnpm, ["build"], {
      cwd: workspaceRoot,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  }, 130_000);

  it("emits an executable dist CLI entrypoint and launches through the real bin", async () => {
    const entry = await stat(cliDistEntry);
    expect(entry.isFile()).toBe(true);
    expect(entry.mode & 0o111).not.toBe(0);
    await expect(readFile(cliDistEntry, "utf8")).resolves.not.toContain(".build/runtime");

    const { stdout } = await execFileAsync(process.execPath, [cliBinEntry, "config", "list", "--json"], {
      cwd: workspaceRoot,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    expect(JSON.parse(stdout)).toMatchObject({
      status: "success",
      config: {
        action: "list",
      },
    });
  });

  it("falls back to the source entry when dist is absent in a linked workspace", async () => {
    const parkedDist = `${cliDistEntry}.bak`;
    await rename(cliDistEntry, parkedDist);
    try {
      const { stdout } = await execFileAsync(process.execPath, [cliBinEntry, "config", "list", "--json"], {
        cwd: workspaceRoot,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });

      expect(JSON.parse(stdout)).toMatchObject({
        status: "success",
        config: {
          action: "list",
        },
      });
    } finally {
      await rename(parkedDist, cliDistEntry);
    }
  });

  it("packs @runxai/cli with the emitted dist files", async () => {
    const { stdout } = await execFileAsync(npm, ["pack", "--dry-run", "--json"], {
      cwd: cliPackageRoot,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const [pack] = JSON.parse(stdout) as [
      {
        readonly name: string;
        readonly version: string;
        readonly files: readonly { readonly path: string }[];
      },
    ];

    expect(pack.name).toBe("@runxai/cli");
    expect(pack.version).not.toBe("0.0.0");
    const files = pack.files.map((file) => file.path);
    expect(files).toContain("bin/runx.js");
    expect(files).toContain("dist/index.js");
    expect(files).toContain("dist/index.d.ts");
    expect(files).toContain("dist/packages/cli/src/index.js");
    expect(files).toContain("dist/packages/cli/src/official-skills.lock.json");
    expect(files).toContain("dist/packages/runner-local/src/index.js");
    expect(files).toContain("skills/scafld/run.mjs");
    expect(files).toContain("tools/sourcey/build/tool.yaml");
    expect(files).toContain("tools/sourcey/build/run.mjs");
    expect(files).toContain("tools/sourcey/verify/tool.yaml");
    expect(files).not.toContain("skills/evolve/SKILL.md");
    expect(files).not.toContain("skills/evolve/x.yaml");
    expect(files).not.toContain("skills/sourcey/SKILL.md");
    expect(files).not.toContain("skills/sourcey/x.yaml");
  }, 60_000);
});
