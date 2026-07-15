import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MAX_SOURCE_BYTES = 5_000_000;
const ALLOWED_SOURCE_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);
const SUPPORTED_LOCKFILE_TYPES = new Set(["package-lock", "npm-shrinkwrap"]);

export function normalizeSourceHandle(sourceHandle) {
  if (typeof sourceHandle !== "string" || sourceHandle.trim() === "") {
    throw new Error("source_handle is required");
  }

  let url;
  try {
    url = new URL(sourceHandle.trim());
  } catch {
    throw new Error("source_handle must be a valid URL");
  }

  if (url.protocol === "fixture:") {
    const fixtureName = `${url.hostname}${url.pathname}`.replace(/^\/+|\/+$/gu, "");
    if (!fixtureName || fixtureName.includes("/") || fixtureName.includes("..")) {
      throw new Error("fixture source must name one bundled fixture");
    }
    return { kind: "fixture", handle: url.href, fixtureName };
  }

  if (url.protocol !== "https:") {
    throw new Error("source_handle must use https");
  }
  if (url.username || url.password || url.port) {
    throw new Error("source_handle must not contain credentials or a custom port");
  }
  if (!ALLOWED_SOURCE_HOSTS.has(url.hostname)) {
    throw new Error(`source host is not allowed: ${url.hostname}`);
  }
  if (url.hash) {
    throw new Error("source_handle must not contain a query or fragment");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "api.github.com") {
    const refValues = url.searchParams.getAll("ref");
    if (segments.length < 5 || segments[0] !== "repos" || segments[3] !== "contents") {
      throw new Error("GitHub API source must be a repository contents file URL");
    }
    if ([...url.searchParams.keys()].some((key) => key !== "ref") || refValues.length !== 1) {
      throw new Error("GitHub API source must contain only one ref parameter");
    }
    if (!/^[a-f0-9]{12,64}$/iu.test(refValues[0])) {
      throw new Error("GitHub API source must be pinned to an immutable commit");
    }
    return {
      kind: "github_contents",
      handle: url.href,
      host: url.hostname,
      commit: refValues[0],
    };
  }

  if (url.search) throw new Error("raw GitHub source must not contain a query");
  if (segments.length < 4 || !/^[a-f0-9]{12,64}$/iu.test(segments[2])) {
    throw new Error("raw GitHub source must be pinned to an immutable commit");
  }

  return { kind: "https", handle: url.href, host: url.hostname };
}

export async function fetchSource(sourceHandle, options = {}) {
  const source = normalizeSourceHandle(sourceHandle);
  const now = options.now ?? (() => new Date().toISOString());

  if (source.kind === "fixture") {
    const fixtureUrl = new URL(
      `../harness-fixtures/${source.fixtureName}/manifest.json`,
      import.meta.url,
    );
    const bytes = await readFile(fileURLToPath(fixtureUrl));
    assertBounded(bytes.byteLength);
    return sourceRead({
      sourceHandle: source.handle,
      finalUrl: source.handle,
      status: 200,
      bytes,
      fetchedAt: now(),
      sourceKind: "fixture",
    });
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 45_000;
  let lastError = "unknown source read failure";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let currentUrl = source.handle;
    const redirects = [];
    try {
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        const response = await fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "application/json, text/plain;q=0.9",
            "user-agent": "runx-sbom-maker/1.0",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirectCount === 5) {
            throw new Error("source returned an invalid redirect");
          }
          const nextUrl = new URL(location, currentUrl).href;
          normalizeSourceHandle(nextUrl);
          redirects.push({ status: response.status, from: currentUrl, to: nextUrl });
          currentUrl = nextUrl;
          continue;
        }

        if (!response.ok) {
          throw new Error(`source returned HTTP ${response.status}`);
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength)) assertBounded(declaredLength);
        const transportBytes = new Uint8Array(await response.arrayBuffer());
        const decoded = source.kind === "github_contents"
          ? decodeGitHubContents(transportBytes)
          : { bytes: transportBytes, evidence: {} };
        const bytes = decoded.bytes;
        assertBounded(bytes.byteLength);
        return {
          ...sourceRead({
            sourceHandle: source.handle,
            finalUrl: response.url || currentUrl,
            status: response.status,
            bytes,
            fetchedAt: now(),
            sourceKind: source.kind,
          }),
          redirects,
          attempts: attempt,
          ...decoded.evidence,
        };
      }
      lastError = "redirect limit exceeded";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) {
      await delay(attempt * 1_000);
    }
  }

  throw new Error(`source read failed after 3 attempts: ${lastError}`);
}

