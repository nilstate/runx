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
  name: "fs.write_json",
  description: "Write JSON to a file relative to a repository or workspace root.",
  inputs: {
    path: stringInput({ description: "Path to the output file relative to repo_root." }),
    data: rawInput({ description: "JSON-compatible value to serialize." }),
    indent: rawInput({ optional: true, description: "Optional indentation width. Defaults to 2." }),
    repo_root: stringInput({ optional: true, description: "Repository or workspace root; defaults to fixture, project, RUNX_CWD, or the current working directory." }),
    project: stringInput({ optional: true, description: "Optional alias for repo_root used by local harnesses." }),
    fixture: stringInput({ optional: true, description: "Optional fixture workspace root used during dev and harness execution." }),
  },
  output: {
    packet: "runx.fs.file_write.v1",
    wrap_as: "file_write",
  },
  scopes: ["fs.write"],
  async run({ inputs, env }) {
    const indent = Number.parseInt(String(inputs.indent ?? "2"), 10);
    if (!Number.isFinite(indent) || indent < 0) {
      throw new Error("indent must be a non-negative integer.");
    }

    const repoRoot = resolveRepoRoot(inputs, env);
    const resolvedPath = resolveInsideRepo(repoRoot, inputs.path);
    const contents = `${JSON.stringify(inputs.data, null, indent)}\n`;
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, contents, "utf8");

    return {
      path: inputs.path,
      repo_root: repoRoot,
      bytes_written: Buffer.byteLength(contents, "utf8"),
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  },
});
