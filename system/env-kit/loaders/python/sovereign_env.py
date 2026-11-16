"""Zero-dependency Python 3.12+ loader and secret redaction guard for C:/aphrody/.env.

Compatible with `uv run --env-file C:/aphrody/.env` as well as direct library import.
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path

# Monorepo root = four levels above this file (system/env-kit/loaders/python), ENV_KIT_ROOT overrides.
DEFAULT_MONOREPO_ENV_PATH = Path(os.environ.get("ENV_KIT_ROOT") or Path(__file__).resolve().parents[4]) / ".env"

_SECRET_KEY_RE = re.compile(
    r"(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL|DATABASE_URL|NUGET_API_KEY)",
    re.IGNORECASE,
)
_SECRET_PREFIX_RE = re.compile(
    r"^(sk-|AIza|figd_|gh[pousr]_|github_pat_|npm_|pypi-|ctx7sk-|vcp_|napi_|eyJ[A-Za-z0-9_-]+\.)"
)
_VALID_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def is_secret_key(key: str, value: str = "") -> bool:
    upper = key.upper()
    has_prefix = bool(_SECRET_PREFIX_RE.match(value))
    if upper.endswith(("_DIR", "_PATH", "_HOME")) and not has_prefix:
        return False
    if upper.endswith("_URL") and "DATABASE_URL" not in upper and not has_prefix:
        return False
    return has_prefix or bool(_SECRET_KEY_RE.search(key))


def mask_value(key: str, value: str | None) -> str:
    if not value:
        return "UNSET"
    if is_secret_key(key, value):
        return f"SET [len={len(value)}]"
    return value


def resolve_monorepo_env_path(start_dir: str | Path | None = None) -> Path:
    current = Path(start_dir or Path.cwd()).resolve()
    while True:
        candidate = current / ".env"
        if candidate.is_file():
            return candidate
        parent = current.parent
        if parent == current:
            break
        current = parent
    return DEFAULT_MONOREPO_ENV_PATH


def parse_dotenv(content: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for raw_line in content.splitlines():
        trimmed = raw_line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        if trimmed.startswith("export "):
            trimmed = trimmed[7:].strip()
        if "=" not in trimmed:
            continue
        raw_key, raw_val = trimmed.split("=", 1)
        key = raw_key.strip()
        if not _VALID_IDENT_RE.match(key):
            continue
        val_str = raw_val.strip()
        if val_str.startswith('"'):
            chars: list[str] = []
            escaped = False
            for ch in val_str[1:]:
                if escaped:
                    chars.append({"n": "\n", "r": "\r", "t": "\t"}.get(ch, ch))
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    break
                else:
                    chars.append(ch)
            value = "".join(chars)
        elif val_str.startswith("'"):
            end_idx = val_str.find("'", 1)
            value = val_str[1:end_idx] if end_idx >= 1 else val_str[1:]
        else:
            comment_match = re.search(r"\s+#", val_str)
            if comment_match:
                val_str = val_str[: comment_match.start()]
            value = val_str.strip()
        parsed[key] = value
    return parsed


class SovereignEnv(Mapping[str, str]):
    """Read-only environment view whose repr/str/JSON representations redact secrets."""

    def __init__(self, env_path: Path, data: Mapping[str, str]) -> None:
        self.env_path = env_path
        self._data = dict(data)

    def __getitem__(self, key: str) -> str:
        return self._data[key]

    def __iter__(self):
        return iter(self._data)

    def __len__(self) -> int:
        return len(self._data)

    def redacted(self) -> dict[str, str]:
        return {k: mask_value(k, v) for k, v in sorted(self._data.items())}

    def __repr__(self) -> str:
        return f"SovereignEnv(path={str(self.env_path)!r}, values={self.redacted()!r})"

    def __str__(self) -> str:
        return json.dumps(self.redacted(), indent=2)


def load_monorepo_env(
    *,
    env_path: str | Path | None = None,
    start_dir: str | Path | None = None,
    service: str = "default",
    required: Iterable[str] = (),
    override: bool = False,
    inject_process_env: bool = True,
) -> SovereignEnv:
    target_path = Path(env_path).resolve() if env_path else resolve_monorepo_env_path(start_dir)
    parsed = parse_dotenv(target_path.read_text(encoding="utf-8")) if target_path.is_file() else {}

    effective: dict[str, str] = {}
    for key, file_val in parsed.items():
        proc_val = os.environ.get(key)
        if not override and proc_val:
            effective[key] = proc_val
        else:
            effective[key] = file_val
            if inject_process_env and (file_val or override):
                os.environ[key] = file_val

    missing = [req for req in required if not (os.environ.get(req) or effective.get(req))]
    if missing:
        raise RuntimeError(
            f"[service={service}] Missing required environment variables ({', '.join(missing)}) "
            f"after checking os.environ and {target_path}"
        )

    return SovereignEnv(target_path, effective)


if __name__ == "__main__":
    loaded = load_monorepo_env(inject_process_env=False)
    sys.stdout.write(json.dumps(loaded.redacted(), indent=2) + "\n")
