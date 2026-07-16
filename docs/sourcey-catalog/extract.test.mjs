import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { extractCatalog } from "./extract.mjs";

const sourceCommit = "5afc25a83edf1c1320df7ac0d78c36f1523b5677";
const names = [
  "agency", "business-ops", "operator-inbox", "ops-desk", "work-plan",
  "deep-research", "research", "data-store", "knowledge-router", "web-fetch",
  "github-sync", "issue-intake", "issue-triage", "issue-to-pr", "release",
  "audit-receipt", "cve-audit", "least-privilege", "policy-author",
  "review-receipt", "sandbox-harden", "governed-outbound", "run-history", "sourcey"
];
const groupDefinitions = [
  { name: "Operate", names: names.slice(0, 5) },
  { name: "Research and data", names: names.slice(5, 10) },
  { name: "GitHub and delivery", names: names.slice(10, 15) },
  { name: "Safety and review", names: names.slice(15, 21) },
  { name: "Outbound and tooling", names: names.slice(21) }
];

function blobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function catalog(entries = createEntries()) {
  let offset = 0;
  return {
    source_repository: "https://github.com/runxhq/runx",
    source_commit: sourceCommit,
    groups: groupDefinitions.map((group) => {
      const groupEntries = entries.slice(offset, offset + group.names.length);
      offset += group.names.length;
      return { name: group.name, entries: groupEntries };
    })
  };
}

function createEntries() {
  return groupDefinitions.flatMap((group) => group.names.map((name) => ({
    name,
    slug: name,
    group: group.name,
    path: `skills/${name}/SKILL.md`
  })));
}

function sourceResponse(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        type: "file",
        encoding: "base64",
        content: bytes.toString("base64"),
        sha: blobSha(bytes)
      };
    }
  };
}

function fixtureFetch(contentByPath) {
  return async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.github.com");
    assert.equal(parsed.searchParams.get("ref"), sourceCommit);
    const sourcePath = decodeURIComponent(parsed.pathname.replace("/repos/runxhq/runx/contents/", ""));
    return sourceResponse(contentByPath.get(sourcePath));
  };
}

