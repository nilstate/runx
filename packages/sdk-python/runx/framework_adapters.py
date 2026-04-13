from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from . import RunxClient


@dataclass(frozen=True)
class FrameworkBoundaryContext:
    request: Mapping[str, Any]
    events: tuple[Mapping[str, Any], ...] = ()


FrameworkBoundaryResolver = Callable[[FrameworkBoundaryContext], Any | None]


@dataclass(frozen=True)
class FrameworkPausedResult:
    status: str
    skill_name: str
    run_id: str
    requests: tuple[Mapping[str, Any], ...]
    step_ids: tuple[str, ...] = ()
    step_labels: tuple[str, ...] = ()
    events: tuple[Mapping[str, Any], ...] = ()


@dataclass(frozen=True)
class FrameworkCompletedResult:
    status: str
    skill_name: str
    receipt_id: str
    output: str
    events: tuple[Mapping[str, Any], ...] = ()


@dataclass(frozen=True)
class FrameworkFailedResult:
    status: str
    skill_name: str
    error: str
    receipt_id: str | None = None
    events: tuple[Mapping[str, Any], ...] = ()


@dataclass(frozen=True)
class FrameworkDeniedResult:
    status: str
    skill_name: str
    reasons: tuple[str, ...]
    receipt_id: str | None = None
    events: tuple[Mapping[str, Any], ...] = ()


FrameworkRunResult = (
    FrameworkPausedResult
    | FrameworkCompletedResult
    | FrameworkFailedResult
    | FrameworkDeniedResult
)


class FrameworkBridge:
    def __init__(self, client: RunxClient) -> None:
        self.client = client

    def run(
        self,
        skill_path: str,
        inputs: Mapping[str, Any] | None = None,
        resolver: FrameworkBoundaryResolver | None = None,
    ) -> FrameworkRunResult:
        initial = self.client.run_skill(skill_path, inputs=inputs, non_interactive=True)
        return self._drive(initial, resolver=resolver)

    def resume(
        self,
        run_id: str,
        resolver: FrameworkBoundaryResolver | None = None,
    ) -> FrameworkRunResult:
        initial = self.client.resume_run(run_id)
        return self._drive(initial, resolver=resolver)

    def _drive(
        self,
        payload: Mapping[str, Any],
        resolver: FrameworkBoundaryResolver | None,
    ) -> FrameworkRunResult:
        current = dict(payload)
        while True:
            result = normalize_framework_result(current)
            if not isinstance(result, FrameworkPausedResult):
                return result
            if resolver is None:
                return result

            answers: dict[str, Any] = {}
            approvals: dict[str, bool] = {}
            for request in result.requests:
                reply = resolver(FrameworkBoundaryContext(request=request, events=result.events))
                normalized = _normalize_resolution_reply(request, reply)
                if normalized is None:
                    continue
                if request.get("kind") == "approval":
                    gate = request.get("gate") or {}
                    gate_id = str(gate.get("id") or "")
                    approvals[gate_id] = bool(normalized["payload"])
                    continue
                request_id = str(request.get("id") or "")
                answers[request_id] = normalized["payload"]

            if not answers and not approvals:
                return result

            current = self.client.resume_run(result.run_id, answers=answers, approvals=approvals)


class ProviderFrameworkAdapter:
    def __init__(self, bridge: FrameworkBridge, formatter: Callable[[FrameworkRunResult], Mapping[str, Any]]) -> None:
        self.bridge = bridge
        self.formatter = formatter

    def run(
        self,
        skill_path: str,
        inputs: Mapping[str, Any] | None = None,
        resolver: FrameworkBoundaryResolver | None = None,
    ) -> Mapping[str, Any]:
        return self.formatter(self.bridge.run(skill_path, inputs=inputs, resolver=resolver))

    def resume(
        self,
        run_id: str,
        resolver: FrameworkBoundaryResolver | None = None,
    ) -> Mapping[str, Any]:
        return self.formatter(self.bridge.resume(run_id, resolver=resolver))


def create_framework_bridge(client: RunxClient) -> FrameworkBridge:
    return FrameworkBridge(client)


def create_openai_adapter(bridge: FrameworkBridge) -> ProviderFrameworkAdapter:
    return ProviderFrameworkAdapter(bridge, _to_openai_response)


def create_anthropic_adapter(bridge: FrameworkBridge) -> ProviderFrameworkAdapter:
    return ProviderFrameworkAdapter(bridge, _to_anthropic_response)


def create_vercel_ai_adapter(bridge: FrameworkBridge) -> ProviderFrameworkAdapter:
    return ProviderFrameworkAdapter(bridge, _to_vercel_response)


def create_langchain_adapter(bridge: FrameworkBridge) -> ProviderFrameworkAdapter:
    return ProviderFrameworkAdapter(bridge, _to_langchain_response)


def create_crewai_adapter(bridge: FrameworkBridge) -> ProviderFrameworkAdapter:
    return ProviderFrameworkAdapter(bridge, _to_crewai_response)


