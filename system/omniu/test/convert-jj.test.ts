import { expect, test } from "bun:test";
import { convertJjCompletions } from "../src/convert-jj.ts";

const BASH = `
    case "\${prev}" in
        --color)
            COMPREPLY=($(compgen -W "always never auto" -- "\${cur}"))
            return 0
            ;;
    esac
        jj,log)
            cmd="jj__subcmd__log"
            ;;
        jj,new)
            cmd="jj__subcmd__new"
            ;;
    esac
    case "\${cmd}" in
        jj)
        opts="-h --help --color --no-pager"
            ;;
        jj__subcmd__log)
        opts="-r --revisions -h --help"
            ;;
`;

test("flags, subcommands and value lists are extracted", () => {
  const toml = convertJjCompletions(BASH);
  expect(toml).toContain('command = "jj"');
  expect(toml).toContain('[[flags]]\nlong = "--color"\nvalues = ["always", "never", "auto"]');
  expect(toml).toContain('[[flags]]\nshort = "-h"');
  expect(toml).toContain('[[subcommands]]\nname = "log"');
  expect(toml).toContain('[[subcommands.flags]]\nlong = "--revisions"');
  // `new` has no opts branch: skipped, as in the Python converter.
  expect(toml).not.toContain('name = "new"');
});

test("backslashes in flag names and values cannot break the TOML", () => {
  const src = [
    "    case \"${prev}\" in",
    "        --mode)",
    "            COMPREPLY=($(compgen -W \"a\\\\b c\" -- \"${cur}\"))",
    "            ;;",
    "    esac",
    "        jj,x)",
    "            cmd=\"jj__subcmd__x\"",
    "            ;;",
    "    esac",
    "    case \"${cmd}\" in",
    "        jj)",
    "        opts=\"--mode --we\\\\ird\"",
    "            ;;",
    "        jj__subcmd__x)",
    "        opts=\"-q\"",
    "            ;;",
    "",
  ].join("\n");
  const doc = Bun.TOML.parse(convertJjCompletions(src)) as any;
  expect(doc.command).toBe("jj");
  const mode = doc.flags.find((f: any) => f.long === "--mode");
  expect(mode.values).toEqual(["a\\\\b", "c"]);
  expect(doc.flags.map((f: any) => f.long)).toContain("--we\\\\ird");
  expect(doc.subcommands[0].name).toBe("x");
});
