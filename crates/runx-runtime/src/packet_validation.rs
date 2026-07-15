use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use runx_contracts::{JsonObject, JsonValue, sha256_prefixed};
use runx_parser::SkillArtifactContract;

use crate::RuntimeError;

const PACKET_ID_FIELD: &str = "x-runx-packet-id";

pub(crate) fn verify_declared_packets(
    payload: &JsonValue,
    typed_artifacts: Option<&SkillArtifactContract>,
    inline_artifacts: Option<&JsonObject>,
    skill_directory: &Path,
    env: &BTreeMap<String, String>,
) -> Result<JsonObject, RuntimeError> {
    let bindings = packet_bindings(payload, typed_artifacts, inline_artifacts)?;
    if bindings.is_empty() {
        return Ok(JsonObject::new());
    }

    let schemas = discover_packet_schemas(skill_directory, env)?;
    let mut evidence = JsonObject::new();
    for binding in bindings {
        let (output, verified) = verify_packet_binding(binding, &schemas)?;
        evidence.insert(output, verified);
    }
    Ok(evidence)
}

fn verify_packet_binding(
    binding: PacketBinding<'_>,
    schemas: &BTreeMap<String, PacketSchema>,
) -> Result<(String, JsonValue), RuntimeError> {
    let schema = schemas
        .get(&binding.packet)
        .ok_or_else(|| packet_error(&binding, "declared packet schema was not found"))?;
    let schema_document = serde_json::to_value(&schema.value)
        .map_err(|source| RuntimeError::json("serializing packet schema for validation", source))?;
    let validator = jsonschema::draft202012::options()
        .build(&schema_document)
        .map_err(|error| packet_error(&binding, format!("packet schema is invalid: {error}")))?;
    let instance = serde_json::to_value(binding.value).map_err(|source| {
        RuntimeError::json("serializing agent packet output for validation", source)
    })?;
    validator
        .validate(&instance)
        .map_err(|error| packet_error(&binding, format!("output violates schema: {error}")))?;
    let verified = JsonValue::Object(
        [
            ("packet".to_owned(), JsonValue::String(binding.packet)),
            (
                "schema_sha256".to_owned(),
                JsonValue::String(schema.sha256.clone()),
            ),
        ]
        .into_iter()
        .collect(),
    );
    Ok((binding.output, verified))
}

fn packet_error(binding: &PacketBinding<'_>, detail: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: "agent".to_owned(),
        message: format!(
            "packet output '{}' for '{}': {detail}",
            binding.output, binding.packet
        ),
    }
}

struct PacketBinding<'a> {
    output: String,
    packet: String,
    value: &'a JsonValue,
}

fn packet_bindings<'a>(
    payload: &'a JsonValue,
    typed: Option<&SkillArtifactContract>,
    inline: Option<&JsonObject>,
) -> Result<Vec<PacketBinding<'a>>, RuntimeError> {
    let object = payload
        .as_object()
        .ok_or_else(|| RuntimeError::SkillFailed {
            skill_name: "agent".to_owned(),
            message: "packet-producing agent output must be an object".to_owned(),
        })?;
    let mut bindings = Vec::new();
    if let Some(artifacts) = typed {
        if let Some(named) = &artifacts.packets {
            for (output, packet) in named {
                bindings.push(named_binding(object, output, packet)?);
            }
        }
        if let (Some(output), Some(packet)) = (&artifacts.wrap_as, &artifacts.packet) {
            bindings.push(PacketBinding {
                output: output.clone(),
                packet: packet.clone(),
                value: payload,
            });
        }
    }
    if let Some(artifacts) = inline {
        if let Some(JsonValue::Object(named)) = artifacts.get("packets") {
            for (output, packet) in named {
                let packet = packet.as_str().ok_or_else(|| RuntimeError::SkillFailed {
                    skill_name: "agent".to_owned(),
                    message: format!("packet id for named output '{output}' must be a string"),
                })?;
                bindings.push(named_binding(object, output, packet)?);
            }
        }
        if let (Some(output), Some(packet)) = (
            artifacts.get("wrap_as").and_then(JsonValue::as_str),
            artifacts.get("packet").and_then(JsonValue::as_str),
        ) {
            bindings.push(PacketBinding {
                output: output.to_owned(),
                packet: packet.to_owned(),
                value: payload,
            });
        }
    }
    Ok(bindings)
}

fn named_binding<'a>(
    payload: &'a JsonObject,
    output: &str,
    packet: &str,
) -> Result<PacketBinding<'a>, RuntimeError> {
    let value = payload
        .get(output)
        .ok_or_else(|| RuntimeError::SkillFailed {
            skill_name: "agent".to_owned(),
            message: format!("named packet output '{output}' was not returned"),
        })?;
    Ok(PacketBinding {
        output: output.to_owned(),
        packet: packet.to_owned(),
        value,
    })
}

struct PacketSchema {
    value: JsonValue,
    sha256: String,
}

