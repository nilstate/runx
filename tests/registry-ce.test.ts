import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildSkillPageModel } from "../apps/registry/src/skill-page.js";
import {
  createFileRegistryStore,
  deriveTrustSignals,
  ingestSkillMarkdown,
  resolveRunxLink,
  searchRegistry,
} from "../packages/registry/src/index.js";

describe("registry CE", () => {
  it("ingests skill markdown, derives trust signals, searches, and resolves runx links", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-registry-ce-"));
    const store = createFileRegistryStore(path.join(tempDir, "registry"));

    try {
      const markdown = await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8");
      const profileDocument = await readFile(path.resolve("bindings/runx/sourcey/X.yaml"), "utf8");
      const version = await ingestSkillMarkdown(store, markdown, {
        owner: "0state",
        version: "1.0.0",
        createdAt: "2026-04-10T00:00:00.000Z",
        profileDocument,
      });

      expect(version.skill_id).toBe("0state/sourcey");
      expect(version.version).toBe("1.0.0");
      expect(version.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(version.profile_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(version.source_type).toBe("agent");
      expect(version.runner_names).toEqual(["agent", "sourcey"]);
      expect(version.markdown).toBe(markdown);
      expect(version.profile_document).toBe(profileDocument);

      const trustSignals = deriveTrustSignals(version);
      expect(trustSignals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "digest", status: "verified", value: `sha256:${version.digest}` }),
          expect.objectContaining({ id: "source_type", status: "declared", value: "agent" }),
          expect.objectContaining({ id: "publisher", status: "placeholder", value: "0state" }),
          expect.objectContaining({ id: "runner_metadata", status: "verified" }),
        ]),
      );

      const page = await buildSkillPageModel(store, "0state/sourcey", "1.0.0", "https://runx.example.test");
      expect(page).toMatchObject({
        skill_id: "0state/sourcey",
        name: "sourcey",
        version: "1.0.0",
        digest: version.digest,
        profile_digest: version.profile_digest,
        runner_names: ["agent", "sourcey"],
        source_type: "agent",
        install_command: "runx add 0state/sourcey@1.0.0 --registry https://runx.example.test",
        run_command: "runx sourcey",
      });
      expect(page?.trust_signals).toEqual(trustSignals);
      expect(page?.versions).toEqual([
        {
          version: "1.0.0",
          digest: version.digest,
          created_at: "2026-04-10T00:00:00.000Z",
        },
      ]);

      const results = await searchRegistry(store, "sourcey", { registryUrl: "https://runx.example.test" });
      expect(results).toEqual([
        expect.objectContaining({
          skill_id: "0state/sourcey",
          source: "runx-registry",
          source_label: "runx registry",
          source_type: "agent",
          trust_tier: "runx-derived",
          profile_mode: "profiled",
          runner_names: ["agent", "sourcey"],
          profile_digest: version.profile_digest,
          add_command: "runx add 0state/sourcey@1.0.0 --registry https://runx.example.test",
        }),
      ]);

      const link = await resolveRunxLink(store, "0state/sourcey", "1.0.0", "https://runx.example.test");
      expect(link).toEqual({
        link: "runx://skill/0state%2Fsourcey@1.0.0",
        skill_id: "0state/sourcey",
        version: "1.0.0",
        digest: version.digest,
        registry_url: "https://runx.example.test",
        install_command: "runx add 0state/sourcey@1.0.0 --registry https://runx.example.test",
        run_command: "runx sourcey",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
