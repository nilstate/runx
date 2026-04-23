import { lstat, rm } from "node:fs/promises";

import {
  defineTool,
  resolveInsideRepo,
  resolveRepoRoot,
  stringInput,
} from "@runxhq/authoring";

export default defineTool({
  name: "fs.delete",
  description: "Delete a file relative to a repository or workspace root.",
  inputs: {
    path: stringInput({ description: "Path to the file relative to repo_root." }),
    repo_root: stringInput({ optional: true, description: "Repository or workspace root; defaults to fixture, project, RUNX_CWD, or the current working directory." }),
    project: stringInput({ optional: true, description: "Optional alias for repo_root used by local harnesses." }),
    fixture: stringInput({ optional: true, description: "Optional fixture workspace root used during dev and harness execution." }),
  },
  output: {
    packet: "runx.fs.delete.v1",
    wrap_as: "file_delete",
  },
  scopes: ["fs.write"],
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
