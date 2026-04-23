import fs from "node:fs";
import path from "node:path";

import {
  defineTool,
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

await tool.main();