async function withTokenEnvironment({ githubToken, ghToken }, callback) {
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousGhToken = process.env.GH_TOKEN;
  try {
    if (githubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = githubToken;
    if (ghToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = ghToken;
    return await callback();
  } finally {
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
  }
}

async function captureRejection(callback) {
  let rejection;
  try {
    await callback();
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection instanceof Error);
  return rejection;
}

async function createFixture(overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "sourcey-catalog-"));
  const document = overrides.catalog ?? catalog();
  const catalogPath = path.join(directory, "catalog.json");
  const outputDir = path.join(directory, "pages");
  const contents = new Map(
    createEntries().map(({ name, path: sourcePath }, index) => [
      sourcePath,
      index === 0
        ? (overrides.firstContent ?? `---\nname: ${name}\n---\n# Authored heading\n\npinned content\n`)
        : `---\nname: ${name}\n---\n# ${sourcePath}\n`
    ])
  );

  await writeFile(catalogPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return {
    catalogPath,
    outputDir,
    fetchImpl: overrides.fetchImpl ?? fixtureFetch(contents),
    concurrency: overrides.concurrency ?? 4,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

test("reads every page from the pinned GitHub URL and verifies its blob SHA", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const result = await extractCatalog(fixture);

  assert.equal(result.pages.length, 24);
  assert.equal(result.pages[0].body.includes("pinned content"), true);
  assert.equal(result.pages[0].body.includes("working tree mutation"), false);
  assert.match(result.pages[0].blob_sha, /^[0-9a-f]{40}$/);
  assert.equal((await readFile(result.pages[0].output_path, "utf8")).includes("# Authored heading"), true);
});

test("refuses duplicate slugs and fewer than 24 pages", async (t) => {
  const duplicateEntries = createEntries();
  duplicateEntries[1] = { ...duplicateEntries[1], slug: duplicateEntries[0].slug };
  const duplicateFixture = await createFixture({ catalog: catalog(duplicateEntries) });
  const shortFixture = await createFixture({ catalog: catalog(createEntries().slice(0, -1)) });
  t.after(duplicateFixture.cleanup);
  t.after(shortFixture.cleanup);

  await assert.rejects(extractCatalog(duplicateFixture), /duplicate slug/);
  await assert.rejects(extractCatalog(shortFixture), /exactly 24/);
});

test("refuses a source commit other than the catalog snapshot", async (t) => {
  const wrongCatalog = catalog();
  wrongCatalog.source_commit = "a".repeat(40);
  const fixture = await createFixture({ catalog: wrongCatalog });
  t.after(fixture.cleanup);

  await assert.rejects(extractCatalog(fixture), /pinned source commit/);
});

test("writes immutable source links and deterministic content", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const first = await extractCatalog(fixture);
  const second = await extractCatalog(fixture);

  assert.equal(first.pages[0].content_digest, second.pages[0].content_digest);
  assert.match(first.pages[0].source_url, /github\.com\/runxhq\/runx\/blob\/[0-9a-f]{40}\//);
  assert.match(first.pages[0].content_digest, /^sha256:[0-9a-f]{64}$/);
});

test("preserves the maintained introduction while removing stale generated pages", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await mkdir(fixture.outputDir, { recursive: true });
  await writeFile(path.join(fixture.outputDir, "introduction.md"), "# Introduction\n", "utf8");
  await writeFile(path.join(fixture.outputDir, "obsolete.md"), "obsolete\n", "utf8");

  await extractCatalog(fixture);

  assert.equal(await readFile(path.join(fixture.outputDir, "introduction.md"), "utf8"), "# Introduction\n");
  await assert.rejects(readFile(path.join(fixture.outputDir, "obsolete.md"), "utf8"), /ENOENT/);
});

test("rewrites source-relative Markdown links to the pinned upstream commit", async (t) => {
  const [firstEntry, secondEntry] = createEntries();
  const fixture = await createFixture({
    firstContent: [
      "---",
      `name: ${firstEntry.name}`,
      "---",
      "[schema](../../schemas/example.json)",
      `[sibling](../${secondEntry.name}/SKILL.md#inputs)`,
      "![diagram](./diagram.png)",
      "[anchor](#local)",
      "[external](https://example.com/docs)",
      "```md",
      "[literal](../not-a-link.md)",
      "```",
      "````md",
      "```md",
      "[four-fence-literal](../also-not-a-link.md)",
      "```",
      "````",
      "",
    ].join("\n"),
  });
  t.after(fixture.cleanup);

  const [page] = (await extractCatalog(fixture)).pages;
  const base = `https://github.com/runxhq/runx/blob/${catalog().source_commit}`;
  assert.match(page.body, new RegExp(`${base}/schemas/example\\.json`));
  assert.match(page.body, new RegExp(`${base}/skills/${secondEntry.name}/SKILL\\.md#inputs`));
  assert.match(page.body, new RegExp(`${base}/skills/${firstEntry.name}/diagram\\.png`));
  assert.match(page.body, /\[anchor\]\(#local\)/);
  assert.match(page.body, /\[external\]\(https:\/\/example\.com\/docs\)/);
  assert.match(page.body, /\[literal\]\(\.\.\/not-a-link\.md\)/);
  assert.match(page.body, /\[four-fence-literal\]\(\.\.\/also-not-a-link\.md\)/);
});

test("retries transient failures without exceeding the configured concurrency cap", async (t) => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const baseFixture = await createFixture();
  t.after(baseFixture.cleanup);
  const retryFixture = {
    ...baseFixture,
    concurrency: 99,
    fetchImpl: async (url) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (calls === 1) return { ok: false, status: 503, async json() { return {}; } };
        await new Promise((resolve) => setTimeout(resolve, 2));
        return baseFixture.fetchImpl(url);
      } finally {
        active -= 1;
      }
    }
  };

  const result = await extractCatalog(retryFixture);

  assert.equal(result.pages.length, 24);
  assert.equal(calls, 25);
  assert.equal(maximumActive <= 4, true);
});

test("stops after three transient status attempts", async (t) => {
  let calls = 0;
  const fixture = await createFixture({
    concurrency: 1,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503, headers: new Headers() };
    }
  });
  t.after(fixture.cleanup);

  await assert.rejects(extractCatalog(fixture), /failed after 3 attempts/);
  assert.equal(calls, 3);
});

test("uses environment tokens only in a redacted authorization header", async (t) => {
  const githubToken = "fixture-github-token";
  const ghToken = "fixture-gh-token";
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const headerChecks = [];
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(url);
    headerChecks.push(options.headers.Authorization === `Bearer ${githubToken}`);
    return fixture.fetchImpl(url, options);
  };

  await withTokenEnvironment({ githubToken, ghToken }, () => extractCatalog({ ...fixture, fetchImpl }));

  assert.equal(headerChecks.length, 24);
  assert.equal(headerChecks.every(Boolean), true);
  assert.equal(urls.every((url) => !url.includes(githubToken) && !url.includes(ghToken)), true);

  const fallbackChecks = [];
  await withTokenEnvironment({ githubToken: undefined, ghToken }, () => extractCatalog({
    ...fixture,
    fetchImpl: async (url, options) => {
      fallbackChecks.push(options.headers.Authorization === `Bearer ${ghToken}`);
      return fixture.fetchImpl(url, options);
    }
  }));
  assert.equal(fallbackChecks.every(Boolean), true);

  const transportFailure = await createFixture({
    fetchImpl: async () => {
      throw new TypeError(`transport failed ${githubToken}`);
    }
  });
  t.after(transportFailure.cleanup);
  const error = await withTokenEnvironment(
    { githubToken, ghToken: undefined },
    () => captureRejection(() => extractCatalog(transportFailure))
  );
  assert.equal(error.message.includes(githubToken), false);
  assert.match(error.message, /REDACTED/);
});

