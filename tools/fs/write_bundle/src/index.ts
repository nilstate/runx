import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defineTool,
  isRecord,
  rawInput,
  resolveInsideRepo,
  resolveRepoRoot,
  stringInput,
} from "@runxhq/authoring";

export default defineTool({
  name: "fs.write_bundle",
  description: "Write a bounded bundle of UTF-8 text files relative to a repository or workspace root.",
  inputs: {
    files: rawInput({ description: "Array of { path, contents } entries to write." }),
    repo_root: stringInput({ optional: true, description: "Repository or workspace root; defaults to fixture, project, RUNX_CWD, or the current working directory." }),
    project: stringInput({ optional: true, description: "Optional alias for repo_root used by local harnesses." }),
    fixture: stringInput({ optional: true, description: "Optional fixture workspace root used during dev and harness execution." }),
  },
  output: {
    packet: "runx.fs.write_bundle.v1",
    wrap_as: "file_bundle_write",
  },
  scopes: ["fs.write"],
  async run({ inputs, env }) {
    if (!Array.isArray(inputs.files)) {
      throw new Error("files must be an array.");
    }

    const repoRoot = resolveRepoRoot(inputs, env);
    const written = [];

    for (const entry of inputs.files) {
      if (!isRecord(entry)) {
        throw new Error("each files entry must be an object.");
      }
      const targetPath = String(entry.path || "");
      if (!targetPath) {
        throw new Error("each files entry must include path.");
      }
      if (typeof entry.contents !== "string") {
        throw new Error(`files entry '${targetPath}' must include string contents.`);
      }

      const resolvedPath = resolveInsideRepo(repoRoot, targetPath);
      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, entry.contents, "utf8");
      written.push({
        path: targetPath,
        bytes_written: Buffer.byteLength(entry.contents, "utf8"),
        sha256: createHash("sha256").update(entry.contents).digest("hex"),
      });
    }

    return {
      repo_root: repoRoot,
      file_count: written.length,
      files: written,
    };
  },
});
