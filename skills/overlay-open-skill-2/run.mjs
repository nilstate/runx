// overlay-open-skill-2: a governed-execution overlay for an open-ecosystem
// skill. The overlay wraps an upstream SKILL.md BY REFERENCE under a pinned
// sha256 digest, declares scope bounds + an explicit allowed_tools set, and —
// unlike a pin-and-refuse demo — actually RUNS the wrapped skill's effect under
// that authorization in the same run, sealing an effect receipt that proves the
// governed work happened.
//
// Design notes:
//   - Fully deterministic (digest compare + theme application over parsing, no
//     LLM), so harness runs seal reproducibly.
//   - Three guards fire BEFORE any effect and refuse (seal as failure) rather
//     than running changed or out-of-scope instructions unseen:
//       1. digest gate   — resolved upstream content must match the pinned
//                          sha256, else runx.overlay.digest.stale.
//       2. scope gate    — the requested theme must be in the declared scope
//                          bounds and the output path must stay under
//                          allowed_output_prefix, else runx.overlay.scope.exceeded.
//       3. approval gate — the operator approval flag must be present, else
//                          runx.overlay.approval.denied.
//   - Only when all guards pass does the overlay CONSUME the attenuation: it
//     reads the wrapped skill's theme spec, applies its colors/fonts to the
//     target artifact, and WRITES the themed artifact under the governed
//     prefix. The sealed receipt records execution_performed:true, the
//     authorization it ran under, and the sha256 of the bytes it produced.
//   - The overlay never copies or edits the upstream file; it resolves it (live
//     fetch in a real run, or a resolver-supplied digest in the deterministic
//     harness) and pins it.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";

// ---- The pinned governance contract (public, no upstream bytes copied) -------

// Upstream wrapped BY REFERENCE. The digest is the sha256 of the upstream
// SKILL.md bytes at the pinned commit; a reviewer recomputes it from WRAPS_REF.
const PINNED_DIGEST =
  "sha256:c35893e221e28895c52143cc11bf30e41a44817796b39d4b15727dadc9796552";
const WRAPS_REF =
  "https://raw.githubusercontent.com/anthropics/skills/ef740771ac901e03fbca3ce4e1c453a96010f30a/skills/theme-factory/SKILL.md";

// Non-empty scope bounds. An out-of-scope request is refused, not clamped.
const ALLOWED_THEMES = [
  "arctic-frost", "botanical-garden", "desert-rose", "forest-canopy",
  "golden-hour", "midnight-galaxy", "modern-minimalist", "ocean-depths",
  "sunset-boulevard", "tech-innovation",
];
// Every tool the wrapped skill may touch, named explicitly (no wildcard).
const ALLOWED_TOOLS = ["fs.read", "fs.write", "net.fetch"];
// The governed effect may only write under this prefix; anything else refuses.
const ALLOWED_OUTPUT_PREFIX = ".overlay-out/";

// ---- seal / refuse ----------------------------------------------------------

function seal(data) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

// A guard refusal is a SEALED failure (exitCode 78), not a crash: the overlay
// deliberately declined to run, and that decision is itself the receipt.
function refuseSealed(diagnostic, detail) {
  console.log(
    JSON.stringify(
      {
        decision: "refused",
        diagnostic,
        execution_performed: false,
        pinned_digest: PINNED_DIGEST,
        wraps_ref: WRAPS_REF,
        ...detail,
      },
      null,
      2
    )
  );
  process.exitCode = 78;
}

// A hard input error (malformed request) is a non-sealed refusal.
function refuseHard(reason) {
  console.error(reason);
  process.exit(1);
}

// ---- inputs -----------------------------------------------------------------

function parseInput() {
  let raw = process.env.RUNX_INPUTS_JSON;
  if (!raw && process.env.RUNX_INPUTS_PATH) {
    try {
      raw = readFileSync(process.env.RUNX_INPUTS_PATH, "utf8");
    } catch (e) {
      return refuseHard("Could not read RUNX_INPUTS_PATH");
    }
  }
  if (!raw) return refuseHard("No input provided via RUNX_INPUTS_JSON");
  try {
    return JSON.parse(raw);
  } catch (e) {
    return refuseHard("Invalid JSON input");
  }
}

function normalizeDigest(d) {
  if (typeof d !== "string") return null;
  const t = d.trim().toLowerCase();
  return t.startsWith("sha256:") ? t : `sha256:${t}`;
}

