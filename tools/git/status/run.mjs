import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineTool, stringInput } from "../../_lib/harness.mjs";

const tool = defineTool({
  inputs: {
    repo_root: stringInput({ optional: true }),
  },
  run({ inputs, env }) {
    const repoRoot = path.resolve(inputs.repo_root || env.RUNX_CWD || process.cwd());
    const result = spawnSync("git", ["-C", repoRoot, "status", "--short", "--branch"], {
      encoding: "utf8",
      shell: false,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "git status failed.");
    }

    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const branch = lines[0]?.startsWith("## ") ? lines[0].slice(3) : undefined;
    const entries = branch ? lines.slice(1) : lines;

    return {
      repo_root: repoRoot,
      branch,
      clean: entries.length === 0,
      entries,
    };
  },
});

await tool.main();
