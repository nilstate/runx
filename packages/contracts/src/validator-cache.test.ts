import { Ajv2020 } from "ajv/dist/2020.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("contract validator cache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("compiles one immutable schema once across repeated validation", async () => {
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const { contractSchemaMatches, Type } = await import("./internal.js");
    const schema = Type.Object({ value: Type.String() });

    expect(contractSchemaMatches(schema, { value: "first" })).toBe(true);
    expect(contractSchemaMatches(schema, { value: "second" })).toBe(true);
    expect(contractSchemaMatches(schema, { value: 3 })).toBe(false);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("isolates validators compiled with different reference sets", async () => {
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const { contractSchemaMatches, Type } = await import("./internal.js");
    const reference = Type.Object(
      { value: Type.String() },
      { $id: "https://schemas.runx.ai/test/cache-reference.json" },
    );
    const otherReference = Type.Object(
      { value: Type.Number() },
      { $id: "https://schemas.runx.ai/test/cache-other-reference.json" },
    );
    const schema = Type.Ref(reference);

    expect(contractSchemaMatches(schema, { value: "ok" }, [reference])).toBe(true);
    expect(contractSchemaMatches(schema, { value: "again" }, [reference])).toBe(true);
    expect(() => contractSchemaMatches(schema, { value: "no" }, [otherReference]))
      .toThrow();
    expect(compile).toHaveBeenCalledTimes(2);
  });
});
