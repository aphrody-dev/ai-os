"""py2bun: Python 3 -> Bun TypeScript transpiler (native module built with maturin)."""

from ._py2bun import transpile, transpile_with_diagnostics

__all__ = ["transpile", "transpile_with_diagnostics"]
