import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashStable, isRecord as isPlainRecord, safeReadDir, stableStringify } from "@runxhq/core/util";

export { isPlainRecord, safeReadDir, stableStringify };

export interface LocalPacketIndexResult {
  readonly packets: readonly {
    readonly id: string;
    readonly package: string;
    readonly version: string;
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly errors: readonly {
    readonly id: string;
    readonly title: string;
    readonly message: string;
    readonly ref: string;
    readonly path: string;
    readonly evidence?: Readonly<Record<string, unknown>>;
  }[];
}

export async function buildLocalPacketIndex(
  root: string,
  options: { readonly writeCache: boolean },
): Promise<LocalPacketIndexResult> {
  const packageJsonPath = path.join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { packets: [], errors: [] };
  }
  const errors: LocalPacketIndexResult["errors"][number][] = [];
  let packageJson: {
    readonly name?: string;
    readonly version?: string;
    readonly runx?: { readonly packets?: readonly string[] };
  };
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    return {
      packets: [],
      errors: [{
        id: "runx.packet.package.invalid",
        title: "Package metadata is invalid",
        message: error instanceof Error ? error.message : String(error),
        ref: "package.json",
        path: "package.json",
      }],
    };
  }
  const globs = packageJson.runx?.packets ?? [];
  const packets: LocalPacketIndexResult["packets"][number][] = [];
  const seen = new Map<string, LocalPacketIndexResult["packets"][number]>();
  for (const glob of globs) {
    const files = await expandLocalGlob(root, glob);
    if (files.length === 0) {
      errors.push({
        id: "runx.packet.ref.missing",
        title: "Packet glob matched no files",
        message: `${glob} did not resolve to any packet schema artifacts.`,
        ref: glob,
        path: "package.json",
      });
      continue;
    }
    for (const filePath of files) {
      const relativePath = toProjectPath(root, filePath);
      try {
        const schema = JSON.parse(await readFile(filePath, "utf8")) as unknown;
        if (!isPlainRecord(schema)) {
          throw new Error("packet schema must be a JSON object");
        }
        const id = typeof schema["x-runx-packet-id"] === "string"
          ? schema["x-runx-packet-id"]
          : typeof schema.$id === "string"
            ? schema.$id
            : undefined;
        if (!id) {
          errors.push({
            id: "runx.packet.id.mismatch",
            title: "Packet schema is missing a runx packet ID",
            message: `${relativePath} must declare x-runx-packet-id or $id.`,
            ref: relativePath,
            path: relativePath,
          });
          continue;
        }
        const packet = {
          id,
          package: packageJson.name ?? "(local)",
          version: packageJson.version ?? "0.0.0",
          path: relativePath,
          sha256: sha256Stable(schema),
        };
        const existing = seen.get(id);
        if (existing && existing.sha256 !== packet.sha256) {
          errors.push({
            id: "runx.packet.id.collision",
            title: "Packet ID collision",
            message: `${id} is declared by multiple schemas with different hashes.`,
            ref: id,
            path: relativePath,
            evidence: {
              first_path: existing.path,
              first_sha256: existing.sha256,
              second_sha256: packet.sha256,
            },
          });
          continue;
        }
        seen.set(id, packet);
        packets.push(packet);
      } catch (error) {
        errors.push({
          id: "runx.packet.schema.invalid",
          title: "Packet schema is invalid",
          message: error instanceof Error ? error.message : String(error),
          ref: relativePath,
          path: relativePath,
        });
      }
    }
  }
  const result = { packets, errors };
  if (options.writeCache && (packets.length > 0 || globs.length > 0)) {
    await writeJsonFile(path.join(root, ".runx", "cache", "packet-index.json"), {
      schema: "runx.packet.index.v1",
      packets,
    });
  }
  return result;
}

export async function expandLocalGlob(root: string, glob: string): Promise<readonly string[]> {
  if (!glob.includes("*")) {
    const direct = path.resolve(root, glob);
    return existsSync(direct) ? [direct] : [];
  }
  const normalized = glob.split(path.sep).join("/");
  const star = normalized.indexOf("*");
  const base = normalized.slice(0, star);
  const baseDir = path.resolve(root, base.slice(0, base.lastIndexOf("/") + 1));
  const suffix = normalized.slice(star + 1);
  const files: string[] = [];
  for (const entry of await safeReadDir(baseDir)) {
    const candidate = path.join(baseDir, entry.name);
    if (entry.isFile() && candidate.split(path.sep).join("/").endsWith(suffix)) {
      files.push(candidate);
    }
  }
  return files.sort();
}

export async function countYamlFiles(directory: string): Promise<number> {
  return (await safeReadDir(directory)).filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name)).length;
}

export async function discoverSkillProfilePaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const rootProfile = path.join(root, "X.yaml");
  if (existsSync(rootProfile)) {
    paths.push(rootProfile);
  }
  const skillsRoot = path.join(root, "skills");
  for (const skillEntry of await safeReadDir(skillsRoot)) {
    if (!skillEntry.isDirectory()) {
      continue;
    }
    const profilePath = path.join(skillsRoot, skillEntry.name, "X.yaml");
    if (existsSync(profilePath)) {
      paths.push(profilePath);
    }
  }
  return paths.sort();
}

export function toProjectPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256Stable(value: unknown): string {
  return `sha256:${hashStable(value)}`;
}


export function deepEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}
