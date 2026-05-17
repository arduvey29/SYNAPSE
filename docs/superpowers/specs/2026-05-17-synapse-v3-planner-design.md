# SYNAPSE v3 — Planner/Executor, Local Docker + Kubernetes, Mission-Control UI

> Iteration on SYNAPSE v2. Adds reliable multi-step task execution via planner/executor, moves Docker/Kubernetes off the RHEL SSH path onto the local host, and redesigns the UI into a two-pane mission-control layout. Additive — does not rewrite ModelRouter, agent_memory, or the existing tool registry.

## 1. Goals & Non-Goals

**Goals**
- A user prompt like *"build a custom CentOS Docker image with Flask, run it, curl it, SMS me the output"* completes end-to-end without manual recovery.
- A user prompt like *"spin up an EC2, install Python, email me when done"* same.
- The UI shows a live plan and per-step status while execution streams.
- Docker and `kubectl` run locally on the host (Windows + Docker Desktop). RHEL stays for SSH-only shell work.

**Non-Goals**
- No rewrite of the LangGraph ReAct loop, the tool registry, or Socket.IO event names that the UI already consumes.
- No persistence layer for sessions across reload. Memory stays in-process.
- No supervisor + ephemeral sub-agents architecture. We chose planner + executor (option B from brainstorming).
- No Kubernetes cluster management UI in this iteration. The `kubectl` tool is exposed to the agent only.

## 2. Architecture Overview

```
User prompt
   │
   ▼
┌──────────────┐    plan JSON     ┌──────────────┐
│   Planner    │ ───────────────▶ │   Executor   │
│ (LLM call)   │                  │ (ReAct loop  │
└──────────────┘                  │  per step)   │
                                  └──────┬───────┘
                                         │ tool calls
                                         ▼
                                ┌────────────────┐
                                │ Tool Registry  │
                                │ (existing+new) │
                                └────────────────┘
```

**Flow per user message:**
1. `execute_natural_command` handler receives prompt.
2. **Triage**: If the message is trivially single-step (heuristic: under 8 words AND no conjunctions like "and"/"then"/","), skip planning. Run a single ReAct call against the existing tool registry. Done.
3. **Planning**: Call `planner.plan(user_msg, session_context)`. Returns a list of `PlanStep` objects.
4. Emit `plan_generated` Socket.IO event.
5. **Execution**: For each step, call `executor.run_step(step, plan, prior_results)`. Emit `step_status` events on transitions.
6. On step failure: retry once. If still failing, call `planner.replan(plan, completed_steps, failure_context)` and resume from the new plan's next step. Cap total replans at 2 per session.
7. After last step, emit `command_output` (final answer composed from step summaries) and `done`.

## 3. Planner (`planner.py`)

New module. Wraps the existing `ModelRouter`.

**Public API**
```python
class PlanStep(BaseModel):
    step_id: int
    description: str           # 1 sentence, human-readable
    intended_tool: str         # tool name from registry, or "reasoning" if no tool
    success_criteria: str      # 1 sentence describing how to know it worked

class Plan(BaseModel):
    steps: list[PlanStep]
    reasoning: str             # 1-3 sentences on why this plan

class Planner:
    def __init__(self, router: ModelRouter): ...
    def plan(self, user_message: str, session_context: str = "") -> Plan: ...
    def replan(self, original: Plan, completed_step_ids: list[int],
               failure_context: str) -> Plan: ...
```

**Planning prompt (system prompt for planner LLM call)**
- Lists every tool name + 1-line description from the existing tool registry.
- Instructs the model to output **only** valid JSON matching the `Plan` schema (no markdown fences, no commentary).
- Caps plan length at 10 steps; planner is instructed to keep plans atomic.
- Instructs that destructive steps (anything with `rm -rf`, `drop`, `format`) must include the word "destructive" in the description.

**Parsing**
- Strip code fences if model emits them anyway.
- Validate against Pydantic `Plan` model.
- If parse fails, retry the planner call once with the parse error appended to the prompt. If still failing, fall back to single-ReAct mode and log a warning.

**Triage heuristic** (lives in `main.py`, not planner)
```python
def needs_planning(msg: str) -> bool:
    if len(msg.split()) > 8:
        return True
    if any(t in msg.lower() for t in [" and ", " then ", ",", ";"]):
        return True
    return False
```

## 4. Executor (`executor.py`)

New module. Iterates plan steps using the existing tool registry.

**Public API**
```python
class StepResult(BaseModel):
    step_id: int
    status: Literal["done", "failed"]
    summary: str               # short human-readable result
    tool_outputs: list[dict]   # raw tool I/O for context-passing

class Executor:
    def __init__(self, llm, tools, memory, sio, sid): ...
    async def run_plan(self, plan: Plan, session_id: str) -> list[StepResult]:
        """Returns per-step results. Emits Socket.IO events as it goes."""
```

