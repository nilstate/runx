import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defineTool,
  rawInput,
  resolveInsideRepo,
  resolveRepoRoot,
  stringInput,
} from "@runxhq/authoring";

export default defineTool({
  name: "fs.write",
  description: "Write a UTF-8 text file relative to a repository or workspace root.",
  inputs: {
    path: stringInput({ description: "Path to the output file relative to repo_root." }),
    contents: rawInput({ description: "UTF-8 string contents to write." }),
    repo_root: stringInput({ optional: true, description: "Repository or workspace root; defaults to fixture, RUNX_CWD, or the current working directory." }),
    fixture: stringInput({ optional: true, description: "Optional fixture workspace root used during dev and harness execution." }),
  },
  output: {
    packet: "runx.fs.file_write.v1",
    wrap_as: "file_write",
  },
  scopes: ["fs.write"],
  async run({ inputs, env }) {
    if (typeof inputs.contents !== "string") {
      throw new Error("contents must be a string.");
    }

    const repoRoot = resolveRepoRoot(inputs, env);
    const resolvedPath = resolveInsideRepo(repoRoot, inputs.path);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, inputs.contents, "utf8");

    return {
      path: inputs.path,
      repo_root: repoRoot,
      bytes_written: Buffer.byteLength(inputs.contents, "utf8"),
      sha256: createHash("sha256").update(inputs.contents).digest("hex"),
    };
  },
});
