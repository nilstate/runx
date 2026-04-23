import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  RunxListItemContract,
  RunxListItemKindContract,
  RunxListReportContract,
  RunxListRequestedKindContract,
  RunxListSourceContract,
} from "@runxhq/contracts";
import { resolveRunxWorkspaceBase } from "@runxhq/core/config";
import {
  parseRunnerManifestYaml,
  parseToolManifestJson,
  validateRunnerManifest,
  validateToolManifest,
} from "@runxhq/core/parser";

import {
  buildLocalPacketIndex,
  countYamlFiles,
  discoverSkillProfilePaths,
  safeReadDir,
  toProjectPath,
} from "../authoring-utils.js";

export type RunxListRequestedKind = RunxListRequestedKindContract;
export type RunxListItemKind = RunxListItemKindContract;
export type RunxListSource = RunxListSourceContract;
export type RunxListItem = RunxListItemContract;
export type RunxListReport = RunxListReportContract;

export interface ListCommandArgs {
  readonly listKind?: RunxListRequestedKind;
  readonly listOkOnly?: boolean;
  readonly listInvalidOnly?: boolean;
}

export async function handleListCommand(parsed: ListCommandArgs, env: NodeJS.ProcessEnv): Promise<RunxListReport> {
  const root = resolveRunxWorkspaceBase(env);
  const requestedKind = parsed.listKind ?? "all";
  const items = await discoverListItems(root, requestedKind);
  const filtered = items.filter((item) => {
    if (parsed.listOkOnly) {
      return item.status === "ok";
    }
    if (parsed.listInvalidOnly) {
      return item.status === "invalid";
    }
    return true;
  });
  return {
    schema: "runx.list.v1",
    root,
    requested_kind: requestedKind,
    items: sortListItems(filtered),
  };
}

export function normalizeListKind(value: string | undefined): RunxListRequestedKind | undefined {
  if (value === undefined || value === "") {
    return "all";
  }
  if (["tools", "skills", "chains", "packets", "overlays"].includes(value)) {
    return value as RunxListRequestedKind;
  }
  return undefined;
}

async function discoverListItems(root: string, requestedKind: RunxListRequestedKind): Promise<readonly RunxListItem[]> {
  const items: RunxListItem[] = [];
  if (requestedKind === "all" || requestedKind === "tools") {
    items.push(...await discoverToolListItems(root));
  }
  if (requestedKind === "all" || requestedKind === "skills" || requestedKind === "chains") {
    items.push(...(await discoverSkillAndChainListItems(root)).filter((item) => requestedKind === "all" || `${item.kind}s` === requestedKind));
  }
  if (requestedKind === "all" || requestedKind === "packets") {
    items.push(...await discoverPacketListItems(root));
  }
  if (requestedKind === "all" || requestedKind === "overlays") {
    items.push(...await discoverOverlayListItems(root));
  }
  return items;
}