**Per-step ReAct execution**
- For each step, the executor builds a focused user message string (the *step prompt*) and invokes `create_react_agent(llm, tools, state_modifier=SYNAPSE_SYSTEM_PROMPT)` (existing system prompt — unchanged). The plan context is passed as part of the user message, not the system prompt, so the existing system prompt stays the single source of agent rules.
- Step prompt template:
  ```
  We are executing a plan. Plan so far:
  {numbered plan with status of each step}

  Previous step results (summaries):
  {step_id: summary lines}

  CURRENT STEP {step_id}: {description}
  Success criteria: {success_criteria}
  Intended tool: {intended_tool}

  Execute this step now. Use the intended tool unless you have a strong reason not to. After tool calls finish, end your response with a single line "SUMMARY: <one sentence>".
  ```
- The executor reads the agent's final message; if it contains `SUMMARY:`, that line becomes the step's `summary` field; otherwise the first 200 chars of the final message are used.

**Retry-then-replan policy**
- Step fails (tool returned `success: false` OR exception raised).
- Emit `step_status` with `status: "retry"`.
- Retry the same step with same inputs **once**.
- If still failing, emit `step_status` with `status: "failed"` then call `planner.replan(...)`.
- Emit a new `plan_generated` with `replanned: true`.
- Resume execution from the new plan's first uncompleted step.
- Cap replans at 2 per session (counter on Executor instance). On exceed, halt and emit `command_output` with the failure context.

**Streaming**
- Per-step token streaming to UI uses the existing `token` event so `ChatDisplay` keeps working.
- New events (`plan_generated`, `step_status`) are additive.

## 5. Local Docker — `docker_agent.py` rewrite

**Drop** the SSH-routed `DockerTool` and `DOCKER_INSTALL_STEPS`.

**Replace** with `LocalDockerAgent`:

```python
class LocalDockerAgent:
    def __init__(self, timeout: int = 120):
        self.timeout = timeout

    def run_command(self, command: str) -> str:
        """Run `docker <command>` on the local host via subprocess.
        Returns JSON-serialized DockerOutput (matching existing tool_schemas)."""
        # Use subprocess.run with shell=False; split command via shlex.
        # On Windows, docker.exe is on PATH when Docker Desktop is installed.
        # On non-zero exit: success=false, error=stderr, summary="docker {command} failed".
        # On success: success=true, stdout, summary="docker {command} ok".
        # Honor self.timeout. On timeout: success=false, summary="docker timed out".

    def _detect_docker(self) -> Optional[str]:
        """Run `docker --version`. Return None if ok, else error string.
        Called once at startup; result cached. No install attempt — we surface
        a clear error telling the user to install Docker Desktop."""
```

**`main.py`**
- Replace `from docker_agent import DockerTool as DockerAgent` with `from docker_agent import LocalDockerAgent as DockerAgent`.
- Tool description updated to: *"Run a Docker CLI command on the local host. Docker Desktop must be installed and running."*
- At startup, log a warning (not a fatal error) if `docker --version` fails.

**Backwards compatibility**: `DOCKER_MODE` env var is **not** added. The SSH-Docker path is removed per the brainstorming decision.

## 6. New Tool — `kubectl_agent.py`

Mirrors `LocalDockerAgent`.

```python
class LocalKubectlAgent:
    def __init__(self, timeout: int = 60): ...
    def run_command(self, command: str) -> str:
        """Run `kubectl <command>` locally. Returns JSON KubectlOutput."""
```

**Schemas** (in `tool_schemas.py`):
```python
class KubectlCommandInput(BaseModel):
    command: str = Field(description="kubectl arguments, e.g. 'get pods', 'apply -f deploy.yml'")

class KubectlOutput(ToolOutput):
    tool_name: str = "kubectl"
    stdout: str
    stderr: Optional[str] = None
    exit_code: int
```

**Tool registry**: add `RunKubectlCommand` tool to the list in `main.py`.

## 7. Frontend — Two-Pane Mission Control

**New components**
- `PlanPanel.tsx` — Left pane (~320px wide on desktop, hidden under 800px viewport — collapses into a top accordion). Renders ordered step list, each step:
  - Step number + description.
  - Tool badge (lowercase tool name in a pill).
  - Status icon: pending (gray circle), running (cyan spinner), done (green check), failed (red ×), retry (amber arrow), replanned (purple star).
  - Click to expand → shows step summary text after completion.
- `StepStatusIcon.tsx` — small dumb component for the status icon (used inside PlanPanel).

**Repurposed components**
- `ChatDisplay.tsx` — keeps role, moves into the right pane. ScrambledText stays only for SYNAPSE final messages, not for plan content.
- `InputBar.tsx` — unchanged, anchored bottom-right pane.
- `ModelIndicator.tsx` — unchanged, stays in header.
- `ParticleBackground.tsx` — particle count cut roughly in half for readability; opacity reduced.
- `EntryScreen.tsx` — unchanged.

**App.tsx layout**
```
┌──────────────────────────────────────────────────────────┐
│ S Y N A P S E   ● online    [model indicator]            │  header
├──────────────┬───────────────────────────────────────────┤
│ PLAN         │ ChatDisplay                                │
│ 1 ● step …   │ (existing message bubbles)                │
│ 2 ○ step …   │                                            │
│ 3 ○ step …   │                                            │
│              │ ─────────────────────────────────────────  │
│              │ InputBar                                   │
└──────────────┴───────────────────────────────────────────┘
```

