# prospect-sequence evidence report

## Package

- Registry ref: `zdfgu113/prospect-sequence@sha-b4a3b8668802`
- Public URL: `https://runx.ai/x/zdfgu113/prospect-sequence`
- Install: `runx add zdfgu113/prospect-sequence@sha-b4a3b8668802 --registry https://api.runx.ai`
- Run: `runx skill zdfgu113/prospect-sequence@sha-b4a3b8668802 --registry https://api.runx.ai`
- CLI: `runx-cli 0.6.13`

## Behavior

The skill researches only supplied allowlisted public source snippets, extracts cited facts, drafts a four-touch sequence, and emits a gated `send_proposal` for `send-as`. It does not send messages, mutate CRM data, scrape private hosts, or use off-allowlist sources.

## Harness

- Command: `runx harness ./.tmp/frantic-prospect-sequence -R /home/zjs/runx-prospect-receipts --json`
- Status: `passed`
- Cases:
  - `public-sources-yield-sourced-sequence`
  - `private-or-missing-sources-refuse`
- Raw evidence: `references/harness.json`

## Dogfood

- Local dogfood status: `sealed`
- Local receipt: `sha256:9d5e4f26a9e8b99f4eabaa6c7e50626a45498446b900872d236bbc053814a3df`
- Local verify verdict: `valid`
- Published package dogfood status: `sealed`
- Published package receipt: `sha256:697160868f5c1f292fe3bfc9b50287fe0b896ecb33a573bda7aed41f0b08ec69`
- Published package verify verdict: `valid`

Dogfood input used a Northwind Software prospect, public `example.com` source snippets, and ICP pain points around manual release evidence review and supply-chain approval drift. Output produced a sourced account angle, four email touches, and a gated `send_proposal` with `performs_send: false`.

## New-user check

- `runx registry read zdfgu113/prospect-sequence@sha-b4a3b8668802 --registry https://api.runx.ai --json` succeeded.
- `runx add zdfgu113/prospect-sequence@sha-b4a3b8668802 --registry https://api.runx.ai --to /tmp/runx-prospect-install --json` succeeded.
- Running the published ref with the dogfood input sealed a receipt and verified cleanly.

## Files

- `SKILL.md`: operator-facing contract and safety notes.
- `X.yaml`: harness and cli-tool runner profile.
- `run.mjs`: deterministic runner with public-source allowlist and private-host refusal.
- `fixtures/dogfood-input.json`: successful dogfood input.
- `fixtures/private-target-input.json`: refusal-path input.
- `references/*.json`: raw harness, dogfood, publish, install, and verification artifacts.
