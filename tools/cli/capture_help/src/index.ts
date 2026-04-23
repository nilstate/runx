import { spawnSync } from "node:child_process";
import path from "node:path";

import { defineTool, failure, rawInput, stringInput } from "@runxhq/authoring";

export default defineTool({
  name: "cli.capture_help",
  description: "Capture help output from a CLI command deterministically.",
  inputs: {
    command: stringInput({ description: "Executable to invoke." }),
    args: rawInput({ optional: true, description: "Optional argument array to place before the help flag." }),
    help_flag: stringInput({ default: "--help", description: "Help flag to append when invoking the command." }),
    cwd: stringInput({ optional: true, description: "Optional working directory override for the command." }),
    repo_root: stringInput({ optional: true, description: "Optional repository or workspace root used when cwd is not supplied." }),
  },
  output: {
    packet: "runx.cli.help.v1",
    wrap_as: "cli_help",
  },
  scopes: ["cli.read"],
  run({ inputs, env }) {
    const args = Array.isArray(inputs.args) ? inputs.args.map((value) => String(value)) : [];
    const cwd = path.resolve(inputs.cwd || inputs.repo_root || env.RUNX_CWD || process.cwd());
    const result = spawnSync(inputs.command, [...args, inputs.help_flag], {
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
      help_flag: inputs.help_flag,
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
