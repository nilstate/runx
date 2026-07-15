import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildSbomResult,
  fetchSource,
  finalizeStoredResult,
  normalizeSourceHandle,
} from "./runtime/run.mjs";

const packageLock = {
  name: "fixture-app",
  version: "1.2.3",
  lockfileVersion: 3,
  packages: {
    "": { name: "fixture-app", version: "1.2.3", license: "MIT" },
    "node_modules/@scope/alpha": { version: "2.0.0", license: "Apache-2.0" },
    "node_modules/beta": { version: "3.1.0", license: "GPL-3.0-only" },
    "node_modules/gamma": { version: "4.0.0" },
  },
};

test("normalizes a pinned raw GitHub source", () => {
  const source = normalizeSourceHandle(
    "https://raw.githubusercontent.com/example/project/0123456789abcdef/package-lock.json",
  );

  assert.equal(source.kind, "https");
  assert.equal(source.host, "raw.githubusercontent.com");
});

test("rejects unapproved source hosts", () => {
  assert.throws(
    () => normalizeSourceHandle("https://example.com/package-lock.json"),
    /source host is not allowed/u,
  );
});

test("normalizes a pinned GitHub contents API source", () => {
  const source = normalizeSourceHandle(
    "https://api.github.com/repos/example/project/contents/package-lock.json?ref=0123456789abcdef",
  );

  assert.equal(source.kind, "github_contents");
  assert.equal(source.commit, "0123456789abcdef");
});

test("fetches a bounded HTTPS source and records provenance", async () => {
  const body = JSON.stringify(packageLock);
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(body.length) },
  });

  const read = await fetchSource(
    "https://raw.githubusercontent.com/example/project/0123456789abcdef/package-lock.json",
    { fetchImpl: async () => response, now: () => "2026-07-15T10:00:00.000Z" },
  );

  assert.equal(read.status, 200);
  assert.equal(read.fetched_at, "2026-07-15T10:00:00.000Z");
  assert.match(read.content_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(read.content, body);
});

test("refuses an unreachable source", async () => {
  await assert.rejects(
    () => fetchSource(
      "https://raw.githubusercontent.com/example/project/0123456789abcdef/package-lock.json",
      {
        fetchImpl: async () => { throw new Error("network unavailable"); },
        delay: async () => {},
      },
    ),
    /source read failed after 3 attempts: network unavailable/u,
  );
});

test("retries a transient source read failure", async () => {
  const body = JSON.stringify(packageLock);
  let attempts = 0;
  const read = await fetchSource(
    "https://raw.githubusercontent.com/example/project/0123456789abcdef/package-lock.json",
    {
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary reset");
        return new Response(body, { status: 200 });
      },
      delay: async () => {},
    },
  );

  assert.equal(attempts, 2);
  assert.equal(read.status, 200);
});

test("decodes a GitHub contents API response as the source file", async () => {
  const body = JSON.stringify(packageLock);
  const apiResponse = {
    type: "file",
    encoding: "base64",
    content: Buffer.from(body).toString("base64"),
    sha: "a".repeat(40),
    html_url: "https://github.com/example/project/blob/0123456789abcdef/package-lock.json",
  };

  const read = await fetchSource(
    "https://api.github.com/repos/example/project/contents/package-lock.json?ref=0123456789abcdef",
    { fetchImpl: async () => new Response(JSON.stringify(apiResponse), { status: 200 }) },
  );

  assert.equal(read.content, body);
  assert.equal(read.source_kind, "github_contents");
  assert.equal(read.blob_sha, "a".repeat(40));
  assert.equal(read.repository_file_url, apiResponse.html_url);
});

test("builds a grounded CycloneDX SBOM and an addressable storage event", () => {
  const result = buildSbomResult({
    sourceHandle: "fixture://supported-package-lock.json",
    lockfileType: "package-lock",
    content: JSON.stringify(packageLock),
    contentDigest: "sha256:fixture",
    fetchedAt: "2026-07-15T10:00:00.000Z",
    bytes: 321,
    status: 200,
  });

  assert.equal(result.sbom.bomFormat, "CycloneDX");
  assert.equal(result.sbom.metadata.component.name, "fixture-app");
  assert.equal(result.components.length, 3);
  assert.deepEqual(
    result.components.map((component) => component.name),
    ["@scope/alpha", "beta", "gamma"],
  );
  assert.equal(result.components[0].evidence_location, 'packages["node_modules/@scope/alpha"]');
  assert.equal(result.license_summary.license_counts.UNKNOWN, 1);
  assert.equal(result.license_risks[0].component, "beta");
  assert.equal(result.storage_event.type, "sbom.generated");
  assert.equal(result.stored_artifact_ref.aggregate_id, "fixture-app@1.2.3");
  assert.match(result.stored_artifact_ref.idempotency_key, /^sbom:fixture-app@1\.2\.3:sha256:fixture$/u);
});

test("refuses malformed and unsupported lockfiles", () => {
  assert.throws(
    () => buildSbomResult({
      sourceHandle: "fixture://malformed-lockfile.json",
      lockfileType: "package-lock",
      content: '{"invalid":true}',
      contentDigest: "sha256:bad",
      fetchedAt: "2026-07-15T10:00:00.000Z",
      bytes: 16,
      status: 200,
    }),
    /lockfile has no dependency map/u,
  );

  assert.throws(
    () => buildSbomResult({
      sourceHandle: "fixture://supported-package-lock.json",
      lockfileType: "yarn",
      content: JSON.stringify(packageLock),
      contentDigest: "sha256:fixture",
      fetchedAt: "2026-07-15T10:00:00.000Z",
      bytes: 321,
      status: 200,
    }),
    /unsupported lockfile_type/u,
  );
});