async function discoverToolListItems(root: string): Promise<readonly RunxListItem[]> {
  const toolsRoot = path.join(root, "tools");
  const items: RunxListItem[] = [];
  for (const namespaceEntry of await safeReadDir(toolsRoot)) {
    if (!namespaceEntry.isDirectory()) {
      continue;
    }
    const namespaceDir = path.join(toolsRoot, namespaceEntry.name);
    for (const toolEntry of await safeReadDir(namespaceDir)) {
      if (!toolEntry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(namespaceDir, toolEntry.name, "manifest.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const relativePath = toProjectPath(root, manifestPath);
      try {
        const tool = validateToolManifest(parseToolManifestJson(await readFile(manifestPath, "utf8")));
        const emits = tool.artifacts?.namedEmits
          ? Object.entries(tool.artifacts.namedEmits).map(([name, packet]) => ({ name, packet }))
          : tool.artifacts?.wrapAs
            ? [{ name: tool.artifacts.wrapAs }]
            : [];
        items.push({
          kind: "tool",
          name: tool.name,
          source: "local",
          path: relativePath,
          status: "ok",
          scopes: tool.scopes,
          emits,
          fixtures: await countYamlFiles(path.join(namespaceDir, toolEntry.name, "fixtures")),
        });
      } catch {
        items.push({
          kind: "tool",
          name: `${namespaceEntry.name}.${toolEntry.name}`,
          source: "local",
          path: relativePath,
          status: "invalid",
          diagnostics: ["runx.tool.manifest.invalid"],
        });
      }
    }
  }
  return items;
}

async function discoverSkillAndChainListItems(root: string): Promise<readonly RunxListItem[]> {
  const items: RunxListItem[] = [];
  for (const profilePath of await discoverSkillProfilePaths(root)) {
    const skillDir = path.dirname(profilePath);
    const fallbackName = skillDir === root ? path.basename(root) : path.basename(skillDir);
    const relativePath = toProjectPath(root, profilePath);
    try {
      const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile(profilePath, "utf8")));
      const runners = Object.values(manifest.runners);
      const chainSteps = runners
        .map((runner) => runner.source.chain?.steps.length)
        .filter((value): value is number => typeof value === "number");
      const isChain = chainSteps.length > 0;
      items.push({
        kind: isChain ? "chain" : "skill",
        name: manifest.skill ?? fallbackName,
        source: "local",
        path: relativePath,
        status: "ok",
        fixtures: await countYamlFiles(path.join(skillDir, "fixtures")),
        harness_cases: manifest.harness?.cases.length ?? 0,
        steps: isChain ? chainSteps.reduce((sum, value) => sum + value, 0) : undefined,
      });
    } catch {
      items.push({
        kind: "skill",
        name: fallbackName,
        source: "local",
        path: relativePath,
        status: "invalid",
        diagnostics: ["runx.skill.profile.invalid"],
      });
    }
  }
  return items;
}

async function discoverPacketListItems(root: string): Promise<readonly RunxListItem[]> {
  const index = await buildLocalPacketIndex(root, { writeCache: false });
  return [
    ...index.packets.map((packet) => ({
      kind: "packet" as const,
      name: packet.id,
      source: "local" as const,
      path: packet.path,
      status: "ok" as const,
    })),
    ...index.errors.map((error) => ({
      kind: "packet" as const,
      name: error.ref,
      source: "local" as const,
      path: error.path,
      status: "invalid" as const,
      diagnostics: [error.id],
    })),
  ];
}

async function discoverOverlayListItems(root: string): Promise<readonly RunxListItem[]> {
  const overlaysRoot = path.join(root, "skills-overlays");
  const items: RunxListItem[] = [];
  for (const vendorEntry of await safeReadDir(overlaysRoot)) {
    if (!vendorEntry.isDirectory()) {
      continue;
    }
    const vendorDir = path.join(overlaysRoot, vendorEntry.name);
    for (const skillEntry of await safeReadDir(vendorDir)) {
      if (!skillEntry.isDirectory()) {
        continue;
      }
      const profilePath = path.join(vendorDir, skillEntry.name, "X.yaml");
      if (!existsSync(profilePath)) {
        continue;
      }
      const contents = await readFile(profilePath, "utf8");
      const wraps = /^\s*wraps:\s*(.+?)\s*$/m.exec(contents)?.[1];
      items.push({
        kind: "overlay",
        name: `${vendorEntry.name}/${skillEntry.name}`,
        source: "local",
        path: toProjectPath(root, profilePath),
        status: "ok",
        wraps,
      });
    }
  }
  return items;
}

function sortListItems(items: readonly RunxListItem[]): readonly RunxListItem[] {
  const tierOrder: Record<RunxListSource, number> = {
    local: 0,
    workspace: 1,
    dependencies: 2,
    "built-in": 3,
  };
  const kindOrder: Record<RunxListItemKind, number> = {
    tool: 0,
    skill: 1,
    chain: 2,
    packet: 3,
    overlay: 4,
  };
  return [...items].sort((left, right) =>
    tierOrder[left.source] - tierOrder[right.source]
    || kindOrder[left.kind] - kindOrder[right.kind]
    || left.name.localeCompare(right.name)
  );
}
