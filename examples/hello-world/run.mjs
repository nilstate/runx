const message = process.env.RUNX_INPUT_MESSAGE ?? "";
process.stdout.write(`${JSON.stringify({ message })}\n`);
