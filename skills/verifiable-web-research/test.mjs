import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillRoot = path.dirname(fileURLToPath(import.meta.url));

test("emits an audit-ready packet and writes requested artifacts", () => {
  const outputDir = `out-test-${Date.now()}`;
  const result = runSkill({
    objective: "Compare AI agent framework evidence",
    source_fixture_path: "fixtures/ai-agent-frameworks.json",
    verification_level: "audit_ready",
    output_dir: outputDir,
  });

  assert.equal(result.status, 0, result.stderr);

  const packet = JSON.parse(result.stdout);
  assert.equal(packet.schema, "runx.verifiable_web_research.result.v1");
  assert.equal(packet.data.claims.length, 2);
  assert.equal(packet.data.evidence_archive.sources.length, 2);
  assert.match(packet.data.claims[0].content_digest, /^sha256:/);

  assert.equal(fs.existsSync(path.join(skillRoot, outputDir, "evidence.json")), true);
  assert.equal(fs.existsSync(path.join(skillRoot, outputDir, "report.md")), true);

  fs.rmSync(path.join(skillRoot, outputDir), { recursive: true, force: true });
});

test("rejects extracts that are not present in captured source content", () => {
  const fixturePath = path.join("fixtures", `invalid-${Date.now()}.json`);
  const fixtureAbsolutePath = path.join(skillRoot, fixturePath);
  fs.writeFileSync(fixtureAbsolutePath, JSON.stringify({
    sources: [{
      url: "https://example.org/invalid",
      final_url: "https://example.org/invalid",
      fetched_at: "2026-06-22T00:00:00Z",
      status: 200,
      content: "The captured body contains a different sentence.",
      extracts: [{
        claim: "This claim should be rejected.",
        quote: "This quote is absent.",
      }],
    }],
  }));

  try {
    const result = runSkill({
      objective: "Reject invalid extracts",
      source_fixture_path: fixturePath,
      verification_level: "detailed",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /quote must appear in content/);
  } finally {
    fs.rmSync(fixtureAbsolutePath, { force: true });
  }
});

test("supports the built-in publish harness fixture", () => {
  const result = runSkill({
    objective: "Compare built-in AI agent framework evidence",
    source_fixture_path: "builtin:ai-agent-frameworks",
    verification_level: "audit_ready",
    max_claims: 2,
  });

  assert.equal(result.status, 0, result.stderr);

  const packet = JSON.parse(result.stdout);
  assert.equal(packet.data.fixture.ref, "builtin:ai-agent-frameworks");
  assert.equal(packet.data.claims.length, 2);
});

test("declares publish harness coverage for happy and stop/error paths", () => {
  const manifest = fs.readFileSync(path.join(skillRoot, "X.yaml"), "utf8");

  assert.match(manifest, /harness:\s*\n\s*cases:/);
  assert.match(manifest, /name:\s*verifiable-web-research-audit-ready-packet/);
  assert.match(manifest, /name:\s*verifiable-web-research-missing-fixture-fails/);
});

function runSkill(inputs) {
  return spawnSync(process.execPath, ["run.mjs"], {
    cwd: skillRoot,
    env: {
      ...process.env,
      RUNX_INPUTS_JSON: JSON.stringify(inputs),
    },
    encoding: "utf8",
  });
}
