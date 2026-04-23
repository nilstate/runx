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
} from "../../_lib/harness.mjs";

const tool = defineTool({
  inputs: {
    files: rawInput(),
    repo_root: stringInput({ optional: true }),
    project: stringInput({ optional: true }),
    fixture: stringInput({ optional: true }),
  },
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

await tool.main();