fn discover_packet_schemas(
    skill_directory: &Path,
    env: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, PacketSchema>, RuntimeError> {
    let mut directories = BTreeSet::new();
    directories.insert(skill_directory.join("packets"));
    for ancestor in skill_directory.ancestors() {
        directories.insert(ancestor.join("packets"));
        directories.insert(ancestor.join("dist").join("packets"));
    }
    let root = crate::config::resolve_runx_workspace_base(env, skill_directory);
    directories.insert(root.join("packets"));
    directories.insert(root.join("dist").join("packets"));

    let mut schemas = BTreeMap::<String, PacketSchema>::new();
    for directory in directories {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        let mut paths = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            let source = fs::read_to_string(&path).map_err(|error| {
                RuntimeError::io(format!("reading packet schema {}", path.display()), error)
            })?;
            let value = serde_json::from_str::<JsonValue>(&source).map_err(|source| {
                RuntimeError::json(format!("parsing packet schema {}", path.display()), source)
            })?;
            let Some(packet_id) = value
                .as_object()
                .and_then(|object| object.get(PACKET_ID_FIELD))
                .and_then(JsonValue::as_str)
            else {
                continue;
            };
            let sha256 = sha256_prefixed(source.as_bytes());
            if let Some(existing) = schemas.get(packet_id) {
                if existing.sha256 != sha256 {
                    return Err(RuntimeError::SkillFailed {
                        skill_name: "agent".to_owned(),
                        message: format!(
                            "packet schema id '{packet_id}' resolves to conflicting documents"
                        ),
                    });
                }
                continue;
            }
            schemas.insert(packet_id.to_owned(), PacketSchema { value, sha256 });
        }
    }
    Ok(schemas)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;

    use runx_contracts::JsonValue;
    use runx_parser::SkillArtifactContract;

    use super::verify_declared_packets;

    fn temp_skill() -> Result<tempfile::TempDir, std::io::Error> {
        let directory = tempfile::tempdir()?;
        fs::create_dir_all(directory.path().join("packets"))?;
        Ok(directory)
    }

    fn artifacts() -> SkillArtifactContract {
        SkillArtifactContract {
            emits: None,
            named_emits: Some(BTreeMap::from([("plan".to_owned(), "plan".to_owned())])),
            packets: Some(BTreeMap::from([(
                "plan".to_owned(),
                "runx.test.plan.v1".to_owned(),
            )])),
            wrap_as: None,
            packet: None,
        }
    }

    fn payload(value: JsonValue) -> JsonValue {
        JsonValue::Object(BTreeMap::from([("plan".to_owned(), value)]))
    }

    fn write_schema(skill: &std::path::Path) -> Result<(), std::io::Error> {
        fs::write(
            skill.join("packets/plan.schema.json"),
            r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "x-runx-packet-id": "runx.test.plan.v1",
  "type": "object",
  "required": ["decision"],
  "properties": {"decision": {"type": "string"}},
  "additionalProperties": false
}
"#,
        )?;
        Ok(())
    }

    #[test]
    fn declared_packet_schema_is_verified_and_pinned() -> Result<(), Box<dyn std::error::Error>> {
        let skill = temp_skill()?;
        write_schema(skill.path())?;
        let value = payload(JsonValue::Object(BTreeMap::from([(
            "decision".to_owned(),
            JsonValue::String("ready".to_owned()),
        )])));

        let evidence = verify_declared_packets(
            &value,
            Some(&artifacts()),
            None,
            skill.path(),
            &BTreeMap::new(),
        )?;

        let Some(plan) = evidence.get("plan").and_then(JsonValue::as_object) else {
            return Err("plan evidence is missing".into());
        };
        assert_eq!(
            plan.get("packet").and_then(JsonValue::as_str),
            Some("runx.test.plan.v1")
        );
        assert!(
            plan.get("schema_sha256")
                .and_then(JsonValue::as_str)
                .is_some_and(|value| value.starts_with("sha256:"))
        );
        Ok(())
    }

    #[test]
    fn invalid_packet_output_cannot_seal() -> Result<(), Box<dyn std::error::Error>> {
        let skill = temp_skill()?;
        write_schema(skill.path())?;
        let value = payload(JsonValue::Object(BTreeMap::from([(
            "decision".to_owned(),
            JsonValue::Bool(true),
        )])));

        assert!(
            verify_declared_packets(
                &value,
                Some(&artifacts()),
                None,
                skill.path(),
                &BTreeMap::new(),
            )
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn missing_packet_schema_cannot_seal() -> Result<(), Box<dyn std::error::Error>> {
        let skill = temp_skill()?;
        let value = payload(JsonValue::Object(BTreeMap::from([(
            "decision".to_owned(),
            JsonValue::String("ready".to_owned()),
        )])));

        assert!(
            verify_declared_packets(
                &value,
                Some(&artifacts()),
                None,
                skill.path(),
                &BTreeMap::new(),
            )
            .is_err()
        );
        Ok(())
    }
}
