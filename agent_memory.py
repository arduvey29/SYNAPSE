import time
from collections import defaultdict, deque
from typing import Optional
from pydantic import BaseModel


class MemoryEntry(BaseModel):
    timestamp: float
    role: str
    content: str
    tool_name: Optional[str] = None
    tool_result_summary: Optional[str] = None


class AgentMemory:
    """Session-scoped short-term memory. Stores the last N entries per session ID."""

    def __init__(self, max_per_session: int = 10):
        self._sessions: dict[str, deque] = defaultdict(
            lambda: deque(maxlen=max_per_session)
        )

    def add(self, session_id: str, role: str, content: str,
            tool_name: str = None, tool_result_summary: str = None):
        self._sessions[session_id].append(MemoryEntry(
            timestamp=time.time(),
            role=role,
            content=content,
            tool_name=tool_name,
            tool_result_summary=tool_result_summary,
        ))

    def get_context(self, session_id: str) -> str:
        entries = list(self._sessions.get(session_id, []))
        if not entries:
            return ""
        lines = ["RECENT SESSION HISTORY:"]
        for entry in entries[-5:]:
            prefix = f"[{entry.role.upper()}]"
            if entry.tool_name:
                lines.append(f"{prefix} Tool '{entry.tool_name}': {entry.tool_result_summary or entry.content[:100]}")
            else:
                lines.append(f"{prefix} {entry.content[:200]}")
        return "\n".join(lines)

    def get_last_tool_result(self, session_id: str, tool_name: str) -> Optional[str]:
        for entry in reversed(list(self._sessions.get(session_id, []))):
            if entry.tool_name == tool_name and entry.role == "tool":
                return entry.tool_result_summary
        return None

    def clear(self, session_id: str):
        self._sessions.pop(session_id, None)


agent_memory = AgentMemory()
