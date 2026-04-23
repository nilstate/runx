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
    data: rawInput(),
    indent: rawInput({ optional: true }),
    repo_root: stringInput({ optional: true }),
    project: stringInput({ optional: true }),
    fixture: stringInput({ optional: true }),
  },
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

await tool.main();
