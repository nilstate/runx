import { spawnSync } from "node:child_process";

import { defineTool, resolveRepoRoot, stringInput } from "@runxhq/authoring";

export default defineTool({
  name: "git.current_branch",
  description: "Read the current git branch or detached HEAD reference for a repository root.",
  inputs: {
    repo_root: stringInput({ optional: true, description: "Repository root to inspect. Defaults to RUNX_CWD or the current working directory." }),
    fixture: stringInput({ optional: true, description: "Optional fixture workspace root used during dev and harness execution." }),
  },
  output: {
    packet: "runx.git.branch.v1",
    wrap_as: "git_branch",
  },
  scopes: ["git.read"],
  run({ inputs, env }) {
    const repoRoot = resolveRepoRoot(inputs, env);
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