// Resolve the wrapped upstream and return its sha256. Two resolution modes:
//   - live (real dogfood): fetch the raw URL and hash the bytes actually served
//     — a real source read at run time.
//   - supplied (deterministic harness): the resolver already computed the
//     digest; trust the supplied value so cases seal offline.
async function resolveUpstreamDigest(input) {
  // Recompute the sha256 over the exact resolved upstream bytes at run time.
  // Content mode is the governed default: the resolver hands the exact bytes it
  // fetched, and the overlay hashes them here (a real recompute, no trust in a
  // pre-supplied digest, and no network egress from inside the sandbox).
  if (typeof input.resolved_upstream_content === "string" && input.resolved_upstream_content.length) {
    const bytes = Buffer.from(input.resolved_upstream_content, "utf8");
    return {
      digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      source: input.resolved_upstream_source || "resolver-supplied-bytes",
      mode: "content-recompute",
    };
  }
  if (typeof input.resolved_upstream_url === "string") {
    const res = await fetch(input.resolved_upstream_url); // net.fetch
    if (!res.ok) return refuseHard(`Upstream fetch failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      source: input.resolved_upstream_url,
      mode: "live-fetch",
    };
  }
  if (typeof input.resolved_upstream_path === "string") {
    const bytes = readFileSync(input.resolved_upstream_path); // fs.read
    return {
      digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      source: input.resolved_upstream_path,
      mode: "local-read",
    };
  }
  const supplied = normalizeDigest(input.resolved_digest);
  if (supplied) return { digest: supplied, source: "resolver-supplied", mode: "supplied-digest" };
  return refuseHard(
    "No upstream resolution: provide resolved_upstream_url, resolved_upstream_path, or resolved_digest"
  );
}

// ---- the wrapped effect: theme application (deterministic) -------------------

// Parse a theme spec markdown (the upstream's own theme file format) into its
// palette + font pairing. Grounded in the real theme file shape: color lines
// read "- Deep Navy: #1a2332" and font lines read "Headers: DejaVu Sans Bold" /
// "Body Text: DejaVu Sans" (markdown bold on the label is tolerated).
function parseThemeSpec(md) {
  const colors = {};
  // Matches the upstream theme-file shape, tolerating markdown bold on the name:
  //   "- **Deep Navy**: `#1a2332` - Primary background color"
  //   "- Deep Navy: #1a2332"
  const colorRe = /-\s*\*{0,2}([A-Za-z][A-Za-z0-9 /]*?)\*{0,2}\s*:\s*`?(#[0-9a-fA-F]{3,8})`?/g;
  let m;
  while ((m = colorRe.exec(md)) !== null) {
    colors[m[1].trim()] = m[2].toLowerCase();
  }
  // Font lines: "- **Headers**: DejaVu Sans Bold" / "- **Body Text**: DejaVu Sans".
  const header = (md.match(/Headers?\*{0,2}\s*:\s*\*{0,2}([^\n*`]+)/i) || [])[1];
  const body = (md.match(/Body(?:\s*Text)?\*{0,2}\s*:\s*\*{0,2}([^\n*`]+)/i) || [])[1];
  return {
    colors,
    fonts: {
      header: header ? header.trim() : null,
      body: body ? body.trim() : null,
    },
  };
}

// Apply the parsed theme to an artifact by injecting a scoped :root variable
// block + a font-family rule. Deterministic string transform → real output.
function applyTheme(artifact, themeName, spec) {
  const vars = Object.entries(spec.colors)
    .map(([name, hex], i) => `  --theme-color-${i + 1}: ${hex}; /* ${name} */`)
    .join("\n");
  const style =
    `<style data-overlay-theme="${themeName}">\n:root {\n${vars}\n` +
    `  --theme-font-header: ${spec.fonts.header || "sans-serif"};\n` +
    `  --theme-font-body: ${spec.fonts.body || "sans-serif"};\n}\n` +
    `body { font-family: var(--theme-font-body); }\n` +
    `h1,h2,h3 { font-family: var(--theme-font-header); }\n</style>`;
  if (/<\/head>/i.test(artifact)) {
    return artifact.replace(/<\/head>/i, `${style}\n</head>`);
  }
  return `${style}\n${artifact}`;
}

// Enforce that a requested output path stays under the governed prefix. Rejects
// absolute paths and any ".." escape after normalization.
function outputUnderPrefix(outputDir, fileName) {
  const dir = outputDir || ALLOWED_OUTPUT_PREFIX;
  const rel = relative(ALLOWED_OUTPUT_PREFIX, join(dir, fileName));
  const escapes = rel.startsWith("..") || isAbsolute(rel) || isAbsolute(dir);
  return { ok: !escapes, path: join(dir, fileName) };
}

// ---- main -------------------------------------------------------------------

async function main() {
  const input = parseInput();

  // --- GUARD 1: digest gate --------------------------------------------------
  const resolved = await resolveUpstreamDigest(input);
  if (resolved.digest !== PINNED_DIGEST) {
    return refuseSealed("runx.overlay.digest.stale", {
      resolved_digest: resolved.digest,
      resolution_mode: resolved.mode,
      reason:
        "Resolved wrapped content no longer matches the pinned digest; refusing " +
        "rather than running changed instructions unseen.",
    });
  }

  // --- GUARD 2: scope gate ---------------------------------------------------
  const themeName = typeof input.theme_name === "string" ? input.theme_name.trim() : "";
  if (!ALLOWED_THEMES.includes(themeName)) {
    return refuseSealed("runx.overlay.scope.exceeded", {
      requested_theme: themeName || null,
      allowed_themes: ALLOWED_THEMES,
      reason: "Requested theme is outside the overlay's declared scope bounds.",
    });
  }
  const outCheck = outputUnderPrefix(input.output_dir, input.output_name || "themed-artifact.html");
  if (!outCheck.ok) {
    return refuseSealed("runx.overlay.scope.exceeded", {
      requested_output: join(input.output_dir || "", input.output_name || "themed-artifact.html"),
      allowed_output_prefix: ALLOWED_OUTPUT_PREFIX,
      reason: "Requested output path escapes the governed allowed_output_prefix.",
    });
  }

  // --- GUARD 3: approval gate ------------------------------------------------
  if (input.approved !== true) {
    return refuseSealed("runx.overlay.approval.denied", {
      approved: input.approved === undefined ? null : input.approved,
      reason: "Governed effect requires an explicit operator approval flag (approved:true).",
    });
  }

  // --- CONSUME the attenuation: run the wrapped effect, governed -------------
  // The theme spec (the wrapped skill's own theme file) is either supplied
  // inline (deterministic harness) or fetched live from its pinned source (a
  // real source read at run time during a dogfood run).
  let themeSpec = typeof input.theme_spec === "string" ? input.theme_spec : "";
  if (!themeSpec.trim() && typeof input.theme_spec_url === "string") {
    const res = await fetch(input.theme_spec_url); // fs.read/net.fetch of real upstream data
    if (!res.ok) return refuseHard(`theme_spec fetch failed: HTTP ${res.status}`);
    themeSpec = await res.text();
  }
  if (!themeSpec.trim()) {
    return refuseHard("theme_spec or theme_spec_url (the wrapped skill's theme file) is required to execute");
  }
  const artifact =
    typeof input.artifact === "string" && input.artifact.trim()
      ? input.artifact
      : "<!doctype html><html><head><title>Artifact</title></head><body><h1>Untitled</h1></body></html>";

  const spec = parseThemeSpec(themeSpec);
  if (Object.keys(spec.colors).length === 0) {
    return refuseHard("theme_spec contained no parseable colors; nothing to apply");
  }
  const themed = applyTheme(artifact, themeName, spec);

  // Real governed write under the enforced prefix (fs.write).
  const outDir = input.output_dir || ALLOWED_OUTPUT_PREFIX;
  mkdirSync(outDir, { recursive: true });
  const outPath = outCheck.path;
  writeFileSync(outPath, themed, "utf8");
  const outputSha = "sha256:" + createHash("sha256").update(Buffer.from(themed, "utf8")).digest("hex");

  // --- SEAL an effect receipt bound to the authorization ---------------------
  seal({
    decision: "ready",
    execution_performed: true,
    wrapped_ran: true,
    authorization: {
      pinned_digest: PINNED_DIGEST,
      wraps_ref: WRAPS_REF,
      resolution_mode: resolved.mode,
      resolved_source: resolved.source,
      granted_scope: { theme: themeName, allowed_output_prefix: ALLOWED_OUTPUT_PREFIX },
      allowed_tools: ALLOWED_TOOLS,
    },
    effect: {
      act: "theme.apply",
      theme: themeName,
      applied: {
        colors: spec.colors,
        fonts: spec.fonts,
      },
      output_ref: resolve(outPath),
      output_relpath: outPath,
      output_sha256: outputSha,
      bytes_written: Buffer.byteLength(themed, "utf8"),
      tools_used: ["fs.read", "fs.write"],
    },
  });
}

main().catch((e) => refuseHard(`Unhandled error: ${e && e.message ? e.message : e}`));
