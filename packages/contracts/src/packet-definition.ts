import type { JsonSchema, Static } from "./internal.js";

/** A packet id paired with the schema that owns its wire shape. */
export interface PacketDefinition<Schema extends JsonSchema = JsonSchema> {
  readonly id: string;
  readonly schema: Schema;
}

/**
 * Preserve a packet schema's static type without introducing a second runtime
 * registry. The returned value is the supplied definition itself.
 */
export function definePacket<const Schema extends JsonSchema>(
  definition: PacketDefinition<Schema>,
): PacketDefinition<Schema> & { readonly type?: Static<Schema> } {
  return definition as PacketDefinition<Schema> & { readonly type?: Static<Schema> };
}
