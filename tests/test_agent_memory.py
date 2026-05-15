from agent_memory import AgentMemory

def test_memory_stores_entries():
    mem = AgentMemory(max_per_session=5)
    mem.add("s1", role="user", content="deploy my app")
    mem.add("s1", role="agent", content="I will deploy it")
    context = mem.get_context("s1")
    assert "deploy my app" in context
    assert "I will deploy it" in context

def test_memory_respects_max_per_session():
    mem = AgentMemory(max_per_session=3)
    for i in range(10):
        mem.add("s1", role="user", content=f"message {i}")
    context = mem.get_context("s1")
    assert "message 9" in context
    assert "message 0" not in context

def test_memory_isolates_sessions():
    mem = AgentMemory()
    mem.add("session_a", role="user", content="hello from A")
    mem.add("session_b", role="user", content="hello from B")
    ctx_a = mem.get_context("session_a")
    ctx_b = mem.get_context("session_b")
    assert "hello from A" in ctx_a
    assert "hello from B" not in ctx_a

def test_empty_session_returns_empty_string():
    mem = AgentMemory()
    assert mem.get_context("nonexistent") == ""

def test_get_last_tool_result():
    mem = AgentMemory()
    mem.add("s1", role="tool", content="container_id=abc123",
            tool_name="docker", tool_result_summary="container_id=abc123")
    result = mem.get_last_tool_result("s1", "docker")
    assert result == "container_id=abc123"