test("identifies rate-limited 403 responses and gives actionable reset guidance", async (t) => {
  let calls = 0;
  const reset = Math.ceil(Date.now() / 1000) + 3600;
  const fixture = await createFixture({
    concurrency: 1,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 403,
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset)
        })
      };
    }
  });
  t.after(fixture.cleanup);

  await assert.rejects(
    extractCatalog(fixture),
    (error) => /rate limit/i.test(error.message)
      && error.message.includes(new Date(reset * 1000).toISOString())
      && /cannot wait more than 30 seconds/i.test(error.message)
      && error.message.includes("GITHUB_TOKEN")
      && error.message.includes("GH_TOKEN")
  );
  assert.equal(calls <= 3, true);
});

test("identifies a secondary rate-limit 403 from Retry-After", async (t) => {
  const fixture = await createFixture({
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: new Headers({ "retry-after": "120" }),
      async json() {
        return { message: "request throttled" };
      }
    })
  });
  t.after(fixture.cleanup);

  await assert.rejects(
    extractCatalog(fixture),
    (error) => /secondary rate limit/i.test(error.message)
      && /120 seconds/i.test(error.message)
      && /cannot wait more than 30 seconds/i.test(error.message)
      && error.message.includes("GITHUB_TOKEN")
      && error.message.includes("GH_TOKEN")
  );
});

test("identifies a secondary rate-limit 403 from its response message", async (t) => {
  const fixture = await createFixture({
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
      async json() {
        return { message: "You have exceeded a secondary rate limit. Please wait a few minutes before retrying." };
      }
    })
  });
  t.after(fixture.cleanup);

  await assert.rejects(
    extractCatalog(fixture),
    (error) => /secondary rate limit/i.test(error.message)
      && /retry later/i.test(error.message)
      && error.message.includes("GITHUB_TOKEN")
      && error.message.includes("GH_TOKEN")
  );
});

test("rejects non-canonical base64 that decodes to valid bytes", async (t) => {
  const fixture = await createFixture({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          type: "file",
          encoding: "base64",
          content: "Zh==",
          sha: blobSha("f")
        };
      }
    })
  });
  t.after(fixture.cleanup);

  await assert.rejects(extractCatalog(fixture), /canonical base64/);
});

test("rejects valid base64 when the returned blob SHA does not match", async (t) => {
  const fixture = await createFixture({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from("valid content", "utf8").toString("base64"),
          sha: "0".repeat(40)
        };
      }
    })
  });
  t.after(fixture.cleanup);

  await assert.rejects(extractCatalog(fixture), /blob SHA mismatch/);
});

test("accepts exactly 1 MiB and rejects 1 MiB plus one byte", async (t) => {
  const exactContent = Buffer.alloc(1024 * 1024, 0x61);
  const exactFixture = await createFixture({
    fetchImpl: async (url) => sourceResponse(url.includes("/skills/agency/") ? exactContent : "small\n")
  });
  t.after(exactFixture.cleanup);
  const exactResult = await extractCatalog(exactFixture);
  assert.equal(exactResult.pages.length, 24);

  const oversizedFixture = await createFixture({
    fetchImpl: async () => sourceResponse(Buffer.alloc(1024 * 1024 + 1, 0x61))
  });
  t.after(oversizedFixture.cleanup);
  await assert.rejects(extractCatalog(oversizedFixture), /exceeds 1 MiB/);
});

test("atomically replaces an expected page symlink without writing its target", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const externalPath = path.join(path.dirname(fixture.outputDir), "external-expected.md");
  const expectedPath = path.join(fixture.outputDir, "agency.md");
  await mkdir(fixture.outputDir, { recursive: true });
  await writeFile(externalPath, "outside expected\n", "utf8");
  await symlink(externalPath, expectedPath);

  await extractCatalog(fixture);

  assert.equal(await readFile(externalPath, "utf8"), "outside expected\n");
  assert.equal((await lstat(expectedPath)).isSymbolicLink(), false);
  assert.match(await readFile(expectedPath, "utf8"), /pinned content/);
});

