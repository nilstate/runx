import { createFrameworkBridge, createOpenAiAdapter, createRunxSdk } from "@runx/sdk";

async function main(): Promise<void> {
  const sdk = createRunxSdk({ callerOptions: { maxAttempts: 1 } });
  const bridge = createFrameworkBridge({ execute: sdk.runSkill.bind(sdk) });
  const openai = createOpenAiAdapter(bridge);

  const response = await openai.run({
    skillPath: "skills/sourcey",
    inputs: { project: "." },
    resolver: ({ request }) => {
      if (request.kind === "approval") {
        return true;
      }
      return undefined;
    },
  });

  console.log(JSON.stringify(response, null, 2));
}

void main();
