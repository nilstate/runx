#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PaymentPayloadV2Schema,
  PaymentRequiredV2Schema,
} from "@x402/core/schemas";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";

const EXPECTED_COMMIT = "230e6a9a7eebce22c911a0687d6f4e6d1ac019f7";
const EXPECTED_PACKAGE = "@x402/core";
const EXPECTED_PACKAGE_VERSION = "2.23.0";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = path.join(root, "fixtures", "contracts", "x402-v2");

const pin = await jsonFile(path.join(fixtureRoot, "upstream-pin.json"));
const installedPackage = await jsonFile(path.join(root, "node_modules", "@x402", "core", "package.json"));
assert(pin.revision === EXPECTED_COMMIT, "upstream commit pin drifted");
assert(pin.package?.name === EXPECTED_PACKAGE, "upstream package name drifted");
assert(pin.package?.version === EXPECTED_PACKAGE_VERSION, "upstream package version pin drifted");
assert(installedPackage.name === EXPECTED_PACKAGE, "installed upstream package name drifted");
assert(installedPackage.version === EXPECTED_PACKAGE_VERSION, "installed upstream package version drifted");
assert(
  pin.source_verification?.mode === "pinned_checkout_sha256",
  "upstream source verification mode drifted",
);
assert(
  pin.source_verification?.command === "pnpm x402:conformance -- --upstream-dir <pinned-checkout>",
  "upstream source verification command drifted",
);
assert(Array.isArray(pin.sources) && pin.sources.length === 6, "upstream source provenance is incomplete");
for (const source of pin.sources) {
  assert(typeof source.path === "string" && source.path.length > 0, "upstream source path is missing");
  assert(/^sha256:[0-9a-f]{64}$/u.test(source.digest), "upstream source digest is malformed");
}

await validateOfficialVector({
  file: "official-payment-required.json",
  parse: value => PaymentRequiredV2Schema.safeParse(value).success,
  decode: decodePaymentRequiredHeader,
});
await validateOfficialVector({
  file: "official-payment-payload.json",
  parse: value => PaymentPayloadV2Schema.safeParse(value).success,
  decode: decodePaymentSignatureHeader,
});
await validateOfficialVector({
  file: "official-settle-success.json",
  parse: settleResponseShape,
  decode: decodePaymentResponseHeader,
});
await validateOfficialVector({
  file: "official-settle-failure.json",
  parse: settleResponseShape,
});

process.stdout.write(
  `x402 contract conformance passed (${EXPECTED_PACKAGE}@${EXPECTED_PACKAGE_VERSION}, ${EXPECTED_COMMIT})\n`,
);

async function validateOfficialVector({ file, parse, decode }) {
  const fixture = await jsonFile(path.join(fixtureRoot, file));
  assert(fixture.provenance.startsWith("x402 specification v2"), `${file} provenance is not official`);
  assert(parse(fixture.payload), `${file} fails the pinned official parser`);
  if (fixture.header !== null && fixture.header !== undefined) {
    let decoded;
    try {
      decoded = decode(fixture.header);
    } catch {
      fail(`${file} fails the pinned official header decoder`);
    }
    assert(isDeepStrictEqual(decoded, fixture.payload), `${file} header bytes decode to other semantics`);
  }
}

function settleResponseShape(value) {
  return Boolean(
    value
      && typeof value === "object"
      && typeof value.success === "boolean"
      && typeof value.transaction === "string"
      && typeof value.network === "string",
  );
}

async function jsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  process.stderr.write(`x402-contract-conformance: ${message}\n`);
  process.exit(1);
}