test("removes a stale page symlink without removing or changing its target", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const externalPath = path.join(path.dirname(fixture.outputDir), "external-stale.md");
  const stalePath = path.join(fixture.outputDir, "obsolete.md");
  await mkdir(fixture.outputDir, { recursive: true });
  await writeFile(externalPath, "outside stale\n", "utf8");
  await symlink(externalPath, stalePath);

  await extractCatalog(fixture);

  assert.equal(await readFile(externalPath, "utf8"), "outside stale\n");
  await assert.rejects(lstat(stalePath), /ENOENT/);
});

test("rejects a symlink output directory without touching its target", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const targetDir = path.join(path.dirname(fixture.outputDir), "outside-pages");
  const staleTarget = path.join(targetDir, "obsolete.md");
  await mkdir(targetDir, { recursive: true });
  await writeFile(staleTarget, "outside directory\n", "utf8");
  await symlink(targetDir, fixture.outputDir);

  await assert.rejects(extractCatalog(fixture), /output directory.*symbolic link/i);

  assert.deepEqual(await readdir(targetDir), ["obsolete.md"]);
  assert.equal(await readFile(staleTarget, "utf8"), "outside directory\n");
});

test("preserves leading thematic-break Markdown that is not source frontmatter", async (t) => {
  const thematicBreak = "---\n\nAuthored prose between thematic breaks.\n\n---\n\n# Authored heading\n";
  const fixture = await createFixture({ fetchImpl: async () => sourceResponse(thematicBreak) });
  t.after(fixture.cleanup);

  const result = await extractCatalog(fixture);

  assert.equal(result.pages[0].body.includes(thematicBreak), true);
});

test("rejects malformed source frontmatter instead of deleting authored text", async (t) => {
  const malformed = "---\nname: agency\nthis is not a mapping\n---\n# Authored heading\n";
  const fixture = await createFixture({ fetchImpl: async () => sourceResponse(malformed) });
  t.after(fixture.cleanup);

  await assert.rejects(extractCatalog(fixture), /malformed YAML frontmatter/);
});

test("rejects frontmatter with real YAML syntax errors", async (t) => {
  const fixture = await createFixture({
    fetchImpl: async (url) => {
      const skillName = /\/skills\/([^/]+)\/SKILL\.md/.exec(new URL(url).pathname)[1];
      return sourceResponse(`---\nname: ${skillName}\ndescription: \"unterminated\n---\n# Authored heading\n`);
    }
  });
  t.after(fixture.cleanup);

  await assert.rejects(extractCatalog(fixture), /malformed YAML frontmatter/);
});

test("rejects a non-canonical name even when count and shape are valid", async (t) => {
  const entries = createEntries();
  entries[0] = {
    name: "agency-copy",
    slug: "agency-copy",
    group: "Operate",
    path: "skills/agency-copy/SKILL.md"
  };
  const fixture = await createFixture({
    catalog: catalog(entries),
    fetchImpl: async () => sourceResponse("# source\n")
  });
  t.after(fixture.cleanup);

  await assert.rejects(extractCatalog(fixture), /canonical name/);
});

test("requires every slug to equal its canonical name", async (t) => {
  const entries = createEntries();
  entries[0] = { ...entries[0], slug: "agency-copy" };
  const fixture = await createFixture({
    catalog: catalog(entries),
    fetchImpl: async () => sourceResponse("# source\n")
  });
  t.after(fixture.cleanup);

  await assert.rejects(extractCatalog(fixture), /slug must equal name/);
});

test("requires the exact canonical groups and memberships", async (t) => {
  const entries = createEntries().map((entry) => ({ ...entry, group: "Operate" }));
  const fixture = await createFixture({
    catalog: {
      source_repository: "https://github.com/runxhq/runx",
      source_commit: sourceCommit,
      groups: [{ name: "Operate", entries }]
    },
    fetchImpl: async () => sourceResponse("# source\n")
  });
  t.after(fixture.cleanup);

  await assert.rejects(extractCatalog(fixture), /canonical groups/);
});

test("rejects malformed content, blob mismatches, and stale generated pages", async (t) => {
  const malformedFixture = await createFixture({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { type: "file", encoding: "base64", content: "not valid!", sha: "0".repeat(40) };
      }
    })
  });
  t.after(malformedFixture.cleanup);
  await assert.rejects(extractCatalog(malformedFixture), /base64/);

  const staleFixture = await createFixture();
  t.after(staleFixture.cleanup);
  await mkdir(staleFixture.outputDir, { recursive: true });
  await writeFile(path.join(staleFixture.outputDir, "obsolete.md"), "obsolete\n", "utf8");
  await extractCatalog(staleFixture);
  await assert.rejects(readFile(path.join(staleFixture.outputDir, "obsolete.md"), "utf8"), /ENOENT/);
});
