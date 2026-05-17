import json
from unittest.mock import MagicMock
from planner import Planner, _strip_code_fences, _PLAN_INSTRUCTION
from tool_schemas import Plan


def _fake_router_returning(text: str):
    """Build a fake ModelRouter whose .get_llm().invoke(...) returns an AIMessage-like obj."""
    msg = MagicMock(); msg.content = text
    llm = MagicMock(); llm.invoke = MagicMock(return_value=msg)
    router = MagicMock(); router.get_llm = MagicMock(return_value=llm)
    return router, llm


def test_strip_code_fences():
    assert _strip_code_fences("```json\n{\"a\":1}\n```") == '{"a":1}'
    assert _strip_code_fences("```\n{\"a\":1}\n```") == '{"a":1}'
    assert _strip_code_fences('{"a":1}') == '{"a":1}'


def test_plan_parses_valid_json():
    valid = json.dumps({
        "reasoning": "two-step flow",
        "steps": [
            {"step_id": 1, "description": "list containers",
             "intended_tool": "RunDockerCommand", "success_criteria": "ps returns 0"},
            {"step_id": 2, "description": "report count",
             "intended_tool": "reasoning", "success_criteria": "user gets number"},
        ],
    })
    router, llm = _fake_router_returning(valid)
    p = Planner(router=router, tool_names=["RunDockerCommand", "reasoning"])
    plan = p.plan("count my containers")
    assert isinstance(plan, Plan)
    assert len(plan.steps) == 2
    assert plan.steps[0].intended_tool == "RunDockerCommand"


def test_plan_strips_fences():
    fenced = "```json\n" + json.dumps({
        "reasoning": "single", "steps": [
            {"step_id": 1, "description": "x", "intended_tool": "reasoning",
             "success_criteria": "ok"}]
    }) + "\n```"
    router, _ = _fake_router_returning(fenced)
    p = Planner(router=router, tool_names=["reasoning"])
    plan = p.plan("hi")
    assert plan.steps[0].description == "x"


def test_plan_retries_on_parse_error_then_succeeds():
    msg_bad = MagicMock(); msg_bad.content = "not json at all"
    valid = json.dumps({
        "reasoning": "fix", "steps": [
            {"step_id": 1, "description": "ok now", "intended_tool": "reasoning",
             "success_criteria": "ok"}]
    })
    msg_good = MagicMock(); msg_good.content = valid
    llm = MagicMock(); llm.invoke = MagicMock(side_effect=[msg_bad, msg_good])
    router = MagicMock(); router.get_llm = MagicMock(return_value=llm)
    p = Planner(router=router, tool_names=["reasoning"])
    plan = p.plan("hi")
    assert llm.invoke.call_count == 2
    assert plan.steps[0].description == "ok now"


def test_plan_returns_none_after_two_failures():
    bad = MagicMock(); bad.content = "still not json"
    llm = MagicMock(); llm.invoke = MagicMock(return_value=bad)
    router = MagicMock(); router.get_llm = MagicMock(return_value=llm)
    p = Planner(router=router, tool_names=["reasoning"])
    plan = p.plan("hi")
    assert plan is None
