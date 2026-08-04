import { resolveNativeRunxBinary } from "../scripts/lib/native-parser.mjs";

export function resolveRunxBinary(env: NodeJS.ProcessEnv = process.env): string {
  return resolveNativeRunxBinary(env);
}

export function kernelEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    RUNX_RUST_CLI_BIN: resolveRunxBinary(env),
  };
}
