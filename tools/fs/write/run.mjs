import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defineTool,
  rawInput,
  resolveInsideRepo,
  resolveRepoRoot,
  stringInput,
} from "../../_lib/harness.mjs";

const tool = defineTool({
  inputs: {
    path: stringInput(),
    contents: rawInput(),
    repo_root: stringInput({ optional: true }),
    project: stringInput({ optional: true }),
    fixture: stringInput({ optional: true }),
  },
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

await tool.main();
