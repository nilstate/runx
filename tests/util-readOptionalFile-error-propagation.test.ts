import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readOptionalFile } from "../packages/core/src/util/fs.js";

describe("readOptionalFile only swallows ENOENT", () => {
  it("returns the file contents when the file exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runx-readopt-"));
    try {
      const filePath = path.join(dir, "hello.txt");
      await writeFile(filePath, "hi", "utf8");
      expect(await readOptionalFile(filePath)).toBe("hi");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the file is missing (ENOENT)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runx-readopt-"));
    try {
      expect(await readOptionalFile(path.join(dir, "missing.txt"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rethrows EISDIR when the path is a directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runx-readopt-"));
    try {
      await expect(readOptionalFile(dir)).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
