const LANE_IDS = Object.freeze([
  "classify",
  "docs",
  "release",
  "issue",
  "send",
  "spend",
  "audit",
]);

export function packageRoute(inputs) {
  const lanes = {};
  for (const id of LANE_IDS) {
    const packet = inputs[id];
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
      throw new Error("business-ops finalizer requires lane packet " + id);
    }
    lanes[id] = packet;
  }
  return {
    lane_packets: {
      schema: "runx.business_ops_route.v1",
      signal: String(inputs.signal || "").trim(),
      lanes,
    },
  };
}
