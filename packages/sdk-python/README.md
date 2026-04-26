# runx-py

Python SDK for [runx](https://runx.ai) — the governed runtime for agent skills, tools, and chains.

`runx-py` is a thin Python client over the `runx` CLI JSON output. Install the CLI separately (`@runxhq/cli` on npm), then use this package from Python to search and run skills, resume paused runs, and format host protocol results for popular agent frameworks.

## Install

```bash
pip install runx-py
```

You will also need the `runx` CLI on your `PATH`:

```bash
npm install -g @runxhq/cli
```

## Usage

```python
from runx import RunxClient

client = RunxClient()

# Search the registry
for result in client.search_skills("sourcey"):
    print(result.skill_id, result.version)

# Run a skill
report = client.run_skill("skills/sourcey", inputs={"project": "."})
print(report["status"])

paused = client.resume_run("run_123", approvals={"publish": True})
print(paused["status"])
```

## Framework adapters

Bridge runx into an existing agent framework (OpenAI, Anthropic, CrewAI, LangChain, Vercel AI):

```python
from runx import create_host_bridge, create_openai_host_adapter

bridge = create_host_bridge(run=my_host_run, resume=my_host_resume)
adapter = create_openai_host_adapter(bridge)
response = adapter.run("skills/sourcey")
```

The bridge translates host protocol results, including paused runs and approval gates, into framework-native tool messages. `RunxClient` remains a CLI client; host protocol execution is provided by the embedding runtime.

## Links

- Homepage: <https://runx.ai>
- Documentation: <https://runx.ai/docs>
- Source: <https://github.com/runxhq/runx>
- Issues: <https://github.com/runxhq/runx/issues>

## Releasing

See [RELEASING.md](RELEASING.md) for the automated tag-driven publish flow.

## License

Apache-2.0
