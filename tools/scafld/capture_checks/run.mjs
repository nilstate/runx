#!/usr/bin/env node
const tool = (await import("./src/index.ts")).default;
await tool.main();
