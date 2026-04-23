import path from "node:path";

import {
  loadRunxConfigFile,
  lookupRunxConfigValue,
  maskRunxConfigFile,
  resolveRunxHomeDir,
  updateRunxConfigValue,
  writeRunxConfigFile,
  type RunxConfigFile,
} from "@runxhq/core/config";

export type ConfigAction = "set" | "get" | "list";

export interface ConfigCommandArgs {
  readonly configAction?: ConfigAction;
  readonly configKey?: string;
  readonly configValue?: string;
}

export type ConfigResult =
  | { readonly action: "set"; readonly key: string; readonly value: unknown }
  | { readonly action: "get"; readonly key: string; readonly value: unknown }
  | { readonly action: "list"; readonly values: RunxConfigFile };

type ConfigKey = "agent.provider" | "agent.model" | "agent.api_key";

export function configAction(positionals: readonly string[]): ConfigAction | undefined {
  if (positionals[0] === "set" || positionals[0] === "get" || positionals[0] === "list") {
    return positionals[0];
  }
  return undefined;
}

export async function handleConfigCommand(parsed: ConfigCommandArgs, env: NodeJS.ProcessEnv): Promise<ConfigResult> {
  const configDir = resolveRunxHomeDir(env);
  const configPath = path.join(configDir, "config.json");
  const config = await loadRunxConfigFile(configPath);

  if (parsed.configAction === "list") {
    return { action: "list", values: maskRunxConfigFile(config) };
  }
  if (!parsed.configKey) {
    throw new Error("config key is required.");
  }
  const key = parsed.configKey as ConfigKey;
  if (parsed.configAction === "get") {
    return {
      action: "get",
      key: parsed.configKey,
      value: lookupRunxConfigValue(config, key),
    };
  }
  if (parsed.configAction === "set") {
    if (parsed.configValue === undefined) {
      throw new Error("config value is required.");
    }
    const next = await updateRunxConfigValue(config, key, parsed.configValue, configDir);
    await writeRunxConfigFile(configPath, next);
    return {
      action: "set",
      key: parsed.configKey,
      value: lookupRunxConfigValue(maskRunxConfigFile(next), key),
    };
  }
  throw new Error("Invalid config invocation.");
}

export function flattenConfig(config: RunxConfigFile): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined) return;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, entry] of Object.entries(value)) {
        walk(prefix ? `${prefix}.${key}` : key, entry);
      }
      return;
    }
    const publicKey = prefix === "agent.api_key_ref" ? "agent.api_key" : prefix;
    rows.push([publicKey, String(value)]);
  };
  walk("", config);
  return rows;
}
