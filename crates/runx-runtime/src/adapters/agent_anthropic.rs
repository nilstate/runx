// rust-style-allow: large-file - the Anthropic adapter keeps request shaping,
// tool-use parsing, and provider error mapping in one reviewed HTTP boundary.
//! Anthropic provider [`ModelCaller`] for the managed-agent loop.
//!
//! Translates the provider-agnostic [`AgentTurn`] transcript into an Anthropic
//! Messages API request and parses `tool_use` content blocks back into
//! [`AgentToolUse`], reusing the runtime HTTP transport rather than adding a new
//! HTTP client. Following the codebase convention for runtime HTTP call sites
//! (for example, the registry client), the wire is built and parsed with
//! `serde_json::Value` and converted to/from the runx `JsonValue` only at the
//! domain boundary.

use runx_contracts::JsonValue;
use serde_json::{Value as WireValue, json};

use super::agent_loop::{AgentToolUse, AgentTurn, ModelCaller};
use crate::RuntimeError;
use crate::credentials::SecretString;
use crate::http::{HttpMethod, RuntimeHttpHeader, RuntimeHttpRequest, RuntimeHttpTransport};

const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 4096;
const MANAGED_AGENT_SKILL: &str = "managed-agent";

/// A tool offered to the model: the LLM-facing tool definition the model may
/// call. Intentionally distinct from `McpToolDescriptor`, which models an MCP
/// server's protocol listing; they share a shape but sit at different layers. The
/// resolver builds these from the skill's `allowed_tools` plus the final-result
/// tool.
#[derive(Clone, Debug)]
pub struct AgentToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: JsonValue,
}

/// Calls the Anthropic Messages API to produce the model's next tool-use requests.
pub struct AnthropicModelCaller<T> {
    transport: T,
    url: String,
    api_key: SecretString,
    model: String,
    tools: Vec<AgentToolDefinition>,
}

impl<T> AnthropicModelCaller<T> {
    pub fn new(
        transport: T,
        api_key: SecretString,
        model: String,
        tools: Vec<AgentToolDefinition>,
    ) -> Self {
        Self {
            transport,
            url: ANTHROPIC_MESSAGES_URL.to_owned(),
            api_key,
            model,
            tools,
        }
    }

    /// Override the endpoint (proxies or tests).
    #[must_use]
    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into();
        self
    }

    fn tools_json(&self) -> Vec<WireValue> {
        self.tools
            .iter()
            .map(|tool| {
                json!({
                    "name": wire_tool_name(&tool.name),
                    "description": tool.description,
                    "input_schema": to_wire(&tool.input_schema),
                })
            })
            .collect()
    }

    /// Map a wire tool name from the model back to the runx tool ref it was
    /// offered as. runx tool refs are namespaced with a dot (`frantic.post`),
    /// which the Anthropic tool-name schema forbids, so they are offered with
    /// dots flattened; recover the real ref before the governed executor sees it.
    fn real_tool_name(&self, wire: &str) -> String {
        self.tools
            .iter()
            .find(|tool| wire_tool_name(&tool.name) == wire)
            .map_or_else(|| wire.to_owned(), |tool| tool.name.clone())
    }
}

/// Flatten a runx tool ref into an Anthropic-admissible tool name. The Messages
/// API requires tool names to match `^[a-zA-Z0-9_-]{1,128}$`, but runx requires
/// a dotted namespace (`frantic.post`). Dots become underscores on the wire in
/// every outbound place a tool name appears (the tool list and the replayed
/// assistant `tool_use` blocks); [`AnthropicModelCaller::real_tool_name`] maps
/// the model's call back to the dotted ref on the way in.
fn wire_tool_name(name: &str) -> String {
    name.replace('.', "_")
}

/// Convert a runx `JsonValue` to a wire `serde_json::Value`. A plain value never
/// fails to serialize; default to null rather than propagate an impossible error.
fn to_wire(value: &JsonValue) -> WireValue {
    serde_json::to_value(value).unwrap_or(WireValue::Null)
}

fn failure(message: String) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: MANAGED_AGENT_SKILL.to_owned(),
        message,
    }
}

fn messages_json(transcript: &[AgentTurn]) -> Vec<WireValue> {
    transcript
        .iter()
        .map(|turn| match turn {
            AgentTurn::User(text) => json!({
                "role": "user",
                "content": [{ "type": "text", "text": text }],
            }),
            AgentTurn::AssistantToolUses(uses) => json!({
                "role": "assistant",
                "content": uses
                    .iter()
                    .map(|use_| json!({
                        "type": "tool_use",
                        "id": use_.id,
                        "name": wire_tool_name(&use_.name),
                        "input": to_wire(&use_.input),
                    }))
                    .collect::<Vec<WireValue>>(),
            }),
            AgentTurn::ToolResults(results) => json!({
                "role": "user",
                "content": results
                    .iter()
                    .map(|result| json!({
                        "type": "tool_result",
                        "tool_use_id": result.tool_use_id,
                        "content": result.content,
                        "is_error": result.is_error,
                    }))
                    .collect::<Vec<WireValue>>(),
            }),
        })
        .collect()
}