Below 800px viewport width: plan panel becomes a collapsible accordion at the top of the chat pane.

**State**
- `App.tsx` adds `const [plan, setPlan] = useState<Plan | null>(null);` and `const [stepStatuses, setStepStatuses] = useState<Record<number, StepStatus>>({});`.
- On `plan_generated` event: replace `plan`, reset `stepStatuses`.
- On `step_status` event: merge into `stepStatuses[step_id]`.

**Styling**
- Keep the existing cyan/cyberpunk palette (`text-cyan-400`, Orbitron font).
- Pane border: `border-cyan-500/20`.
- Tool badge: `bg-cyan-900/40 text-cyan-200 text-xs px-2 py-0.5 rounded`.
- Tone down the cyberpunk feel only on the plan panel — keep it readable and high-contrast.

## 8. New Socket.IO Events

```
plan_generated   { plan: { steps: [...], reasoning: str }, replanned?: bool, session_id }
step_status      { step_id, status: "pending"|"running"|"done"|"failed"|"retry"|"replanned", message?: str }
```

Existing events unchanged: `token`, `tool_call`, `command_output`, `provider_update`, `connect`, `disconnect`.

## 9. main.py Wiring

```python
# Replace the existing handle_command body with:
@sio.on("execute_natural_command")
async def handle_command(sid, data):
    query = data.get("command", "").strip()
    if not query: return
    session_id = sid

    agent_memory.add(session_id, role="user", content=query)
    session_context = agent_memory.get_context(session_id)

    try:
        if not needs_planning(query):
            await _run_single_react(sid, session_id, query, session_context)
            return

        plan = planner.plan(query, session_context)
        await sio.emit("plan_generated", {"plan": plan.model_dump()}, to=sid)
        executor = Executor(llm=llm, tools=tools, memory=agent_memory, sio=sio, sid=sid)
        results = await executor.run_plan(plan, session_id)
        final = _compose_final_answer(plan, results)
        await sio.emit("command_output", {"data": final}, to=sid)
    except Exception as e:
        await sio.emit("command_output", {"data": f"Error: {e}"}, to=sid)
```

`_compose_final_answer(plan, results)` returns a markdown summary in this fixed shape:

```
**Plan executed** ({n_done}/{n_total} steps completed)

1. {description} — {summary}
2. {description} — {summary}
...

{wrap-up: if all done, a 1-2 sentence wrap-up referencing the last step result; if any failed, list the failed steps and their error summaries}
```
```

`_run_single_react` is the current ReAct-streaming code extracted into a helper so simple prompts skip planning.

## 10. Build Order

1. Add `Plan`, `PlanStep`, `StepResult`, `KubectlCommandInput`, `KubectlOutput` to `tool_schemas.py`.
2. Write `planner.py` with `plan()` and `replan()`.
3. Write `executor.py` with `run_plan()` and the retry-replan loop.
4. Rewrite `docker_agent.py` to `LocalDockerAgent`. Remove install steps.
5. Write `kubectl_agent.py`.
6. Update `main.py`:
   - Swap Docker import to local agent.
   - Register `RunKubectlCommand` tool.
   - Add triage + planner + executor wiring.
   - Extract single-ReAct path into `_run_single_react` helper.
7. Frontend: add `PlanPanel.tsx`, `StepStatusIcon.tsx`. Update `App.tsx` to two-pane layout and wire new socket events.
8. Tone down `ParticleBackground.tsx`.
9. Manual smoke test:
   - Simple prompt ("what's the kernel version?") → single-ReAct path, no plan panel updates.
   - Compound prompt ("list containers and tell me how many are running") → plan + steps.
   - Failure path: prompt that will fail first attempt (e.g. an intentionally bad image name) → retry → replan.

## 11. Tests

- `tests/test_planner.py` — Plan JSON parsing, schema validation, fallback on bad JSON. Mock the LLM.
- `tests/test_executor.py` — Step succeeds; step fails-then-retries-succeeds; step fails-then-retries-then-replans. Mock the LLM and tools.
- `tests/test_local_docker.py` — `LocalDockerAgent.run_command` against a mocked `subprocess.run`; success, non-zero exit, timeout.
- `tests/test_kubectl.py` — same shape as `test_local_docker.py`.
- `tests/test_triage.py` — `needs_planning` heuristic over a small example table.

No frontend unit tests in this iteration — UI changes verified via manual smoke test in step 9.

## 12. Risks & Mitigations

- **Planner LLM returns invalid JSON.** Mitigation: retry once with error in prompt, then fall back to single-ReAct.
- **Local Docker not installed.** Mitigation: clear startup warning; tool surfaces actionable error when called.
- **Replan loops indefinitely.** Mitigation: hard cap of 2 replans per session.
- **Plan length blows past 10 steps.** Mitigation: planner prompt explicitly caps at 10; parser rejects longer plans and retries with the constraint reinforced.
- **Frontend small-viewport break.** Mitigation: plan panel collapses into accordion below 800px.
