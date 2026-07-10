# runx Quickstart Example

This example shows how to use runx to create, package, and execute a simple AI agent skill.

## Prerequisites

- Node.js 18+
- pnpm (install via `npm install -g pnpm`)

## Setup

```bash
# Install dependencies
pnpm install

# Build runx
pnpm build
```

## Your First Skill

A runx skill is a governed execution unit. Here's a minimal skill definition:

```typescript
import { Skill, skill } from 'runx';

@skill({
  name: 'hello-world',
  description: 'A simple greeting skill',
  inputs: {
    name: { type: 'string', description: 'Who to greet' }
  },
  outputs: {
    greeting: { type: 'string' }
  }
})
export class HelloWorld extends Skill {
  async execute(input: { name: string }) {
    return {
      greeting: `Hello, ${input.name}! This was executed under runx governance.`
    };
  }
}
```

## Running the Skill

```bash
# Execute the skill
npx runx run examples/quickstart/hello-world --input '{"name": "Agent"}'
```

## What Makes This Different

- **Governance**: Every execution is recorded with a verifiable receipt
- **Portability**: Skills work across Claude Code, Cursor, Codex, GPT, Gemini, and Aider
- **Composability**: Chain multiple skills together under a single authority

For more examples, see the [examples directory](https://github.com/runxhq/runx/tree/main/examples) in the runx repository.
