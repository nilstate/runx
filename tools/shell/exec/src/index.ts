import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineTool, failure, rawInput, stringInput } from "@runxhq/authoring";

export default defineTool({
  name: "shell.exec",
  description: "Execute an explicit command as a high-risk escape hatch.",
  inputs: {
    command: stringInput({ description: "Executable to invoke." }),
    args: rawInput({ optional: true, description: "Optional argument array for the command." }),
    cwd: stringInput({ optional: true, description: "Optional working directory override for the command." }),
    repo_root: stringInput({ optional: true, description: "Optional repository root used when cwd is not supplied." }),
  },
  output: {
    packet: "runx.shell.execution.v1",
    wrap_as: "shell_execution",
  },
  scopes: ["shell.exec"],
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
