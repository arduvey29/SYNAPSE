from orchestration import needs_planning, compose_final_answer
from tool_schemas import Plan, PlanStep, StepResult


def test_needs_planning_short_simple():
    assert needs_planning("kernel version") is False
    assert needs_planning("list pods") is False


def test_needs_planning_long_or_compound():
    assert needs_planning("build an image and run it and curl the endpoint") is True
    assert needs_planning("a b c d e f g h i j k") is True
    assert needs_planning("start a server, then check it") is True


def test_compose_final_all_done():
    plan = Plan(reasoning="r", steps=[
        PlanStep(step_id=1, description="d1", intended_tool="reasoning", success_criteria="ok"),
        PlanStep(step_id=2, description="d2", intended_tool="reasoning", success_criteria="ok"),
    ])
    results = [
        StepResult(step_id=1, status="done", summary="s1"),
        StepResult(step_id=2, status="done", summary="s2"),
    ]
    out = compose_final_answer(plan, results)
    assert "2/2" in out
    assert "d1" in out and "s1" in out


def test_compose_final_with_failure():
    plan = Plan(reasoning="r", steps=[
        PlanStep(step_id=1, description="d1", intended_tool="reasoning", success_criteria="ok"),
        PlanStep(step_id=2, description="d2", intended_tool="reasoning", success_criteria="ok"),
    ])
    results = [
        StepResult(step_id=1, status="done", summary="s1"),
        StepResult(step_id=2, status="failed", summary="boom"),
    ]
    out = compose_final_answer(plan, results)
    assert "1/2" in out
    assert "boom" in out
