from tool_schemas import Plan, StepResult

_CONJUNCTIONS = (" and ", " then ", ",", ";")


def needs_planning(message: str) -> bool:
    """True if the prompt is multi-step enough to warrant a plan."""
    msg = message.strip()
    if len(msg.split()) > 8:
        return True
    lower = f" {msg.lower()} "
    return any(c in lower for c in _CONJUNCTIONS)


def compose_final_answer(plan: Plan, results: list[StepResult]) -> str:
    """Render a markdown summary of plan execution."""
    n_total = len(plan.steps)
    n_done = sum(1 for r in results if r.status == "done")
    by_id = {r.step_id: r for r in results}

    lines = [f"**Plan executed** ({n_done}/{n_total} steps completed)", ""]
    for step in plan.steps:
        r = by_id.get(step.step_id)
        if r is None:
            lines.append(f"{step.step_id}. {step.description} — _not run_")
        else:
            mark = "✓" if r.status == "done" else "✗"
            lines.append(f"{step.step_id}. {mark} {step.description} — {r.summary}")
    lines.append("")

    failed = [r for r in results if r.status == "failed"]
    if failed:
        lines.append("Failed steps:")
        for r in failed:
            lines.append(f"- step {r.step_id}: {r.summary}")
    else:
        if results:
            lines.append(results[-1].summary)
    return "\n".join(lines)
