import json
import sqlite3

from hermes_agent_memory import AgentMemoryProvider


def test_roundtrip_shared_schema(tmp_path):
    db = tmp_path / "memory.sqlite"
    p = AgentMemoryProvider(str(db))
    p.initialize("s1")
    mid = p.add("the user deploys with rsync to prd")
    p.add("the user prefers French answers")
    hits = p.search("how does the user deploy")
    assert hits[0]["id"] == mid
    out = json.loads(p.handle_tool_call("agent_memory_search", {"query": "French"}))
    assert "French" in out[0]["text"]
    # same schema as frameworks/ai-os/src/core/context.ts
    cols = {r[1] for r in sqlite3.connect(db).execute("PRAGMA table_info(entries)")}
    assert {"id", "source", "scope", "title", "text", "symbols", "at"} <= cols
    assert p.name() == "agent" and len(p.get_tool_schemas()) == 2