export function buildSbomResult({
  sourceHandle,
  lockfileType,
  content,
  contentDigest,
  fetchedAt,
  bytes,
  status,
  sourceKind,
  repositoryFileUrl,
  blobSha,
}) {
  if (!SUPPORTED_LOCKFILE_TYPES.has(lockfileType)) {
    throw new Error(`unsupported lockfile_type: ${lockfileType}`);
  }

  let lockfile;
  try {
    lockfile = JSON.parse(content);
  } catch {
    throw new Error("lockfile content is not valid JSON");
  }
  if (!isRecord(lockfile)) {
    throw new Error("lockfile must be a JSON object");
  }

  const rootPackage = isRecord(lockfile.packages) && isRecord(lockfile.packages[""])
    ? lockfile.packages[""]
    : {};
  const projectName = firstString(rootPackage.name, lockfile.name, "unnamed-project");
  const projectVersion = firstString(rootPackage.version, lockfile.version, "0.0.0");
  const components = extractComponents(lockfile);
  if (components.length === 0) {
    throw new Error("lockfile has no dependency map with pinned components");
  }

  components.sort((left, right) => left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version)
    || left.evidence_location.localeCompare(right.evidence_location));

  const licenseCounts = {};
  const licenseRisks = [];
  for (const component of components) {
    licenseCounts[component.license] = (licenseCounts[component.license] ?? 0) + 1;
    const risk = licenseRisk(component);
    if (risk) licenseRisks.push(risk);
  }

  const sourceReadEvidence = {
    source_handle: sourceHandle,
    final_url: sourceHandle,
    source_kind: sourceKind ?? (sourceHandle.startsWith("fixture:") ? "fixture" : "https"),
    status,
    fetched_at: fetchedAt,
    bytes,
    content_digest: contentDigest,
  };
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${digestUuid(contentDigest)}`,
    version: 1,
    metadata: {
      component: { type: "application", name: projectName, version: projectVersion },
      properties: [
        { name: "runx:source_handle", value: sourceHandle },
        { name: "runx:source_digest", value: contentDigest },
        { name: "runx:lockfile_type", value: lockfileType },
      ],
    },
    components: components.map(({ evidence_location, ...component }) => ({
      type: "library",
      ...component,
      properties: [{ name: "runx:evidence_location", value: evidence_location }],
      evidence_location,
    })),
  };
  const licenseSummary = {
    total_components: components.length,
    license_counts: sortRecord(licenseCounts),
  };
  const aggregateId = `${projectName}@${projectVersion}`;
  const idempotencyKey = `sbom:${aggregateId}:${contentDigest}`;
  const storageEvent = {
    type: "sbom.generated",
    project: { name: projectName, version: projectVersion },
    lockfile_type: lockfileType,
    source_read: {
      source_handle: sourceHandle,
      source_kind: sourceReadEvidence.source_kind,
      status,
      bytes,
      content_digest: contentDigest,
      ...(repositoryFileUrl ? { repository_file_url: repositoryFileUrl } : {}),
      ...(blobSha ? { blob_sha: blobSha } : {}),
    },
    sbom,
    components,
    license_summary: licenseSummary,
    license_risks: licenseRisks,
  };

  return {
    source_read: sourceReadEvidence,
    sbom,
    components,
    license_summary: licenseSummary,
    license_risks: licenseRisks,
    stored_artifact_ref: {
      resource: "software_boms",
      aggregate_id: aggregateId,
      expected_version: 0,
      idempotency_key: idempotencyKey,
      read_operation: "read_events",
    },
    storage_event: storageEvent,
  };
}

export function finalizeStoredResult({ generated, appendResult, readbackResult }) {
  if (!isRecord(generated)) throw new Error("generated is required");
  if (!isRecord(appendResult)) throw new Error("append_result is required");
  if (!isRecord(readbackResult)) throw new Error("readback_result is required");
  if (!isRecord(generated.stored_artifact_ref)) {
    throw new Error("generated.stored_artifact_ref is required");
  }

  if (!new Set(["committed", "idempotent_replay"]).has(appendResult.status)) {
    throw new Error(`append did not commit: ${String(appendResult.status ?? "unknown")}`);
  }
  const eventRef = firstString(appendResult.event_ref);
  if (!eventRef) throw new Error("append result has no event_ref");

  const idempotencyKey = generated.stored_artifact_ref.idempotency_key;
  const readbackEvent = Array.isArray(readbackResult.events)
    ? readbackResult.events.find((entry) => isRecord(entry)
      && entry.event_ref === eventRef
      && entry.event_type === "sbom.generated"
      && entry.idempotency_key === idempotencyKey)
    : undefined;
  if (!readbackEvent) throw new Error("stored SBOM event was not present in readback");

  const providerEvidence = isRecord(appendResult.provider_evidence) ? appendResult.provider_evidence : {};
  return {
    source_read: generated.source_read,
    sbom: generated.sbom,
    components: generated.components,
    license_summary: generated.license_summary,
    license_risks: generated.license_risks,
    stored_artifact_ref: {
      ...generated.stored_artifact_ref,
      event_ref: eventRef,
      event_version: appendResult.after_version,
      append_status: appendResult.status,
      provider: appendResult.provider,
      ...(typeof providerEvidence.adapter === "string" ? { adapter: providerEvidence.adapter } : {}),
      ...(typeof providerEvidence.storage_class === "string"
        ? { storage_class: providerEvidence.storage_class }
        : {}),
      readback_verified: true,
      append_result_digest: digestObject(appendResult),
      readback_result_digest: digestObject(readbackResult),
    },
  };
}

function extractComponents(lockfile) {
  if (isRecord(lockfile.packages)) {
    return Object.entries(lockfile.packages)
      .filter(([packagePath, details]) => packagePath !== "" && isRecord(details))
      .flatMap(([packagePath, details]) => {
        const version = firstString(details.version);
        const marker = "node_modules/";
        const markerIndex = packagePath.lastIndexOf(marker);
        if (!version || markerIndex < 0) return [];
        const name = packagePath.slice(markerIndex + marker.length);
        return [component(name, version, details.license, `packages[${JSON.stringify(packagePath)}]`)];
      });
  }

  if (isRecord(lockfile.dependencies)) {
    const components = [];
    walkClassicDependencies(lockfile.dependencies, "dependencies", components);
    return components;
  }

  throw new Error("lockfile has no dependency map with pinned components");
}

function walkClassicDependencies(dependencies, location, output) {
  for (const [name, details] of Object.entries(dependencies)) {
    if (!isRecord(details)) continue;
    const componentLocation = `${location}[${JSON.stringify(name)}]`;
    const version = firstString(details.version);
    if (version) output.push(component(name, version, details.license, componentLocation));
    if (isRecord(details.dependencies)) {
      walkClassicDependencies(details.dependencies, `${componentLocation}.dependencies`, output);
    }
  }
}

function component(name, version, license, evidenceLocation) {
  return {
    name,
    version,
    license: normalizeLicense(license),
    evidence_location: evidenceLocation,
  };
}

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRecord(value) && typeof value.type === "string" && value.type.trim()) return value.type.trim();
  return "UNKNOWN";
}

function licenseRisk(componentValue) {
  const license = componentValue.license.toUpperCase();
  if (license.includes("AGPL") || license.includes("GPL-3")) {
    return {
      component: componentValue.name,
      version: componentValue.version,
      license: componentValue.license,
      risk: "high",
      reason: "strong copyleft license requires distribution and linking review",
      evidence_location: componentValue.evidence_location,
    };
  }
  if (license.includes("LGPL") || license.includes("MPL")) {
    return {
      component: componentValue.name,
      version: componentValue.version,
      license: componentValue.license,
      risk: "medium",
      reason: "weak copyleft license requires modification and relinking review",
      evidence_location: componentValue.evidence_location,
    };
  }
  if (license === "UNKNOWN") {
    return {
      component: componentValue.name,
      version: componentValue.version,
      license: componentValue.license,
      risk: "review",
      reason: "lockfile contains no license evidence",
      evidence_location: componentValue.evidence_location,
    };
  }
  return null;
}

function sourceRead({ sourceHandle, finalUrl, status, bytes, fetchedAt, sourceKind }) {
  return {
    source_handle: sourceHandle,
    final_url: finalUrl,
    source_kind: sourceKind,
    status,
    fetched_at: fetchedAt,
    bytes: bytes.byteLength,
    content_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
  };
}

function decodeGitHubContents(transportBytes) {
  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(transportBytes));
  } catch {
    throw new Error("GitHub contents response is not valid JSON");
  }
  if (!isRecord(payload) || payload.type !== "file" || payload.encoding !== "base64"
    || typeof payload.content !== "string") {
    throw new Error("GitHub contents response does not contain a base64 file");
  }
  const bytes = new Uint8Array(Buffer.from(payload.content.replace(/\s+/gu, ""), "base64"));
  return {
    bytes,
    evidence: {
      ...(typeof payload.sha === "string" ? { blob_sha: payload.sha } : {}),
      ...(typeof payload.html_url === "string" ? { repository_file_url: payload.html_url } : {}),
      transport_bytes: transportBytes.byteLength,
    },
  };
}

function assertBounded(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength < 0 || byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`source exceeds ${MAX_SOURCE_BYTES} byte limit`);
  }
}

function digestUuid(contentDigest) {
  const hex = createHash("sha256").update(contentDigest).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function digestObject(value) {
  const json = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
