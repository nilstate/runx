from runx import RunxClient, create_framework_bridge, create_openai_adapter


def main() -> None:
    client = RunxClient()
    bridge = create_framework_bridge(client)
    adapter = create_openai_adapter(bridge)
    response = adapter.run(
        "skills/sourcey",
        inputs={"project": "."},
        resolver=lambda context: True if context.request.get("kind") == "approval" else None,
    )
    print(response)


if __name__ == "__main__":
    main()
