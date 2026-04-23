import { lstat, rm } from "node:fs/promises";

import {
  defineTool,
  resolveInsideRepo,
  resolveRepoRoot,
  stringInput,
} from "../../_lib/harness.mjs";

const tool = defineTool({
  inputs: {
    path: stringInput(),
    repo_root: stringInput({ optional: true }),
    project: stringInput({ optional: true }),
    fixture: stringInput({ optional: true }),
  },
  async run({ inputs, env }) {
    const repoRoot = resolveRepoRoot(inputs, env);
    const resolvedPath = resolveInsideRepo(repoRoot, inputs.path);
    if (resolvedPath === repoRoot) {
      throw new Error("refusing to delete repo_root");
    }

    let existed = false;
    let kind = "missing";
    try {
      const stats = await lstat(resolvedPath);
      existed = true;
      if (stats.isDirectory()) {
        throw new Error(`path resolves to a directory, not a file: ${inputs.path}`);
      }
      kind = stats.isSymbolicLink() ? "symlink" : "file";
      await rm(resolvedPath, { force: true });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        existed = false;
        kind = "missing";
      } else {
        throw error;
      }
    }

    return {
      path: inputs.path,
      repo_root: repoRoot,
      existed,
      deleted: existed,
      kind,
    };
  },
});

await tool.main();
