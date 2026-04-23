import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineTool, stringInput } from "@runxhq/authoring";

export default defineTool({
  name: "git.diff_name_only",
  description: "List changed file names relative to a git base ref.",
  inputs: {
    repo_root: stringInput({ optional: true, description: "Repository root to inspect. Defaults to RUNX_CWD or the current working directory." }),
    base: stringInput({ default: "HEAD", description: "Base git ref to diff against." }),
  },
  output: {
    packet: "runx.git.diff.v1",
    wrap_as: "git_diff",
  },
  scopes: ["git.read"],
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
