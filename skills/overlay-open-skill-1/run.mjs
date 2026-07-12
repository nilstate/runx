const WRAPS_PATH =
  "https://raw.githubusercontent.com/obra/superpowers/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/verification-before-completion/SKILL.md";
const PINNED_DIGEST =
  "sha256:ea52d15aabaf72bc6b558efe2c126f161b53961090ddcd712000273bfe8c7b6c";
const SCOPES = Object.freeze(["repo.read"]);
const ALLOWED_TOOLS = Object.freeze(["shell.exec"]);
const DENIED_CAPABILITIES = Object.freeze([
  "filesystem.write",
  "repo.commit",
  "repo.push",
  "network.access",
  "publish",
  "secrets.read",
]);

const objective = (
  process.env.RUNX_INPUT_OBJECTIVE ??
  "Verify current work before making a completion claim."
).trim();
const resolvedDigest = (
  process.env.RUNX_INPUT_RESOLVED_DIGEST ?? PINNED_DIGEST
)
  .trim()
  .toLowerCase();

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

if (!/^sha256:[0-9a-f]{64}$/.test(resolvedDigest)) {
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
