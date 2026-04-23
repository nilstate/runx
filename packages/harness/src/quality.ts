export type QualityEvaluationStatus = "pass" | "warn" | "fail";

export interface QualityProfileInput {
  readonly content: string;
  readonly sha256?: string;
}

export interface QualityEvaluationFinding {
  readonly code:
    | "missing_quality_profile"
    | "empty_artifact"
    | "thin_artifact"
    | "machine_framing"
    | "builder_framing"
    | "unresolved_placeholder"
    | "object_leak"
    | "weak_evidence";
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly evidence?: string;
}

export interface QualityEvaluation {
  readonly status: QualityEvaluationStatus;
  readonly score: number;
  readonly profile_sha256?: string;
  readonly findings: readonly QualityEvaluationFinding[];
}

export function evaluateArtifactQuality(options: {
  readonly qualityProfile?: QualityProfileInput | string;
  readonly artifact: unknown;
}): QualityEvaluation {
  const profile = normalizeQualityProfile(options.qualityProfile);
  const artifactText = artifactToText(options.artifact);
  const findings: QualityEvaluationFinding[] = [];

  if (!profile.content.trim()) {
    findings.push({
      code: "missing_quality_profile",
      severity: "error",
      message: "Artifact quality cannot be evaluated without the skill Quality Profile.",
    });
  }

  if (!artifactText.trim()) {
    findings.push({
      code: "empty_artifact",
      severity: "error",
      message: "Artifact is empty.",
    });
  } else if (artifactText.trim().length < 120) {
    findings.push({
      code: "thin_artifact",
      severity: "warning",
      message: "Artifact is very short for a first-party runx output.",
    });
  }

  for (const match of matchForbidden(artifactText, machineFramingPatterns)) {
    findings.push({
      code: "machine_framing",
      severity: "error",
      message: "Artifact exposes machine, model, or agent framing to the reader.",
      evidence: match,
    });
  }

  for (const match of matchForbidden(artifactText, builderFramingPatterns)) {
    findings.push({
      code: "builder_framing",
      severity: "error",
      message: "Artifact leaks builder/source framing instead of presenting native work.",
      evidence: match,
    });
  }

  for (const match of matchForbidden(artifactText, unresolvedPlaceholderPatterns)) {
    findings.push({
      code: "unresolved_placeholder",
      severity: "error",
      message: "Artifact contains an unresolved placeholder.",
      evidence: match,
    });
  }

  if (artifactText.includes("[object Object]")) {
    findings.push({
      code: "object_leak",
      severity: "error",
      message: "Artifact contains a raw object stringification leak.",
      evidence: "[object Object]",
    });
  }

  if (requiresEvidence(profile.content) && !hasEvidenceSignals(artifactText)) {
    findings.push({
      code: "weak_evidence",
      severity: "warning",
      message: "Quality Profile asks for evidence, but the artifact has weak visible evidence signals.",
    });
  }

  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const score = Math.max(0, 1 - errors * 0.35 - warnings * 0.15);
  return {
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    score,
    profile_sha256: profile.sha256,
    findings,
  };
}

function normalizeQualityProfile(profile: QualityProfileInput | string | undefined): QualityProfileInput {
  if (typeof profile === "string") {
    return { content: profile };
  }
  return profile ?? { content: "" };
}

function artifactToText(artifact: unknown): string {
  if (typeof artifact === "string") {
    return artifact;
  }
  if (artifact === undefined || artifact === null) {
    return "";
  }
  return JSON.stringify(artifact, null, 2);
}

function matchForbidden(text: string, patterns: readonly RegExp[]): readonly string[] {
  const matches: string[] = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) {
      matches.push(match[0]);
    }
  }
  return matches;
}

function requiresEvidence(profile: string): boolean {
  return /\bevidence bar\b|\bevidence\b|\bsource refs?\b|\bgrounded\b/i.test(profile);
}

function hasEvidenceSignals(text: string): boolean {
  return /\bevidence\b|\bsource\b|\bfrom\b|\bbecause\b|\bobserved\b|\brepo\b|\bissue\b|\breceipt\b|\bartifact\b|\bcited\b/i.test(text);
}

const machineFramingPatterns = [
  /\bmachine output\b/i,
  /\bagent output\b/i,
  /\bmodel output\b/i,
  /\bAI-generated\b/i,
  /\bthe machine should\b/i,
  /\bthe agent should\b/i,
  /\bthe model should\b/i,
] as const;

const builderFramingPatterns = [
  /\bsupplied catalog\b/i,
  /\bsupplied decomposition\b/i,
  /\bsupplied work-?plan\b/i,
  /\bprovided catalog evidence\b/i,
  /\bbuilder envelope\b/i,
  /\bmachine packet\b/i,
] as const;

const unresolvedPlaceholderPatterns = [
  /\bUNRESOLVED_[A-Z0-9_]+\b/,
  /\bTODO\b/,
  /\bTBD\b/,
  /\{\{[^}]+\}\}/,
] as const;
