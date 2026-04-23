import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineTool, stringInput } from "../../_lib/harness.mjs";

const tool = defineTool({
  inputs: {
    output_dir: stringInput(),
    index_path: stringInput({ optional: true }),
  },
  run({ inputs, env }) {
    const inputBase = env.RUNX_CWD || env.INIT_CWD || process.cwd();
    const outputDir = path.resolve(inputBase, inputs.output_dir);
    const indexPath = path.resolve(outputDir, inputs.index_path || "index.html");
    if (!existsSync(indexPath)) {
      throw new Error(`Sourcey output is missing index.html at ${indexPath}`);
    }

    const contents = readFileSync(indexPath, "utf8");
    return {
      output_dir: outputDir,
      index_path: indexPath,
      verified: true,
      contains_doctype: /<!doctype html>/i.test(contents),
    };
  },
});

await tool.main();
