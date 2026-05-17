import json
import logging
import re
from typing import Optional
from pydantic import ValidationError

from tool_schemas import Plan

logger = logging.getLogger("synapse.planner")

_PLAN_INSTRUCTION = """You are SYNAPSE's planner. Given a user request and a list of available tools, output a JSON plan.

OUTPUT FORMAT - strict JSON, no markdown fences, no commentary:
{{
  "reasoning": "1-3 sentences on why this plan",
  "steps": [
    {{"step_id": 1, "description": "...", "intended_tool": "<tool name or 'reasoning'>",
      "success_criteria": "..."}},
    ...
  ]
}}

Rules:
- At most 10 steps. Each step is atomic - one tool call's worth of work.
- intended_tool must be one of: {tool_list} (or "reasoning" if no tool is needed).
- If a step is destructive (rm -rf, format, drop database), include the word "destructive" in the description.
- Return ONLY the JSON object."""


_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_code_fences(text: str) -> str:
    text = text.strip()
    m = _FENCE_RE.match(text)
    if m:
        return m.group(1).strip()
    return text


class Planner:
    """Wraps the LLM to produce a Plan JSON from a user request."""

    def __init__(self, router, tool_names: list[str]):
        self.router = router
        self.tool_names = tool_names

    def _instruction(self) -> str:
        return _PLAN_INSTRUCTION.format(tool_list=", ".join(self.tool_names))

    def _invoke(self, prompt: str) -> str:
        llm = self.router.get_llm()
        response = llm.invoke([
            {"role": "system", "content": self._instruction()},
            {"role": "user", "content": prompt},
        ])
        return getattr(response, "content", str(response))

    def _parse(self, raw: str) -> Optional[Plan]:
        try:
            data = json.loads(_strip_code_fences(raw))
            return Plan(**data)
        except (json.JSONDecodeError, ValidationError) as e:
            logger.warning("Planner parse failed: %s", e)
            return None

    def plan(self, user_message: str, session_context: str = "") -> Optional[Plan]:
        """Returns Plan or None if parsing fails twice."""
        prompt = user_message
        if session_context:
            prompt = f"{session_context}\n\nUser request: {user_message}"

        raw = self._invoke(prompt)
        parsed = self._parse(raw)
        if parsed is not None:
            return parsed

        retry_prompt = (
            f"{prompt}\n\nYour previous reply was not valid JSON. "
            "Return ONLY the JSON object, no fences, no prose."
        )
        raw2 = self._invoke(retry_prompt)
        return self._parse(raw2)

    def replan(self, original: Plan, completed_step_ids: list[int],
               failure_context: str) -> Optional[Plan]:
        completed = [s for s in original.steps if s.step_id in completed_step_ids]
        completed_str = "\n".join(
            f"- step {s.step_id}: {s.description}" for s in completed
        ) or "(none)"
        prompt = (
            f"We were executing this plan:\n{original.model_dump_json()}\n\n"
            f"Completed steps:\n{completed_str}\n\n"
            f"Failure context: {failure_context}\n\n"
            "Produce a new plan that takes us from here to the user's original goal. "
            "Do not repeat completed steps."
        )
        raw = self._invoke(prompt)
        return self._parse(raw)