fn parse_tool_uses(body: &str) -> Result<Vec<AgentToolUse>, RuntimeError> {
    let value: WireValue = serde_json::from_str(body)
        .map_err(|source| RuntimeError::json("parsing anthropic response", source))?;
    let Some(content) = value.get("content").and_then(WireValue::as_array) else {
        return Ok(Vec::new());
    };
    let mut uses = Vec::new();
    for block in content {
        if block.get("type").and_then(WireValue::as_str) != Some("tool_use") {
            continue;
        }
        let (Some(id), Some(name)) = (
            block.get("id").and_then(WireValue::as_str),
            block.get("name").and_then(WireValue::as_str),
        ) else {
            continue;
        };
        let input_wire = block.get("input").cloned().unwrap_or(WireValue::Null);
        let input = serde_json::from_value(input_wire).unwrap_or(JsonValue::Null);
        uses.push(AgentToolUse {
            id: id.to_owned(),
            name: name.to_owned(),
            input,
        });
    }
    Ok(uses)
}

impl<T: RuntimeHttpTransport> ModelCaller for AnthropicModelCaller<T> {
    fn next_tool_uses(&self, transcript: &[AgentTurn]) -> Result<Vec<AgentToolUse>, RuntimeError> {
        let request_body = json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "messages": messages_json(transcript),
            "tools": self.tools_json(),
        });
        let request_body = serde_json::to_string(&request_body)
            .map_err(|source| RuntimeError::json("serializing anthropic request", source))?;
        let response = self
            .transport
            .send(RuntimeHttpRequest {
                method: HttpMethod::Post,
                url: self.url.clone(),
                headers: vec![
                    RuntimeHttpHeader::new("x-api-key", self.api_key.expose()),
                    RuntimeHttpHeader::new("anthropic-version", ANTHROPIC_VERSION),
                    RuntimeHttpHeader::new("content-type", "application/json"),
                ],
                body: Some(request_body),
            })
            .map_err(|source| failure(format!("anthropic request failed: {source}")))?;
        if !(200..300).contains(&response.status) {
            return Err(failure(format!(
                "anthropic returned status {}",
                response.status
            )));
        }
        let mut uses = parse_tool_uses(&response.body)?;
        for use_ in &mut uses {
            use_.name = self.real_tool_name(&use_.name);
        }
        Ok(uses)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::agent_loop::AgentTurn;
    use crate::http::{RuntimeHttpError, RuntimeHttpRequest, RuntimeHttpResponse};
    use std::cell::RefCell;

    struct StubTransport {
        body: String,
        status: u16,
        requests: RefCell<Vec<RuntimeHttpRequest>>,
    }

    impl RuntimeHttpTransport for &StubTransport {
        fn send(
            &self,
            request: RuntimeHttpRequest,
        ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
            self.requests.borrow_mut().push(request);
            Ok(RuntimeHttpResponse {
                status: self.status,
                body: self.body.clone(),
            })
        }
    }

    fn caller(stub: &StubTransport) -> AnthropicModelCaller<&StubTransport> {
        AnthropicModelCaller::new(
            stub,
            SecretString::new("key"),
            "claude".to_owned(),
            Vec::new(),
        )
    }

    #[test]
    fn parses_tool_use_from_response() {
        let stub = StubTransport {
            body: r#"{"content":[{"type":"text","text":"thinking"},{"type":"tool_use","id":"tu_1","name":"pay","input":{"amount":50}}]}"#
                .to_owned(),
            status: 200,
            requests: RefCell::new(Vec::new()),
        };
        let result = caller(&stub).next_tool_uses(&[AgentTurn::User("buy a quota".to_owned())]);
        assert!(
            matches!(
                &result,
                Ok(uses) if uses.len() == 1 && uses[0].name == "pay" && uses[0].id == "tu_1"
            ),
            "should parse the tool_use block; got: {result:?}"
        );
        let sent = stub.requests.borrow();
        assert!(
            sent.len() == 1
                && sent[0].body.as_deref().is_some_and(|body| {
                    body.contains("\"model\":\"claude\"") && body.contains("buy a quota")
                }),
            "request body should carry the model and prompt; got: {:?}",
            sent.first().and_then(|request| request.body.as_deref())
        );
    }

    #[test]
    fn namespaced_tool_ref_is_flattened_on_the_wire_and_restored_on_the_way_in()
    -> Result<(), String> {
        let stub = StubTransport {
            body:
                r#"{"content":[{"type":"tool_use","id":"tu_1","name":"frantic_post","input":{}}]}"#
                    .to_owned(),
            status: 200,
            requests: RefCell::new(Vec::new()),
        };
        let model = AnthropicModelCaller::new(
            &stub,
            SecretString::new("key"),
            "claude".to_owned(),
            vec![AgentToolDefinition {
                name: "frantic.post".to_owned(),
                description: "post".to_owned(),
                input_schema: {
                    let mut schema = runx_contracts::JsonObject::new();
                    schema.insert("type".to_owned(), JsonValue::String("object".to_owned()));
                    JsonValue::Object(schema)
                },
            }],
        );
        let uses = model
            .next_tool_uses(&[AgentTurn::User("go".to_owned())])
            .map_err(|error| format!("call should succeed: {error}"))?;
        // The model's flattened call maps back to the dotted runx tool ref.
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].name, "frantic.post");
        // The tool was offered to Anthropic without a dot (the API rejects dots).
        let sent = stub.requests.borrow();
        let body = sent[0].body.as_deref().unwrap_or_default();
        assert!(
            body.contains("\"frantic_post\"") && !body.contains("frantic.post"),
            "tool must be offered flattened, never dotted; got: {body}"
        );
        Ok(())
    }

    #[test]
    fn non_success_status_is_an_error() {
        let stub = StubTransport {
            body: "rate limited".to_owned(),
            status: 429,
            requests: RefCell::new(Vec::new()),
        };
        let result = caller(&stub).next_tool_uses(&[AgentTurn::User("go".to_owned())]);
        assert!(
            matches!(&result, Err(RuntimeError::SkillFailed { message, .. }) if message.contains("429")),
            "non-2xx should be an error; got: {result:?}"
        );
    }

    #[test]
    fn no_tool_use_blocks_yields_empty() {
        let stub = StubTransport {
            body: r#"{"content":[{"type":"text","text":"done"}]}"#.to_owned(),
            status: 200,
            requests: RefCell::new(Vec::new()),
        };
        let result = caller(&stub).next_tool_uses(&[AgentTurn::User("go".to_owned())]);
        assert!(
            matches!(&result, Ok(uses) if uses.is_empty()),
            "no tool_use blocks should yield no uses; got: {result:?}"
        );
    }

    #[test]
    fn malformed_json_body_is_a_parse_error() {
        let stub = StubTransport {
            body: "not json at all".to_owned(),
            status: 200,
            requests: RefCell::new(Vec::new()),
        };
        let result = caller(&stub).next_tool_uses(&[AgentTurn::User("go".to_owned())]);
        assert!(
            result.is_err(),
            "a malformed body must error, not panic; got: {result:?}"
        );
    }

    #[test]
    fn absent_content_yields_empty() {
        let stub = StubTransport {
            body: "{}".to_owned(),
            status: 200,
            requests: RefCell::new(Vec::new()),
        };
        let result = caller(&stub).next_tool_uses(&[AgentTurn::User("go".to_owned())]);
        assert!(
            matches!(&result, Ok(uses) if uses.is_empty()),
            "a response with no content array should yield no uses; got: {result:?}"
        );
    }

    #[test]
    fn tool_use_block_missing_id_or_name_is_skipped() {
        // One block missing id, one missing name, one well-formed: only the
        // well-formed block survives. A partial block is never half-parsed.
        let stub = StubTransport {
            body: r#"{"content":[
                {"type":"tool_use","name":"no_id","input":{}},
                {"type":"tool_use","id":"no_name","input":{}},
                {"type":"tool_use","id":"ok","name":"pay","input":{"a":1}}
            ]}"#
            .to_owned(),
            status: 200,
            requests: RefCell::new(Vec::new()),
        };
        let result = caller(&stub).next_tool_uses(&[AgentTurn::User("go".to_owned())]);
        assert!(
            matches!(&result, Ok(uses) if uses.len() == 1 && uses[0].id == "ok" && uses[0].name == "pay"),
            "blocks missing id or name must be skipped; got: {result:?}"
        );
    }

    #[test]
    fn tool_use_missing_input_defaults_to_null() {
        let stub = StubTransport {
            body: r#"{"content":[{"type":"tool_use","id":"t","name":"pay"}]}"#.to_owned(),
            status: 200,
            requests: RefCell::new(Vec::new()),
        };
        let result = caller(&stub).next_tool_uses(&[AgentTurn::User("go".to_owned())]);
        assert!(
            matches!(&result, Ok(uses) if uses.len() == 1 && matches!(uses[0].input, JsonValue::Null)),
            "a tool_use with no input defaults to a null input; got: {result:?}"
        );
    }
}
