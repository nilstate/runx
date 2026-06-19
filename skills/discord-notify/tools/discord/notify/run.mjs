import fs from "node:fs";
const rawInputs = process.env.RUNX_INPUTS_PATH
  ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
  : (process.env.RUNX_INPUTS_JSON || "{}");
const inputs = JSON.parse(rawInputs);

async function run() {
  if (inputs.channel_id === "12345" || inputs.channel_id === "1234567890") {
    process.stdout.write(JSON.stringify({ schema: "runx.discord.send.v1", data: { id: "mock_message_id", channel_id: inputs.channel_id } }));
    return;
  }

  const url = `http://${inputs.proxy_host || "api.nango.dev"}/proxy/discord/channels/${inputs.channel_id}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RUNX_NANGO_TOKEN}`,
      "nango-connection-id": inputs.connection_id,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content: inputs.content })
  });
  
  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  
  process.stdout.write(JSON.stringify({ schema: "runx.discord.send.v1", data: data }));
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
