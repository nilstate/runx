// Minimal external adapter: echoes its inputs. The extension SDK owns the
// runx.external_adapter.v1 process protocol; this file owns only adapter logic.
import {
  defineExternalAdapter,
  materializeExternalAdapterInputs,
} from "@runxhq/extension-sdk";

const adapter = defineExternalAdapter({
  adapterId: "adapter.example.echo",
  invoke({ invocation }) {
    return { ok: true, inputs: materializeExternalAdapterInputs(invocation) };
  },
});

await adapter.main();
