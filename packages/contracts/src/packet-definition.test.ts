import { describe, expect, it } from "vitest";

import { Type, definePacket } from "./index.js";

describe("definePacket", () => {
  it("keeps the canonical schema object and packet id together", () => {
    const packet = definePacket({
      id: "runx.docs.scan.v1",
      schema: Type.Object({ status: Type.String() }, { additionalProperties: false }),
    });

    expect(packet.id).toBe("runx.docs.scan.v1");
    expect(packet.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });
});
