import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCatalog, buildCommand, renderSourceyConfig } from "./build.mjs";

const catalog = {
  source_repository: "https://github.com/runxhq/runx",
  source_commit: "5afc25a83edf1c1320df7ac0d78c36f1523b5677",
  groups: [
    { name: "Operate", entries: [{ slug: "agency" }, { slug: "work-plan" }] },
    { name: "Research and data", entries: [{ slug: "research" }] },
    { name: "GitHub and delivery", entries: [{ slug: "issue-to-pr" }] },
    { name: "Safety and review", entries: [{ slug: "cve-audit" }] },
    { name: "Outbound and tooling", entries: [{ slug: "sourcey" }] }
  ]
};

test("config exposes every manifest page once after introduction in catalog group order", () => {
  const config = renderSourceyConfig(catalog);
  const expectedGroups = ["Introduction", ...catalog.groups.map((group) => group.name)];

  assert.match(config, /name: "Runx Governed Skill Catalog"/);
  assert.match(config, /siteUrl: "https:\/\/github\.com"/);
  assert.match(config, /baseUrl: "\/runxhq\/runx"/);
  assert.match(config, /repo: "https:\/\/github\.com\/runxhq\/runx"/);
  assert.match(config, /editBranch: "main"/);
  assert.match(config, /editBasePath: "docs\/sourcey-catalog"/);
  assert.deepEqual(
    [...config.matchAll(/group: "([^"]+)"/g)].map((match) => match[1]),
    expectedGroups
  );
  assert.match(config, /group: "Introduction",\n\s+pages: \["pages\/introduction"\]/);

  for (const entry of catalog.groups.flatMap((group) => group.entries)) {
    assert.equal(config.match(new RegExp(`pages/${entry.slug.replaceAll("-", "\\-")}`, "g"))?.length, 1);
  }
});

test("build command pins Sourcey 3.6.5 and writes only inside catalog site", () => {
  const plan = buildCommand("/repo/docs/sourcey-catalog");

  assert.deepEqual(plan.command, ["npx", "-y", "sourcey@3.6.5", "build", "-o", "site", "--quiet"]);
  assert.equal(plan.outputDir, "/repo/docs/sourcey-catalog/site");
  assert.throws(
    () => buildCommand("/repo/docs/sourcey-catalog", { outputDir: "/repo/docs/site" }),
    /inside the catalog directory/
  );
});

test("config splits the public URL into the Sourcey 3.6.5 origin and base path", () => {
  const config = renderSourceyConfig(catalog);

  assert.match(config, /siteUrl: "https:\/\/github\.com"/);
  assert.match(config, /baseUrl: "\/runxhq\/runx"/);
});

test("build wrapper accepts an explicit Sourcey binary for offline execution", async (t) => {
  const catalogDir = await mkdtemp(path.join(tmpdir(), "sourcey-build-"));
  t.after(() => rm(catalogDir, { recursive: true, force: true }));
  await writeFile(path.join(catalogDir, "catalog.json"), `${JSON.stringify(catalog)}\n`, "utf8");
  const sourceyBin = path.join(catalogDir, "sourcey-fixture.mjs");
  await writeFile(sourceyBin, [
    "#!/usr/bin/env node",
    "import { mkdir, writeFile } from 'node:fs/promises';",
    "await writeFile('invocation.json', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));",
    "await mkdir('site/pages', { recursive: true });",
    `for (const file of ${JSON.stringify([
      "index.html",
      "search-index.json",
      "sourcey.css",
      "sourcey.js",
      "llms.txt",
      "llms-full.txt",
      "pages/introduction.html",
      ...catalog.groups.flatMap((group) => group.entries.map((entry) => `pages/${entry.slug}.html`)),
    ])}) await writeFile('site/' + file, 'fixture');`,
  ].join("\n"), "utf8");
  await chmod(sourceyBin, 0o755);

  const result = await buildCatalog({ catalogDir, sourceyBin });
  const invocation = JSON.parse(await readFile(path.join(catalogDir, "invocation.json"), "utf8"));

  assert.deepEqual(invocation, {
    cwd: await realpath(catalogDir),
    args: ["build", "-o", "site", "--quiet"]
  });
  assert.equal(result.page_count, 6);
  assert.equal(result.output_dir, path.join(catalogDir, "site"));
  assert.deepEqual(result.command, [sourceyBin, "build", "-o", "site", "--quiet"]);
  assert.match(await readFile(path.join(catalogDir, "sourcey.config.ts"), "utf8"), /pages\/agency/);
});

test("build wrapper refuses a successful command with missing static artifacts", async (t) => {
  const catalogDir = await mkdtemp(path.join(tmpdir(), "sourcey-build-missing-"));
  t.after(() => rm(catalogDir, { recursive: true, force: true }));
  await writeFile(path.join(catalogDir, "catalog.json"), `${JSON.stringify(catalog)}\n`, "utf8");
  const sourceyBin = path.join(catalogDir, "sourcey-fixture.mjs");
  await writeFile(sourceyBin, "#!/usr/bin/env node\n", "utf8");
  await chmod(sourceyBin, 0o755);

  await assert.rejects(
    buildCatalog({ catalogDir, sourceyBin }),
    /missing or empty Sourcey build artifact/,
  );
});

test("build wrapper reports a nonzero Sourcey exit", async (t) => {
  const catalogDir = await mkdtemp(path.join(tmpdir(), "sourcey-build-failed-"));
  t.after(() => rm(catalogDir, { recursive: true, force: true }));
  await writeFile(path.join(catalogDir, "catalog.json"), `${JSON.stringify(catalog)}\n`, "utf8");
  const sourceyBin = path.join(catalogDir, "sourcey-fixture.mjs");
  await writeFile(sourceyBin, "#!/usr/bin/env node\nprocess.exitCode = 7;\n", "utf8");
  await chmod(sourceyBin, 0o755);

  await assert.rejects(
    buildCatalog({ catalogDir, sourceyBin }),
    /exit code 7/,
  );
});
