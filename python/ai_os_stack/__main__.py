from __future__ import annotations

import json

from ai_os_stack import scan_python_cuda_polyglot

if __name__ == "__main__":
    print(json.dumps(scan_python_cuda_polyglot(), indent=2))
