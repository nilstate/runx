use runx_contracts::tools::{ToolBuildStatus, ToolCatalogSearchReport, ToolCatalogSearchResult};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolSearchOptions {
    pub query: String,
    pub source: Option<String>,
    pub limit: usize,
    pub fixture_catalog_enabled: bool,
}

pub fn search_tools(options: &ToolSearchOptions) -> ToolCatalogSearchReport {
    search_tools_with_effects(options, &crate::RuntimeEffectRegistry::default())
}

pub fn search_tools_with_effects(
    options: &ToolSearchOptions,
    effects: &crate::RuntimeEffectRegistry,
) -> ToolCatalogSearchReport {
    let source = options.source.as_deref().unwrap_or("all").to_owned();
    let normalized_source = options
        .source
        .as_deref()
        .map(|source| source.trim().to_ascii_lowercase());
    let mut results = Vec::new();

    if native_catalog_allowed(normalized_source.as_deref(), effects) {
        let mut native = super::native::search(&options.query, options.limit, effects);
        if let Some(source) = exact_native_source(normalized_source.as_deref()) {
            native.retain(|tool| tool.source.eq_ignore_ascii_case(source));
        }
        results.extend(native);
    }

    if results.len() < options.limit
        && fixture_catalog_allowed(
            options.fixture_catalog_enabled,
            normalized_source.as_deref(),
        )
    {
        let query = options.query.trim().to_ascii_lowercase();
        for fixture in fixture_tools() {
            let result = fixture.search_result();
            if query.is_empty() || searchable_text(&result).contains(&query) {
                results.push(result);
            }
            if results.len() >= options.limit {
                break;
            }
        }
    }

    ToolCatalogSearchReport {
        status: ToolBuildStatus::Success,
        query: options.query.clone(),
        source,
        results,
    }
}

fn native_catalog_allowed(source: Option<&str>, effects: &crate::RuntimeEffectRegistry) -> bool {
    matches!(
        source,
        None | Some("") | Some("all") | Some("native") | Some("runx-runtime")
    ) || source.is_some_and(|source| {
        effects
            .capabilities()
            .iter()
            .any(|capability| capability.definition().owner.eq_ignore_ascii_case(source))
    })
}

fn exact_native_source(source: Option<&str>) -> Option<&str> {
    match source {
        None | Some("") | Some("all") | Some("native") => None,
        Some(source) => Some(source),
    }
}

pub(crate) fn fixture_catalog_allowed(enabled: bool, source: Option<&str>) -> bool {
    enabled
        && matches!(
            source,
            None | Some("") | Some("catalog") | Some("fixture-mcp")
        )
}

pub(crate) fn fixture_tool(ref_or_name: &str) -> Option<FixtureTool> {
    let normalized = ref_or_name.trim().to_ascii_lowercase();
    fixture_tools().into_iter().find(|tool| {
        [
            tool.qualified_name(),
            tool.tool_id(),
            tool.catalog_ref(),
            format!("{}:{}", tool.source, tool.qualified_name()),
            tool.external_name.to_owned(),
        ]
        .into_iter()
        .any(|candidate| candidate.to_ascii_lowercase() == normalized)
    })
}

pub(crate) fn fixture_tools() -> Vec<FixtureTool> {
    [
        echo_fixture_tool(),
        fail_fixture_tool(),
        sleep_fixture_tool(),
        env_fixture_tool(),
    ]
    .to_vec()
}

fn echo_fixture_tool() -> FixtureTool {
    fixture_tool_with_inputs(
        "echo",
        Some("Echo a message through the fixture MCP server."),
        vec![FixtureInput {
            name: "message",
            input_type: "string",
            required: true,
            description: Some("Message to echo."),
        }],
    )
}

fn fail_fixture_tool() -> FixtureTool {
    fixture_tool_with_inputs(
        "fail",
        Some("Return a fixture MCP error for testing."),
        vec![FixtureInput {
            name: "message",
            input_type: "string",
            required: false,
            description: None,
        }],
    )
}

fn sleep_fixture_tool() -> FixtureTool {
    fixture_tool_with_inputs(
        "sleep",
        Some("Never respond, for timeout testing."),
        Vec::new(),
    )
}

fn env_fixture_tool() -> FixtureTool {
    fixture_tool_with_inputs(
        "env",
        Some("Return a single fixture server environment variable."),
        vec![FixtureInput {
            name: "name",
            input_type: "string",
            required: true,
            description: None,
        }],
    )
}

fn fixture_tool_with_inputs(
    name: &'static str,
    description: Option<&'static str>,
    inputs: Vec<FixtureInput>,
) -> FixtureTool {
    FixtureTool {
        name,
        description,
        source: "fixture-mcp",
        source_label: "Fixture MCP Catalog",
        source_type: "mcp",
        namespace: "fixture",
        external_name: name,
        tags: vec!["fixture", "mcp"],
        inputs,
    }
}

fn searchable_text(result: &ToolCatalogSearchResult) -> String {
    [
        result.tool_id.as_str(),
        result.name.as_str(),
        result.summary.as_deref().unwrap_or(""),
        result.source.as_str(),
        result.source_label.as_str(),
        result.source_type.as_str(),
        result.namespace.as_str(),
        result.external_name.as_str(),
        result.catalog_ref.as_str(),
        &result.tags.join(" "),
    ]
    .join(" ")
    .to_ascii_lowercase()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FixtureTool {
    pub name: &'static str,
    pub description: Option<&'static str>,
    pub source: &'static str,
    pub source_label: &'static str,
    pub source_type: &'static str,
    pub namespace: &'static str,
    pub external_name: &'static str,
    pub tags: Vec<&'static str>,
    pub inputs: Vec<FixtureInput>,
}

impl FixtureTool {
    pub(crate) fn qualified_name(&self) -> String {
        format!("{}.{}", self.namespace, self.name)
    }

    pub(crate) fn tool_id(&self) -> String {
        format!("{}/{}", self.source, self.qualified_name())
    }

    pub(crate) fn catalog_ref(&self) -> String {
        format!("{}:{}", self.source, self.qualified_name())
    }

    fn search_result(&self) -> ToolCatalogSearchResult {
        ToolCatalogSearchResult {
            tool_id: self.tool_id(),
            name: self.qualified_name(),
            summary: self.description.map(str::to_owned),
            source: self.source.to_owned(),
            source_label: self.source_label.to_owned(),
            source_type: self.source_type.to_owned(),
            namespace: self.namespace.to_owned(),
            external_name: self.external_name.to_owned(),
            required_scopes: vec![self.qualified_name()],
            tags: self.tags.iter().map(|tag| (*tag).to_owned()).collect(),
            catalog_ref: self.catalog_ref(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FixtureInput {
    pub name: &'static str,
    pub input_type: &'static str,
    pub required: bool,
    pub description: Option<&'static str>,
}
