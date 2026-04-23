import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineTool, stringInput } from "../../_lib/harness.mjs";

const tool = defineTool({
  inputs: {
    repo_root: stringInput({ optional: true }),
  },
  run({ inputs, env }) {
    const repoRoot = path.resolve(inputs.repo_root || env.RUNX_CWD || process.cwd());
    const branch = spawnSync("git", ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"], {
      encoding: "utf8",
      shell: false,
    });
    let value = branch.stdout.trim();
    let detached = false;

    if (branch.error) {
      throw branch.error;
    }
    if (branch.status !== 0 || !value) {
      const fallback = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        shell: false,
      });
      if (fallback.error) {
        throw fallback.error;
      }
      if (fallback.status !== 0) {
        throw new Error(fallback.stderr || fallback.stdout || "git current branch failed.");
      }
      value = fallback.stdout.trim();
      detached = true;
    }

    return {
      repo_root: repoRoot,
      branch: value,
      detached,
    };
  },
});

await tool.main();
