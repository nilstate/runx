#!/usr/bin/env node

import { buildSbomResult, fetchSource } from "./lib.mjs";

try {
  const inputs = parseInputs();
  const sourceHandle = requiredString(inputs.source_handle, "source_handle");
  const lockfileType = requiredString(inputs.lockfile_type, "lockfile_type");
  const dataSourceRef = requiredString(inputs.data_source_ref, "data_source_ref");
  const storeId = optionalString(inputs.store_id);
  const read = await fetchSource(sourceHandle);
  const { content, ...sourceRead } = read;
  const result = buildSbomResult({
    sourceHandle,
    lockfileType,
    content,
    contentDigest: read.content_digest,
    fetchedAt: read.fetched_at,
    bytes: read.bytes,
    status: read.status,
    sourceKind: read.source_kind,
    repositoryFileUrl: read.repository_file_url,
    blobSha: read.blob_sha,
  });

  result.source_read = sourceRead;
  result.stored_artifact_ref = {
    data_source_ref: dataSourceRef,
    ...(storeId ? { store_id: storeId } : {}),
    ...result.stored_artifact_ref,
  };

  process.stdout.write(JSON.stringify({ sbom_result: result }));
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ sbom_result: { status: "refused", reason, sbom_emitted: false } }));
  process.stderr.write(`${JSON.stringify({ refusal: { reason, sbom_emitted: false } })}\n`);
  process.exitCode = 1;
}

function parseInputs() {
  const raw = process.env.RUNX_INPUTS_JSON;
  if (!raw) throw new Error("RUNX_INPUTS_JSON is missing");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RUNX_INPUTS_JSON must be an object");
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
