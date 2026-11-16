"""Hermes Agent memory provider "agent": Hermes reads/writes the same Context store as the TS core.

Store: ``$AGENT_HOME/memory.sqlite`` (default ``~/.agent``), schema of frameworks/ai-os/src/core/context.ts, accessed natively
through the pyo3 module ``agent_core`` (frameworks/agent/context, feature `python`). Recall uses the native lexical + recency heads (RRF); the
semantic head runs on the TS side over the same entries.

The class implements the Hermes ``MemoryProvider`` contract (agent/memory_provider.py). It does not import Hermes at
module import time, so it also works standalone (tests, other Python hosts).
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

import agent_core

try:  # Hermes host
    from agent.memory_provider import MemoryProvider as _Base
except Exception:  # standalone
    _Base = object  # type: ignore[assignment,misc]


def default_store() -> str:
    home = Path(os.environ.get("AGENT_HOME") or Path.home() / ".agent")
    home.mkdir(parents=True, exist_ok=True)
    return str(home / "memory.sqlite")


class AgentMemoryProvider(_Base):  # type: ignore[misc,valid-type]
    def __init__(self, path: str | None = None) -> None:
        self._path = path
        self._ctx: agent_core.Context | None = None
        self._session = ""

    # --- required -----------------------------------------------------------------------------------------------
    def name(self) -> str:
        return "agent"

    def is_available(self) -> bool:
        return True

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session = session_id
        self._ctx = agent_core.Context(self._path or default_store())

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "agent_memory_search",
                "description": "Search the unified agent memory (shared with the agent CLI, TUI and gateway).",
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            },
            {
                "name": "agent_memory_add",
                "description": "Persist a durable fact to the unified agent memory.",
                "parameters": {"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"]},
            },
        ]

    # --- behaviour ----------------------------------------------------------------------------------------------
    @property
    def ctx(self) -> agent_core.Context:
        if self._ctx is None:
            self.initialize(self._session or "standalone")
        assert self._ctx is not None
        return self._ctx

    def add(self, content: str, scope: str = "user") -> str:
        mid = f"memory:hermes-{uuid.uuid4().hex[:12]}"
        self.ctx.ingest(mid, content, source="memory", scope=scope)
        return mid

    def search(self, query: str, k: int = 8) -> list[dict[str, Any]]:
        return self.ctx.select(query, k=k, sources=["memory", "skill", "research", "doc"])

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        hits = self.search(query, k=6)
        return "\n".join(f"- {h['text']}" for h in hits)

    def system_prompt_block(self) -> str:
        return "Unified agent memory is available through agent_memory_search / agent_memory_add."

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        if tool_name == "agent_memory_add":
            return json.dumps({"id": self.add(str(args.get("content", "")))})
        if tool_name == "agent_memory_search":
            return json.dumps([{"id": h["id"], "text": h["text"], "score": h["score"]} for h in self.search(str(args.get("query", "")))])
        return json.dumps({"error": f"unknown tool {tool_name}"})

    def on_memory_write(self, action: str, target: str, content: str, metadata: dict[str, Any] | None = None) -> None:
        # Mirror Hermes built-in memory writes into the unified store.
        if action in ("add", "replace") and content:
            self.ctx.ingest(f"memory:hermes-{target}-{abs(hash(content)) % 10**12}", content, source="memory", scope="user")

    def sync_turn(self, *args: Any, **kwargs: Any) -> None:
        return None

    def shutdown(self) -> None:
        self._ctx = None


def register(ctx: Any) -> None:
    ctx.register_memory_provider(AgentMemoryProvider())
