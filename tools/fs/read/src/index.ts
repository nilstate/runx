import fs from "node:fs";
import path from "node:path";

import {
  defineTool,
  resolveRepoRoot,
  stringInput,
} from "@runxhq/authoring";

export default defineTool({
  name: "fs.read",
  description: "Read a UTF-8 text file relative to a repository or workspace root.",
  inputs: {
    path: stringInput({ description: "Path to the file relative to repo_root." }),
    repo_root: stringInput({ optional: true, description: "Repository or workspace root; defaults to fixture, RUNX_CWD, or the current working directory." }),
    fixture: stringInput({ optional: true, description: "Optional fixture workspace root used during dev and harness execution." }),
  },
  output: {
    packet: "runx.fs.file_read.v1",
    wrap_as: "file_read",
  },
  scopes: ["fs.read"],
  run({ inputs, env }) {
    const repoRoot = resolveRepoRoot(inputs, env);
    const resolvedPath = path.resolve(repoRoot, inputs.path);
    const content = fs.readFileSync(resolvedPath, "utf8");

    return {
      path: inputs.path,
      repo_root: repoRoot,
      contents: content,
    };
  },
});
