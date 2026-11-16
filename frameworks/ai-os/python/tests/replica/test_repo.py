import json
import os
import re
import unittest

from _load import ROOT

SKILLS = ["replica-recon", "replica-architect", "replica-design", "replica-build",
          "replica-backend", "replica-test", "replica-diff", "replica-entrepreneur",
          "replica-brand", "replica-launch", "replica-deploy"]
ABOUT = ("Eleven free Claude skills that clone any app: reverse-engineer it, rebuild it, "
         "test it for bugs, then fix what its users hate. Free, MIT.")


def frontmatter(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    return (m.group(1) if m else ""), text


class Repo(unittest.TestCase):
    def test_eleven_skill_folders_at_the_root(self):
        found = sorted(
            s for s in SKILLS if os.path.isfile(os.path.join(ROOT, s, "SKILL.md"))
        )
        self.assertEqual(found, sorted(SKILLS))

    def test_frontmatter_name_and_description(self):
        for s in SKILLS:
            fm, text = frontmatter(os.path.join(ROOT, s, "SKILL.md"))
            self.assertIn("name: %s\n" % s, fm + "\n", s)
            self.assertRegex(fm, r"description: ", s)
            self.assertGreater(len(fm), 200, "%s description is too thin" % s)
            self.assertGreater(len(text.splitlines()), 60, s)

    def test_no_em_dashes_anywhere(self):
        bad = []
        roots = [os.path.dirname(os.path.abspath(__file__))] + [
            os.path.join(ROOT, s) for s in SKILLS
        ]
        for base in roots:
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [d for d in dirnames if d not in (".git", "__pycache__")]
                for fn in filenames:
                    if fn.endswith((".md", ".py", ".json", ".ts", ".csv")):
                        path = os.path.join(dirpath, fn)
                        with open(path, encoding="utf-8") as fh:
                            if chr(0x2014) in fh.read():
                                bad.append(os.path.relpath(path, ROOT))
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()