test("walks classic package-lock dependencies with grounded nested locations", () => {
  const result = buildSbomResult({
    sourceHandle: "fixture://classic-package-lock.json",
    lockfileType: "npm-shrinkwrap",
    content: JSON.stringify({
      name: "classic-app",
      version: "0.8.0",
      lockfileVersion: 1,
      dependencies: {
        alpha: {
          version: "1.0.0",
          license: "MIT",
          dependencies: { beta: { version: "2.0.0", license: "BSD-3-Clause" } },
        },
      },
    }),
    contentDigest: "sha256:classic",
    fetchedAt: "2026-07-15T10:00:00.000Z",
    bytes: 250,
    status: 200,
  });

  assert.deepEqual(result.components.map((component) => component.name), ["alpha", "beta"]);
  assert.equal(
    result.components[1].evidence_location,
    'dependencies["alpha"].dependencies["beta"]',
  );
});

test("keeps the stored event deterministic for the same source digest", () => {
  const base = {
    sourceHandle: "fixture://supported-package-lock.json",
    lockfileType: "package-lock",
    content: JSON.stringify(packageLock),
    contentDigest: "sha256:fixture",
    bytes: 321,
    status: 200,
  };

  const first = buildSbomResult({ ...base, fetchedAt: "2026-07-15T10:00:00.000Z" });
  const second = buildSbomResult({ ...base, fetchedAt: "2026-07-15T11:00:00.000Z" });

  assert.deepEqual(first.storage_event, second.storage_event);
});

test("finalizes only a committed event that was read back", () => {
  const generated = buildSbomResult({
    sourceHandle: "fixture://supported-package-lock.json",
    lockfileType: "package-lock",
    content: JSON.stringify(packageLock),
    contentDigest: "sha256:fixture",
    fetchedAt: "2026-07-15T10:00:00.000Z",
    bytes: 321,
    status: 200,
  });
  const eventRef = "software_boms:fixture-app@1.2.3:1";
  const appendResult = {
    status: "committed",
    event_ref: eventRef,
    after_version: 1,
    provider: "sqlite-event-store",
    provider_evidence: { adapter: "data.sqlite", storage_class: "sqlite" },
  };
  const readbackResult = {
    status: "read",
    events: [{
      event_ref: eventRef,
      event_type: "sbom.generated",
      idempotency_key: generated.stored_artifact_ref.idempotency_key,
      event: generated.storage_event,
    }],
  };

  const result = finalizeStoredResult({ generated, appendResult, readbackResult });
  assert.equal(result.stored_artifact_ref.event_ref, eventRef);
  assert.equal(result.stored_artifact_ref.storage_class, "sqlite");
  assert.equal(result.stored_artifact_ref.readback_verified, true);
});

test("refuses to finalize a conflicted append", () => {
  assert.throws(
    () => finalizeStoredResult({
      generated: { stored_artifact_ref: { idempotency_key: "key" } },
      appendResult: { status: "conflict" },
      readbackResult: { events: [] },
    }),
    /append did not commit/u,
  );
});

test("runs from the sidecars retained by registry publishing", () => {
  const packageRoot = new URL(".", import.meta.url).pathname;
  const stagedRoot = mkdtempSync(join(tmpdir(), "sbom-maker-published-"));

  try {
    for (const relative of registryPublishableFiles(packageRoot)) {
      const destination = join(stagedRoot, relative);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(packageRoot, relative), destination);
    }

    const execution = spawnSync(process.execPath, ["run.mjs"], {
      cwd: stagedRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNX_INPUTS_JSON: JSON.stringify({
          source_handle: "fixture://supported-package-lock.json",
          lockfile_type: "package-lock",
          data_source_ref: "local://sbom-maker/harness",
          store_id: "sbom-maker-publish-layout",
        }),
      },
    });

    assert.equal(execution.status, 0, execution.stderr);
    const output = JSON.parse(execution.stdout);
    assert.equal(output.sbom_result.sbom.metadata.component.name, "fixture-app");
  } finally {
    rmSync(stagedRoot, { recursive: true, force: true });
  }
});

function registryPublishableFiles(root) {
  const excludedDirectories = new Set([
    ".git",
    ".runx",
    "assets",
    "dist",
    "fixtures",
    "node_modules",
    "src",
    "target",
  ]);
  const nestedFileNames = new Set([
    "SKILL.md",
    "X.yaml",
    "manifest.json",
    "run.mjs",
    "run.js",
    "harness.mjs",
    "harness.js",
  ]);
  const files = ["SKILL.md", "X.yaml", "run.mjs", "finalize.mjs"];

  for (const entry of readdirSync(root, { recursive: true })) {
    const relative = String(entry);
    const segments = relative.split("/");
    if (segments.some((segment) => excludedDirectories.has(segment))) continue;
    if (!statSync(join(root, relative)).isFile()) continue;
    if (segments.length > 1 && nestedFileNames.has(segments.at(-1))) files.push(relative);
  }

  return [...new Set(files)].sort();
}
