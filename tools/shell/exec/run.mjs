import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineTool, failure, rawInput, stringInput } from "../../_lib/harness.mjs";

const tool = defineTool({
  inputs: {
    command: stringInput(),
    args: rawInput({ optional: true }),
    cwd: stringInput({ optional: true }),
    repo_root: stringInput({ optional: true }),
  },
  run({ inputs, env }) {
    const args = Array.isArray(inputs.args) ? inputs.args.map((value) => String(value)) : [];
    const cwd = path.resolve(inputs.cwd || inputs.repo_root || env.RUNX_CWD || process.cwd());
    const result = spawnSync(inputs.command, args, {
      cwd,
      encoding: "utf8",
      shell: false,
    });

    if (result.error) {
      throw result.error;
    }

    const output = {
      command: inputs.command,
      args,
      cwd,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exit_code: result.status ?? 0,
    };
    return (result.status ?? 0) === 0
      ? output
      : failure(output, { exitCode: result.status ?? 1, stderr: result.stderr ?? "" });
  },
});

await tool.main();
