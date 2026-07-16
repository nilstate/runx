import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyCatalog } from "./verify.mjs";

const sourceCommit = "5afc25a83edf1c1320df7ac0d78c36f1523b5677";
const slugs = Array.from({ length: 24 }, (_, index) => `skill-${index + 1}`);

async function createFixture(t, mutate = async () => {}) {
  const catalogDir = await mkdtemp(path.join(tmpdir(), "sourcey-verify-"));
  t.after(() => rm(catalogDir, { recursive: true, force: true }));
  await mkdir(path.join(catalogDir, "pages"));
  await mkdir(path.join(catalogDir, "site", "pages"), { recursive: true });

  const entries = slugs.map((slug) => ({
    name: slug,
    slug,
    group: "Fixture",
    path: `skills/${slug}/SKILL.md`,
  }));
  const catalog = {
    source_repository: "https://github.com/runxhq/runx",
    source_commit: sourceCommit,
    groups: [{ name: "Fixture", entries }],
  };
  await writeFile(path.join(catalogDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(path.join(catalogDir, "pages", "introduction.md"), "# Introduction\n");

  const navigation = slugs
    .map((slug) => `<a href="pages/${slug}.html">${slug}</a>`)
    .join("");
  await writeFile(path.join(catalogDir, "site", "index.html"), html(navigation));
  for (const entry of entries) {
    const sourceUrl = `${catalog.source_repository}/blob/${sourceCommit}/${entry.path}`;
    const markdown = [
      `# ${entry.slug}`,
      "",
      `- Source: [${entry.path}](${sourceUrl})`,
      `- Commit: \`${sourceCommit}\``,
      "",
      "Maintainer documentation.",
      "",
    ].join("\n");
    await writeFile(path.join(catalogDir, "pages", `${entry.slug}.md`), markdown);
    await writeFile(
      path.join(catalogDir, "site", "pages", `${entry.slug}.html`),
      pageHtml(`<a href="${sourceUrl}">Source</a><a href="#details">Details</a><h2 id="details">Details</h2>`),
    );
  }

  const search = [
    { title: "Introduction", url: "/runxhq/runx/pages/introduction.html", category: "Pages" },
    ...slugs.map((slug) => ({
      title: slug,
      url: `/runxhq/runx/pages/${slug}.html`,
      category: "Pages",
    })),
  ];
  await writeFile(path.join(catalogDir, "site", "search-index.json"), `${JSON.stringify(search)}\n`);
  await writeFile(path.join(catalogDir, "site", "llms.txt"), "catalog\n");
  await writeFile(path.join(catalogDir, "site", "llms-full.txt"), "full catalog\n");
  await writeFile(path.join(catalogDir, "site", "sourcey.css"), "body {}\n");
  await writeFile(path.join(catalogDir, "site", "sourcey.js"), "export {};\n");
  await writeFile(path.join(catalogDir, "site", "pages", "introduction.html"), pageHtml("Introduction"));

  await mutate(catalogDir);
  return { catalogDir };
}

function html(body) {
  return `<!doctype html><html><head><link href="sourcey.css"></head><body>${body}<script src="sourcey.js"></script></body></html>`;
}

function pageHtml(body) {
  return `<!doctype html><html><head><link href="../sourcey.css"></head><body>${body}<script src="../sourcey.js"></script></body></html>`;
}

test("rejects a missing page, absent source link, and broken local href", async (t) => {
  const missingPageFixture = await createFixture(t, (catalogDir) =>
    rm(path.join(catalogDir, "pages", `${slugs[0]}.md`))
  );
  const noSourceFixture = await createFixture(t, async (catalogDir) => {
    const pagePath = path.join(catalogDir, "pages", `${slugs[0]}.md`);
    const page = await readFile(pagePath, "utf8");
    await writeFile(pagePath, page.replace("/blob/", "/tree/"));
  });
  const brokenHrefFixture = await createFixture(t, async (catalogDir) => {
    const pagePath = path.join(catalogDir, "site", "pages", `${slugs[0]}.html`);
    const page = await readFile(pagePath, "utf8");
    await writeFile(pagePath, page.replace("</body>", '<a href="missing.html">Missing</a></body>'));
  });

  await assert.rejects(verifyCatalog(missingPageFixture), /missing generated page/);
  await assert.rejects(verifyCatalog(noSourceFixture), /immutable source link/);
  await assert.rejects(verifyCatalog(brokenHrefFixture), /broken local link/);
});

test("rejects an unpinned commit, broken fragment, and broken src", async (t) => {
  const wrongCommit = await createFixture(t, async (catalogDir) => {
    const catalogPath = path.join(catalogDir, "catalog.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    catalog.source_commit = "a".repeat(40);
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  });
  const brokenFragment = await createFixture(t, async (catalogDir) => {
    const pagePath = path.join(catalogDir, "site", "pages", `${slugs[0]}.html`);
    const page = await readFile(pagePath, "utf8");
    await writeFile(pagePath, page.replace("#details", "#missing-anchor"));
  });
  const brokenSrc = await createFixture(t, async (catalogDir) => {
    const pagePath = path.join(catalogDir, "site", "pages", `${slugs[0]}.html`);
    const page = await readFile(pagePath, "utf8");
    await writeFile(pagePath, page.replace("</body>", '<img src="missing.png"></body>'));
  });

  await assert.rejects(verifyCatalog(wrongCommit), /pinned source commit/);
  await assert.rejects(verifyCatalog(brokenFragment), /broken local link/);
  await assert.rejects(verifyCatalog(brokenSrc), /broken local link/);
});

test("requires all 24 pages in navigation and search", async (t) => {
  const validFixture = await createFixture(t);
  const result = await verifyCatalog(validFixture);

  assert.equal(result.coverage.markdown_pages, 24);
  assert.equal(result.coverage.html_pages, 24);
  assert.equal(result.coverage.navigation_pages, 24);
  assert.equal(result.coverage.search_pages, 24);
  assert.deepEqual(result.broken_links, []);
});

test("rejects missing llms artifacts, credential-like content, and missing coverage", async (t) => {
  const missingLlms = await createFixture(t, (catalogDir) =>
    writeFile(path.join(catalogDir, "site", "llms.txt"), "")
  );
  const credentialLeak = await createFixture(t, (catalogDir) =>
    writeFile(path.join(catalogDir, "site", "sourcey.js"), "const token = 'ghp_example';\n")
  );
  const missingNavigation = await createFixture(t, async (catalogDir) => {
    const indexPath = path.join(catalogDir, "site", "index.html");
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, index.replace(`<a href="pages/${slugs[0]}.html">${slugs[0]}</a>`, ""));
  });
  const missingSearch = await createFixture(t, async (catalogDir) => {
    const searchPath = path.join(catalogDir, "site", "search-index.json");
    const search = JSON.parse(await readFile(searchPath, "utf8"));
    await writeFile(searchPath, `${JSON.stringify(search.filter(({ title }) => title !== slugs[0]))}\n`);
  });

  await assert.rejects(verifyCatalog(missingLlms), /missing or empty llms artifact/);
  await assert.rejects(verifyCatalog(credentialLeak), /credential-like string/);
  await assert.rejects(verifyCatalog(missingNavigation), /navigation coverage/);
  await assert.rejects(verifyCatalog(missingSearch), /search coverage/);
});

test("returns the same packet for unchanged inputs", async (t) => {
  const fixture = await createFixture(t);

  assert.deepEqual(await verifyCatalog(fixture), await verifyCatalog(fixture));
});

test("recognizes structured output headings and emits only grounded gaps", async (t) => {
  const fixture = await createFixture(t, async (catalogDir) => {
    for (const slug of slugs) {
      const pagePath = path.join(catalogDir, "pages", `${slug}.md`);
      const page = await readFile(pagePath, "utf8");
      await writeFile(pagePath, `${page}\n## Structured Output\n\nDocumented fields.\n`);
    }
  });

  const result = await verifyCatalog(fixture);

  assert.equal(result.gaps.some(({ id }) => id === "missing-output-contracts"), false);
  assert.equal(result.gaps.every(({ affected_paths: affectedPaths }) => affectedPaths.length > 0), true);
});
