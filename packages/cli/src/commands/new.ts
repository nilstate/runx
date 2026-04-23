import path from "node:path";

import { scaffoldRunxPackage, sanitizeRunxPackageName } from "../scaffold.js";

export interface NewCommandArgs {
  readonly newName?: string;
  readonly newDirectory?: string;
}

export interface NewResult {
  readonly action: "package";
  readonly name: string;
  readonly packet_namespace: string;
  readonly directory: string;
  readonly files: readonly string[];
  readonly next_steps: readonly string[];
}

export async function handleNewCommand(parsed: NewCommandArgs, env: NodeJS.ProcessEnv): Promise<NewResult> {
  if (!parsed.newName) {
    throw new Error("runx new requires a package name.");
  }
  const directory = resolveNewPackageDirectory(parsed.newName, parsed.newDirectory, env);
  const result = await scaffoldRunxPackage({
    name: parsed.newName,
    directory,
  });
  return {
    action: "package",
    ...result,
  };
}

function resolveNewPackageDirectory(name: string, directory: string | undefined, env: NodeJS.ProcessEnv): string {
  if (directory) {
    return path.isAbsolute(directory)
      ? directory
      : path.resolve(env.RUNX_CWD ?? env.INIT_CWD ?? process.cwd(), directory);
  }
  return path.resolve(env.RUNX_CWD ?? env.INIT_CWD ?? process.cwd(), sanitizeRunxPackageName(name));
}
