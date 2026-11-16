"""CLI: py2bun file.py -o file.ts"""

import argparse
import json
import sys

from ._py2bun import transpile_with_diagnostics


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="py2bun", description="Transpile a Python 3 file to Bun TypeScript")
    ap.add_argument("file", nargs="?", default="-", help="Python source ('-' = stdin)")
    ap.add_argument("-o", "--output", help="output .ts path (default: stdout)")
    ap.add_argument("--strict", action="store_true", help="exit 1 on any diagnostic, warnings included")
    ap.add_argument("--json", action="store_true", help="print diagnostics as JSON lines on stderr")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--async", dest="mode", action="store_const", const="async", help="force async output")
    mode.add_argument("--sync", dest="mode", action="store_const", const="sync", help="force sync output")
    ap.set_defaults(mode="auto")
    ns = ap.parse_args(argv)
    label = "<stdin>" if ns.file == "-" else ns.file
    try:
        if ns.file == "-":
            src = sys.stdin.read()
        else:
            with open(ns.file, encoding="utf-8") as f:
                src = f.read()
    except (OSError, UnicodeDecodeError) as e:
        print(f"py2bun: {label}: {e}", file=sys.stderr)
        return 2
    ts, diags = transpile_with_diagnostics(src, ns.mode)
    for line, col, sev, msg in diags:
        if ns.json:
            print(json.dumps({"line": line, "col": col, "severity": sev, "message": msg}), file=sys.stderr)
        else:
            print(f"{label}:{line}:{col}: {sev}: {msg}", file=sys.stderr)
    if ts:
        if ns.output:
            with open(ns.output, "w", encoding="utf-8", newline="\n") as f:
                f.write(ts)
        else:
            sys.stdout.write(ts)
    errors = any(s == "error" for _, _, s, _ in diags)
    return 1 if (not ts or errors or (ns.strict and diags)) else 0


if __name__ == "__main__":
    raise SystemExit(main())
