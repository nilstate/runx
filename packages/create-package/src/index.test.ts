import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scaffoldRunxPackage } from "./index.js";

describe("@runxhq/create-package", () => {
  it("scaffolds the runx authoring loop files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-create-package-"));
    try {
      const target = path.join(tempDir, "docs-demo");
      await scaffoldRunxPackage({ name: "docs-demo", directory: target });
      await expect(readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toContain("name: docs-demo");
      await expect(readFile(path.join(target, "X.yaml"), "utf8")).resolves.toContain("tool: docs.echo");
      await expect(readFile(path.join(target, "tools/docs/echo/fixtures/basic.yaml"), "utf8")).resolves.toContain("lane: deterministic");
      await expect(readFile(path.join(target, "fixtures/agent.yaml"), "utf8")).resolves.toContain("lane: agent");
      await expect(readFile(path.join(target, "fixtures/agent.replay.json"), "utf8")).resolves.toContain("runx.replay.v1");
      await expect(readFile(path.join(target, "dist/packets/echo.v1.schema.json"), "utf8")).resolves.toContain("x-runx-packet-id");
      const manifest = JSON.parse(await readFile(path.join(target, "tools/docs/echo/manifest.json"), "utf8")) as {
        readonly source_hash?: string;
        readonly schema_hash?: string;
      };
      expect(manifest.source_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(manifest.schema_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(manifest.source_hash).not.toBe("sha256:scaffold");
      expect(manifest.schema_hash).not.toBe("sha256:scaffold");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
