"""Load a script from a skill folder (the folder names have hyphens)."""

import importlib.util
import os

_cur = os.path.dirname(os.path.abspath(__file__))
while _cur and not os.path.isdir(os.path.join(_cur, ".agents", "skills")):
    _parent = os.path.dirname(_cur)
    if _parent == _cur:
        break
    _cur = _parent
ROOT = os.path.join(_cur, ".agents", "skills")


def load(folder, name):
    path = os.path.join(ROOT, folder, name + ".py")
    spec = importlib.util.spec_from_file_location("replica_" + name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
