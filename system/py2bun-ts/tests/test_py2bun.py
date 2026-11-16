import pytest

import py2bun
from py2bun.cli import main


def test_transpile_basic():
    ts = py2bun.transpile("x = [i * 2 for i in range(3)]\nprint(len(x))\n")
    assert 'import * as __py from "@aphrody/py2bun/runtime"' in ts
    assert "__py.print(__py.len(x))" in ts


def test_ghidra_imports_and_flat_api():
    src = "from ghidra.program.model.listing import Function\nprintln(currentProgram.getName())\n"
    ts = py2bun.transpile(src)
    assert 'import { Function } from "@aphrody/ghidra/java/ghidra/program/model/listing";' in ts
    assert 'import { currentProgram, println } from "@aphrody/ghidra/script";' in ts


def test_syntax_error_raises():
    with pytest.raises(ValueError):
        py2bun.transpile("def (:\n")


def test_unsupported_reported():
    ts, diags = py2bun.transpile_with_diagnostics("match 1:\n    case 1:\n        pass\n")
    assert any(s == "error" and "match" in m for _, _, s, m in diags)
    assert '__py.unsupported("match statement")' in ts


def test_cli(tmp_path):
    src = tmp_path / "a.py"
    out = tmp_path / "a.ts"
    src.write_text("print('hi')\n")
    assert main([str(src), "-o", str(out)]) == 0
    assert "__py.print(" in out.read_text()
