#!/usr/bin/env node

export const cliPackage = "@runxhq/cli";

import { realpathSync } from "node:fs";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { pathToFileURL } from "node:url";

import { resolvePathFromUserInput } from "@runxhq/core/config";
import { errorMessage } from "@runxhq/core/util";

import { isSupportedCommand, parseArgs } from "./args.js";
import { createAgentRuntimeLoader, createInteractiveCaller, createNonInteractiveCaller, readCallerInputFile } from "./callers.js";
import type { ConnectService } from "./commands/connect.js";
import { dispatchCli, writeCliError } from "./dispatch.js";
import { isHelpRequest, writeUsage } from "./help.js";

export { parseArgs } from "./args.js";
export type { ParsedArgs } from "./args.js";
export { resolveSkillReference, resolveRunnableSkillReference, createOfficialSkillResolver } from "./skill-refs.js";

export interface CliIo {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
}

export interface CliServices {
  readonly connect?: ConnectService;
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  env: NodeJS.ProcessEnv = process.env,
  services: CliServices = {},
): Promise<number> {
  if (isHelpRequest(argv)) {
    writeUsage(io.stdout, env);
    return 0;
  }

  const parsed = parseArgs(argv);
  if (!isSupportedCommand(parsed)) {
    writeUsage(io.stderr, env);
    return 64;
  }

  try {
    const callerInput = parsed.answersPath
      ? await readCallerInputFile(resolvePathFromUserInput(parsed.answersPath, env))
      : { answers: {} };
    const agentRuntimeLoader = createAgentRuntimeLoader(env);
    const nonInteractive = parsed.nonInteractive || parsed.json;
    const caller = nonInteractive
      ? createNonInteractiveCaller(callerInput.answers, callerInput.approvals, agentRuntimeLoader)
      : createInteractiveCaller(io, callerInput.answers, callerInput.approvals, { reportEvents: !parsed.json }, env, agentRuntimeLoader);
    return await dispatchCli(parsed, io, env, caller, services);
  } catch (error) {
    const message = errorMessage(error);
    return writeCliError(io, message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const exitCode = await runCli(process.argv.slice(2), {
    stdin: processStdin,
    stdout: processStdout,
    stderr: process.stderr,
  });
  process.exitCode = exitCode;
}
