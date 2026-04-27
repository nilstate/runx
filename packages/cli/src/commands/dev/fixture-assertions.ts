import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildLocalPacketIndex,
  deepEqual,
  isPlainRecord,
} from "../../authoring-utils.js";
import type { FixtureAssertion } from "./internal.js";

export async function assertFixtureExpectation(
  root: string,
  expectation: unknown,
  exitCode: number,
  output: unknown,
): Promise<readonly FixtureAssertion[]> {
  const assertions: FixtureAssertion[] = [];
  const expectRecord = isPlainRecord(expectation) ? expectation : {};
  const expectedStatus = typeof expectRecord.status === "string" ? expectRecord.status : "success";
  const actualStatus = exitCode === 0 ? "success" : "failure";
  if (expectedStatus !== actualStatus) {
    assertions.push({
      path: "expect.status",
      expected: expectedStatus,
      actual: actualStatus,
      kind: "status_mismatch",
      message: `Expected status ${expectedStatus}, got ${actualStatus}.`,
    });
  }
  const outputExpectation = isPlainRecord(expectRecord.output) ? expectRecord.output : undefined;
  if (outputExpectation) {
    assertions.push(...await assertOutputExpectation(root, outputExpectation, output, "expect.output"));
  }
  const outputsExpectation = isPlainRecord(expectRecord.outputs) ? expectRecord.outputs : undefined;
  if (outputsExpectation) {
    for (const [name, expected] of Object.entries(outputsExpectation)) {
      const actual = selectNamedOutput(output, name);
      assertions.push(...await assertOutputExpectation(root, expected, actual, `expect.outputs.${name}`));
    }
  }
  return assertions;
}

export async function assertOutputExpectation(
  root: string,
  expectation: unknown,
  output: unknown,
  basePath: string,
): Promise<readonly FixtureAssertion[]> {
  const assertions: FixtureAssertion[] = [];
  const outputExpectation = isPlainRecord(expectation) ? expectation : {};
  const normalizedOutput = normalizeOutputForExpectation(outputExpectation, output);
  if ("exact" in outputExpectation && !deepEqual(normalizedOutput, outputExpectation.exact)) {
    assertions.push({
      path: `${basePath}.exact`,
      expected: outputExpectation.exact,
      actual: normalizedOutput,
      kind: "exact_mismatch",
      message: "Output did not exactly match.",
    });
  }
  if ("subset" in outputExpectation) {
    assertions.push(...assertSubset(outputExpectation.subset, normalizedOutput, ""));
  }
  if (typeof outputExpectation.matches_packet === "string") {
    assertions.push(...await assertMatchesPacket(root, outputExpectation.matches_packet, output, `${basePath}.matches_packet`));
  }
  return assertions;
}

export function normalizeOutputForExpectation(
  expectation: Readonly<Record<string, unknown>>,
  output: unknown,
): unknown {
  if (typeof expectation.matches_packet !== "string") {
    return output;
  }
  if (!isPlainRecord(output) || !("data" in output)) {
    return output;
  }
  const subsetTargetsWrapper = "subset" in expectation && expectationTargetsPacketWrapper(expectation.subset);
  const exactTargetsWrapper = "exact" in expectation && expectationTargetsPacketWrapper(expectation.exact);
  if (subsetTargetsWrapper || exactTargetsWrapper) {
    return output;
  }
  return output.data;
}

export function expectationTargetsPacketWrapper(value: unknown): boolean {
  return isPlainRecord(value) && ("schema" in value || "data" in value);
}

export function selectNamedOutput(output: unknown, name: string): unknown {
  if (!isPlainRecord(output)) {
    return output;
  }
  if (name in output) {
    return output[name];
  }
  if (isPlainRecord(output.data) && name in output.data) {
    return output.data[name];
  }
  return output;
}

