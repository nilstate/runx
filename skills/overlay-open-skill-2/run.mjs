const WRAPS_PATH =
  "https://raw.githubusercontent.com/anthropics/skills/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/brand-guidelines/SKILL.md";
const PINNED_DIGEST =
  "sha256:1120b3769e2985cefb3d25be981b1f914abeba57ae079b83c20c666c164fa9fe";
const SCOPES = Object.freeze(["fs.read"]);
const ALLOWED_TOOLS = Object.freeze(["fs.read"]);
const DENIED_CAPABILITIES = Object.freeze([
  "filesystem.write",
  "network.access",
  "shell.exec",
  "repo.commit",
  "repo.push",
  "publish",
  "secrets.read",
]);

const objective = (
  process.env.RUNX_INPUT_OBJECTIVE ??
  "Apply the wrapped brand-styling guidance under read-only authority."
).trim();
const providedDigest = process.env.RUNX_INPUT_RESOLVED_DIGEST;
const resolvedDigest = providedDigest ? providedDigest.trim().toLowerCase() : null;

const base = {
  schema: "runx.skill_overlay.v1",
  objective,
  wraps: {
    path: WRAPS_PATH,
    digest: PINNED_DIGEST,
  },
  resolved_digest: resolvedDigest,
  runner: {
    type: "agent",
    scopes: SCOPES,
    allowed_tools: ALLOWED_TOOLS,
    denied_capabilities: DENIED_CAPABILITIES,
  },
};

if (resolvedDigest === null) {
  const output = {
    ...base,
    decision: "needs_input",
    diagnostics: [
      {
        id: "runx.overlay.digest.required",
        severity: "warning",
        message:
          "Resolve the immutable wrapped SKILL.md and provide its recomputed sha256 digest before applying the wrapped styling guidance.",
      },
    ],
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
} else if (!/^sha256:[0-9a-f]{64}$/.test(resolvedDigest)) {
  const output = {
    ...base,
    decision: "refused",
    diagnostics: [
      {
        id: "runx.overlay.digest.stale",
        severity: "error",
        message:
          "Resolved digest is invalid or does not match the pinned sha256 digest.",
      },
    ],
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.stderr.write("runx.overlay.digest.stale: invalid resolved digest\n");
  process.exitCode = 78;
} else if (resolvedDigest !== PINNED_DIGEST) {
  const output = {
    ...base,
    decision: "refused",
    diagnostics: [
      {
        id: "runx.overlay.digest.stale",
        severity: "error",
        message:
          "Wrapped SKILL.md bytes no longer match the pinned sha256 digest; changed instructions were not admitted.",
      },
    ],
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.stderr.write("runx.overlay.digest.stale: wrapped content changed\n");
  process.exitCode = 78;
} else {
  process.stdout.write(
    `${JSON.stringify({ ...base, decision: "ready", diagnostics: [] })}\n`,
  );
}
