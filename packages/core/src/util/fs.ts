import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";

import { isNotFound } from "./types.js";

/**
 * Check whether a path exists. Returns `false` only when the path does not
 * exist (`ENOENT`). All other I/O errors propagate to the caller.
 */
export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Read a file as utf8, returning `undefined` only when the file does not
 * exist (`ENOENT`). All other I/O errors propagate to the caller.
 *
 * The previous core/config copy of this helper silently swallowed every
 * error, hiding real issues such as permissions or device errors. This
 * canonical implementation rethrows non-ENOENT errors loudly.
 */
export async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Read directory entries, returning an empty array when the directory does
 * not exist. All other I/O errors propagate to the caller.
 */
export async function safeReadDir(directory: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Variant of `safeReadDir` that returns plain string entry names. Mirrors
 * the previous `safeReaddir` helper in `core/registry/store.ts`.
 */
export async function safeReadDirNames(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}