export function assertSubset(expected: unknown, actual: unknown, basePath: string): readonly FixtureAssertion[] {
  if (!isPlainRecord(expected)) {
    return deepEqual(expected, actual) ? [] : [{
      path: basePath,
      expected,
      actual,
      kind: "subset_miss",
      message: "Subset value did not match.",
    }];
  }
  const assertions: FixtureAssertion[] = [];
  const actualRecord = isPlainRecord(actual) ? actual : {};
  for (const [key, value] of Object.entries(expected)) {
    const pathKey = basePath ? `${basePath}.${key}` : key;
    assertions.push(...assertSubset(value, actualRecord[key], pathKey));
  }
  return assertions;
}

export async function assertMatchesPacket(
  root: string,
  packetId: string,
  output: unknown,
  basePath: string,
): Promise<readonly FixtureAssertion[]> {
  const index = await buildLocalPacketIndex(root, { writeCache: false });
  const packet = index.packets.find((candidate) => candidate.id === packetId);
  if (!packet) {
    return [{
      path: basePath,
      expected: packetId,
      actual: index.packets.map((candidate) => candidate.id),
      kind: "packet_invalid",
      message: `Packet ${packetId} is not declared in this package index.`,
    }];
  }
  const outputRecord = isPlainRecord(output) ? output : undefined;
  const actualPacketId = typeof outputRecord?.schema === "string" ? outputRecord.schema : undefined;
  if (actualPacketId && actualPacketId !== packetId) {
    return [{
      path: basePath,
      expected: packetId,
      actual: actualPacketId,
      kind: "packet_invalid",
      message: "Output packet schema did not match.",
    }];
  }
  const schema = JSON.parse(await readFile(path.resolve(root, packet.path), "utf8")) as unknown;
  const data = outputRecord && "data" in outputRecord ? outputRecord.data : output;
  return validateJsonSchemaValue(schema, data, `${basePath}.data`);
}

export function validateJsonSchemaValue(schema: unknown, value: unknown, basePath: string): readonly FixtureAssertion[] {
  if (!isPlainRecord(schema)) {
    return [{
      path: basePath,
      expected: "JSON Schema object",
      actual: schema,
      kind: "packet_invalid",
      message: "Packet schema artifact is not an object.",
    }];
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = (Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf) as readonly unknown[];
    const branchErrors = branches.map((branch) => validateJsonSchemaValue(branch, value, basePath));
    if (branchErrors.some((errors) => errors.length === 0)) {
      return [];
    }
    return branchErrors[0] ?? [];
  }
  const type = schema.type;
  const allowedTypes = Array.isArray(type) ? type.filter((entry): entry is string => typeof entry === "string") : typeof type === "string" ? [type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((entry) => jsonTypeMatches(entry, value))) {
    return [{
      path: basePath,
      expected: allowedTypes.join(" | "),
      actual: jsonTypeName(value),
      kind: "type_mismatch",
      message: `Expected ${allowedTypes.join(" | ")}, got ${jsonTypeName(value)}.`,
    }];
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    return [{
      path: basePath,
      expected: schema.const,
      actual: value,
      kind: "exact_mismatch",
      message: "Value did not match schema const.",
    }];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
    return [{
      path: basePath,
      expected: schema.enum,
      actual: value,
      kind: "exact_mismatch",
      message: "Value did not match schema enum.",
    }];
  }
  const assertions: FixtureAssertion[] = [];
  if ((schema.type === "object" || isPlainRecord(schema.properties)) && isPlainRecord(value)) {
    const properties = isPlainRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
    for (const key of required) {
      if (!(key in value)) {
        assertions.push({
          path: `${basePath}.${key}`,
          expected: "required",
          actual: "missing",
          kind: "subset_miss",
          message: "Required packet field is missing.",
        });
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        assertions.push(...validateJsonSchemaValue(propertySchema, value[key], `${basePath}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          assertions.push({
            path: `${basePath}.${key}`,
            expected: "no additional property",
            actual: value[key],
            kind: "packet_invalid",
            message: "Packet includes an undeclared field.",
          });
        }
      }
    }
  }
  if ((schema.type === "array" || schema.items !== undefined) && Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      assertions.push(...validateJsonSchemaValue(schema.items, value[index], `${basePath}[${index}]`));
    }
  }
  return assertions;
}

export function jsonTypeMatches(type: string, value: unknown): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isPlainRecord(value);
  return typeof value === type;
}

export function jsonTypeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}