def normalize_framework_result(payload: Mapping[str, Any]) -> FrameworkRunResult:
    status = str(payload.get("status") or "")
    skill = payload.get("skill")
    skill_name = str(skill.get("name")) if isinstance(skill, Mapping) else str(skill or "")
    if status == "needs_resolution":
        return FrameworkPausedResult(
            status="paused",
            skill_name=skill_name,
            run_id=str(payload.get("run_id") or ""),
            requests=tuple(payload.get("requests") or ()),
            step_ids=tuple(str(item) for item in payload.get("step_ids") or ()),
            step_labels=tuple(str(item) for item in payload.get("step_labels") or ()),
        )
    if status == "policy_denied":
        reasons = payload.get("reasons") or ()
        receipt = payload.get("receipt") or {}
        return FrameworkDeniedResult(
            status="denied",
            skill_name=skill_name,
            reasons=tuple(str(item) for item in reasons),
            receipt_id=_nested_str(receipt, "id"),
        )
    if status == "success":
        execution = payload.get("execution") or {}
        receipt = payload.get("receipt") or {}
        return FrameworkCompletedResult(
            status="completed",
            skill_name=skill_name,
            receipt_id=str(receipt.get("id") or ""),
            output=str(execution.get("stdout") or ""),
        )
    execution = payload.get("execution") or {}
    receipt = payload.get("receipt") or {}
    error = str(execution.get("errorMessage") or execution.get("stderr") or execution.get("stdout") or "")
    return FrameworkFailedResult(
        status="failed",
        skill_name=skill_name,
        error=error,
        receipt_id=_nested_str(receipt, "id"),
    )


def _normalize_resolution_reply(
    request: Mapping[str, Any],
    reply: Any | None,
) -> Mapping[str, Any] | None:
    if reply is None:
        return None
    if isinstance(reply, Mapping) and "actor" in reply and "payload" in reply:
        return {
            "actor": str(reply.get("actor") or _default_actor_for_request(request)),
            "payload": reply.get("payload"),
        }
    if isinstance(reply, Mapping) and "payload" in reply:
        return {
            "actor": str(reply.get("actor") or _default_actor_for_request(request)),
            "payload": reply.get("payload"),
        }
    if isinstance(reply, bool) and request.get("kind") == "approval":
        return {"actor": "human", "payload": reply}
    return {
        "actor": _default_actor_for_request(request),
        "payload": reply,
    }


def _default_actor_for_request(request: Mapping[str, Any]) -> str:
    return "agent" if request.get("kind") == "cognitive_work" else "human"


def _summary(result: FrameworkRunResult) -> str:
    if isinstance(result, FrameworkCompletedResult):
        return f"{result.skill_name} completed. Inspect receipt {result.receipt_id}."
    if isinstance(result, FrameworkPausedResult):
        return f"{result.skill_name} paused at {result.run_id}. Resume after resolving {len(result.requests)} request(s)."
    if isinstance(result, FrameworkDeniedResult):
        return f"{result.skill_name} was denied by policy."
    return f"{result.skill_name} failed. Inspect receipt {result.receipt_id or 'n/a'}."


def _to_openai_response(result: FrameworkRunResult) -> Mapping[str, Any]:
    return {
        "role": "tool",
        "content": [{"type": "text", "text": _summary(result)}],
        "structuredContent": {"runx": _result_to_dict(result)},
    }


def _to_anthropic_response(result: FrameworkRunResult) -> Mapping[str, Any]:
    return {
        "content": [{"type": "text", "text": _summary(result)}],
        "metadata": {"runx": _result_to_dict(result)},
    }


def _to_vercel_response(result: FrameworkRunResult) -> Mapping[str, Any]:
    return {
        "messages": [{"role": "assistant", "content": _summary(result)}],
        "data": {"runx": _result_to_dict(result)},
    }


def _to_langchain_response(result: FrameworkRunResult) -> Mapping[str, Any]:
    return {
        "content": _summary(result),
        "additional_kwargs": {"runx": _result_to_dict(result)},
    }


def _to_crewai_response(result: FrameworkRunResult) -> Mapping[str, Any]:
    return {
        "raw": _summary(result),
        "json_dict": {"runx": _result_to_dict(result)},
    }


def _result_to_dict(result: FrameworkRunResult) -> Mapping[str, Any]:
    if isinstance(result, FrameworkPausedResult):
        return {
            "status": result.status,
            "skill_name": result.skill_name,
            "run_id": result.run_id,
            "requests": list(result.requests),
            "step_ids": list(result.step_ids),
            "step_labels": list(result.step_labels),
            "events": list(result.events),
        }
    if isinstance(result, FrameworkCompletedResult):
        return {
            "status": result.status,
            "skill_name": result.skill_name,
            "receipt_id": result.receipt_id,
            "output": result.output,
            "events": list(result.events),
        }
    if isinstance(result, FrameworkDeniedResult):
        return {
            "status": result.status,
            "skill_name": result.skill_name,
            "reasons": list(result.reasons),
            "receipt_id": result.receipt_id,
            "events": list(result.events),
        }
    return {
        "status": result.status,
        "skill_name": result.skill_name,
        "error": result.error,
        "receipt_id": result.receipt_id,
        "events": list(result.events),
    }


def _nested_str(record: Mapping[str, Any], key: str) -> str | None:
    value = record.get(key)
    return None if value is None else str(value)
