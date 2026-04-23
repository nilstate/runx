import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineTool, stringInput } from "../../_lib/harness.mjs";

const tool = defineTool({
  inputs: {
    repo_root: stringInput({ optional: true }),
    base: stringInput({ default: "HEAD" }),
  },
  run({ inputs, env }) {
    const repoRoot = path.resolve(inputs.repo_root || env.RUNX_CWD || process.cwd());
    const result = spawnSync("git", ["-C", repoRoot, "diff", "--name-only", "--relative", inputs.base], {
      encoding: "utf8",
      shell: false,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "git diff --name-only failed.");
    }

    return {
      repo_root: repoRoot,
      base: inputs.base,
      files: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    };
  },
});

await tool.main();
