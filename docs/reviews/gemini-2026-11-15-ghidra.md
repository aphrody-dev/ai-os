# Gemini review: Ghidra deliverables (2026-11-15)

- Reviewer: Gemini through the relay tool `gemini_review` (`frameworks/ai-os/src/relay/tools.ts:121`), default engine Antigravity `agy` (`frameworks/ai-os/src/relay/backends.ts:174`, `RELAY_GEMINI` unset). The relay did not fail, so the gemini.google.com fallback was not used. The relay returns neither a chat URL nor the model name: "Carbon High" cannot be confirmed from the relay output.
- Scope: `docs/native/re/GHIDRA.md`, `packages/ghidra`, `system/py2bun-ts`, `system/ghidra-bun`, `system/py2bun`; commits d2a9d994, 55193ac0, d18f303f, 07972ae4, ed2e0142, 78c7c0ac, 20cd22c4, c41d98c5, f140055b, 24aa7d35.
- Method: the 120 000-character cap of `gemini_review` required 10 bundles (files with line numbers, one call each). Verification of each reported defect against the code: reviewer (sections 1, 2b and 5b, plus fork state read over ssh on fr1) and read-only headless Claude verifiers (Read/Grep/Glob) for sections 2a, 3a, 3b, 4a, 4b, 5a, 6a, 6b, each followed by reviewer spot checks (`rpc.ts:85`, `emit.rs:1461-1463`, `json.ts:20`, `re.ts:68`, `Bridge.java:327,345`, `py2.rs:71`, `cli.ts:8`).
- Scores (Gemini): docs 11, 2a Bridge.java 8, 2b native crate and scripts 8, 3a ghidra core 11, 3b ghidra rest 11, 4a emit.rs 1-860 11, 4b emit.rs 861-1942 9, 5 py2bun Rust rest 9 (second call; the first answered with a plan and no score), 6a runtime index.ts 6, 6b runtime rest 11. **Mean 9.5/20.**
- Verdict counts (rows, sub-claims counted separately): 309 confirmed, 81 partial, 17 refuted.
- Verification caveats: a Gemini defect is "partial" when the observation is real but the stated cause, severity or example is wrong. Verifier rows written in French come from the French Gemini plans. Gemini artefact plans (not archived here) were read from `~/.gemini/antigravity-cli/brain/`.

## Fixed (2026-11-15, regression test per fix; commits 5d180347, b2c2899b, fc4c79db, 3daa49a2, dabd4979, d44622cf, 4c404a62, 4e0fa08e, eb85763c, b1ee291a, 4ebda615, 21e813dd, 20d0493c)

Checks: `cargo test` py2bun on fr2 (31 transpile + 8 py2_fallback + 6 async), `bun test system/py2bun-ts/test` with the fresh binary on fr2 (41 pass), `bun test packages/ghidra` (23 pass, 0 fail), `tsc --strict` clean on `packages/ghidra` (fr2), `Bridge.java` protocol test on fr2 (JDK only), `cargo check` of `system/ghidra-bun` default features on fr1 (no error; `decompile` feature not built), corpus re-run on 146 Ghidra `.py` files: 144 valid TS, 36 without error diagnostic (unchanged vs before).

- Section 2a (Bridge.java): rows 1, 2.x, 3.x, 4.x, 5, 6, 7.x, 8, 9, 10, 11.x, 12.x, 13.2, 14.x fixed (InlineList, reqHandle, idJson, parser hardening, BigInteger/Float, ties by specificity, exit on EOF, `layout` op). 13.1 refuted (unchanged).
- Section 2b: rows 3 (name@addr keys, errors reported, `decompile_many` opens once), 4 (documented), 5 (catch_unwind, stub read errors logged), 6, 7, 9, 10, 11, 12 fixed. Rows 1, 2, 8 need the crate promoted to the root workspace (the root `Cargo.toml` members may not be edited by this task); row 13 (`gen-script-exports` types) stays: `Flat` is itself indexed by `any` functions.
- Section 3a: rows 1 to 10, 11.2 (partly), 12.1 to 12.3, 13, 14, 15, 16, 17 fixed (classpath, stderr tail, final fragment, protocol failure, plain objects, `$release` refcount, shared start, deferred launcher, openProgram cleanup, context stack, sourceFile). Row 12.4 (`getGhidraVersion`, `getState`, `goTo` need a GhidraScript backend on the bridge) and row 11.2 (cause of the `Hello.java` load failure) stay open.
- Section 3b: rows 1 to 16, 18, 19, 20, 22, 23, 24 fixed (plugin backend/cache/paths/`#`, analysis bounds, cli validation, tsconfig, mock identity and dispatch, parity script hardening). Rows 17.1 and 17.2 (try/finally around mock sessions) stay: the mock subprocess dies with the test process. 17.4 is partial (analysis helpers and plugin specifier tests exist; no test drives `ghidraPlugin` end to end).
- Section 4a/4b (emit.rs): fixed 1.1 (partial: error position), 2, 3.1, 3.2, 4, 5.1, 5.2, 6, 8.2 (partial), 9 (ES import rebinding), 10, 11.1, 11.2, 12.1 to 12.3, 13, 14.1, 16, 17, 18.x, 19, 20.x, 21.x; 4b rows 1, 3.1, 4, 5, 6.1, 7, 8.1, 8.2, 9, 10.x, 12, 13.1, 13.2, 14, 15, 16, 17, 18.1, 18.2, 19.1, 19.2, 20, 21.1, 22.x, 24.1, 25.x, 26. Open: 1.2 (column remap after the Python 2 rewrite), 3.3, 7.1 refuted (top-level await is valid ESM), 8.1 and 8.2 (def/class inside blocks are block-scoped; no hoisting yet), 14.2, 15.1 and 15.2 (class-name heuristics), 19.3, 21.2 runtime async dispose beyond `__aexit__`, 23.1, 23.2.
- Section 5a/5b: fixed 1.x, 2.x, 3.1 to 3.6 (3.5 stays), 4.x, 5.2, 6.1, 7.x, 8, 9, 10, 11, 12 (`index.ts` mode, exit code, CARGO_TARGET_DIR; async spawn stays), 13, 14, 15.2, 16.x, 5b rows 2, 3, 4, 5, 6, 7 (partial), 8, 9, 10, 11, 12, 14, 15. Open: 5.1 doc-only, 5b row 1 and 15.1 (promote to root workspace), 5b 13 (`@aphrody/ghidra/java` exports are still missing: every emitted Java import is unresolved at run time), 12 (a_iter/a_next/a_repr).
- Section 6a: fixed 1, 2, 3, 5.2, 6, 7, 8, 9, 10, 11, 12, 13, 14.x, 15, 16, 17, 20, 21, 22, 23, 24.x, 25.x, 26, 28, 29, 30.x, 31, 33, 34.1, 34.2, 34.3, 34.4, 35 to 41, 42, 43, 44. Refuted: 4, 27. Open: 5.1, 18 (repeated spreads), 19.1 and 19.2 (typed array slice assignment and extended slices), 32 (`Function.prototype.__name__`).
- Section 6b: fixed format 2.1 to 2.12 except 2.3 `z` handling, json 3.1 to 3.4, math 4.x, os 5.x, random 6.x, re 7.x (except 7.3 partial), struct 8.x (except `p`), sys 9.x, time 10.x, async 1.1 to 1.4, 1.7, tests 11.3.1 stays. Open: async 1.5, 1.6.x, format 2.7.2 detail, struct `p` Pascal strings (reported as an error), tests 11.1 (os/random/sys/time/math/re/struct/format/json now covered in `runtime.test.ts`; `string` module and the `async` iterators are not).
- Docs section 1: rows 2, 3, 4, 5, 6, 7, 8 (stated), 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 22, 23, 24 fixed. Row 1: no `src.lock.json` pin (the lock has no ghidra entry and `ay lock` was not run); rows 15, 25 refuted; 21 (`GHIDRA_FLAT` comment) open.

## Highest-impact confirmed defects (details and fixes in the tables)

1. `emit.rs:754,771,781,824,1695`: destructuring or `for` targets with a subscript, attribute or non-final `*x` place `__py.unsupported(...)` inside a JS left-hand side: the whole emitted file fails to parse. Fix: bind temporaries, then `store()` after.
2. `emit.rs:795-802,1570`: `+=`, `/=` with a literal right-hand side emit native JS operators (list `+=` string gives a string, BigInt mixing throws); `__py.iadd` is never emitted. Fix: drop the `simple_rhs` shortcut, route augmented add to `iadd`.
3. `emit.rs:1054,1476,1642`: scope pushed before default values and first comprehension iterable are emitted: `def f(x=x)`, `lambda x=x`, `[x for x in x]` hit the TDZ; defaults re-evaluated per call.
4. `emit.rs:1595`: chained comparisons evaluate every operand (no short-circuit). `emit.rs:1461-1463`: `not x` emits the operand twice (duplicate diagnostics and temporaries). `emit.rs:1407-1410`: float `inf` emitted as the undefined identifier `inf`. `emit.rs:1400`: integers of 16 digits become BigInt unnecessarily. `emit.rs:1584`: matrix multiplication emits no diagnostic.
5. `Bridge.java:345`: `isRawList` always true, every `java.util.ArrayList` returned by Java is inlined by value instead of a handle. `Bridge.java:47,56,60`: a string request id produces invalid JSON. `Bridge.java:327`: `Math.abs(Long.MIN_VALUE)` is negative so the value is emitted as a raw number.
6. `rpc.ts:183,199`: explicit `$release()` bypasses the reference count and the finalization registry. `api.ts:41-45,74`: two concurrent starts launch two JVMs; session assigned before `initGhidra` succeeds. `api.ts:296-335`: `openProgram` leaks the project and the bundle-host reference on error. `api.ts:371,337`: `runScript` loses `scriptArgs`/`scriptName` and leaves `currentLocation/Selection/Highlight/state` undefined.
7. `flat.ts:93,108,133-138`: `ask*` return raw strings, `askYesNo` never cancels, `sprintf` ignores the `0` flag and mangles bigint and negative `%x`.
8. `json.ts:20`: `dumps` rewrites `,` and `:` inside string literals. `re.ts:68`: `re.split(p, s, maxsplit)` signature wrong. `format.ts:165`: `%X` emits lowercase. `index.ts:1010-1020,1115-1118`, `index.ts:229-234` (`pow` modular), `index.ts:259` (`eq` bigint/number): Python-semantics divergences.
9. `py2.rs:71,67-69`: a bare `print` statement is not rewritten and `py2_fallback.rs:11` asserts 3 rewrites for 4 statements (the test encodes the bug). `py2.rs:154,169`: continuation rewrite puts `)` after a trailing comment. `py2.rs:112`: `except (A, B), e:` refused. `main.rs:46`: Rust `{:?}` produces invalid JSON (`\u{1b}`) and `index.ts:43` swallows the parse error.
10. Docs: `GHIDRA.md:7` states no Chromium clang exists on fr1 (clang 24.0.0git is there, dated 2026-11-12); `provision-fr2.sh:2,6` installs JDK 21 while `README.md:7` requires JDK 25; `GHIDRA.md:41` presents the Rust fast path as the `ghidra-decompiler` 2.1.0 engine although the default build and `src/ffi` do not enable `decompile`.
11. Defect found by the reviewer, not reported by Gemini: `system/py2bun-ts/src/cli.ts:8`: with no `-o`, `oi` is -1 so `i !== oi + 1` excludes index 0 and `py2bun script.py` prints the usage and exits 2. Fix: `i !== (oi >= 0 ? oi + 1 : -1)`.
12. Reviewer correction to a verifier row: section 4a row 20.2 says `__py.aiter` is missing from the runtime; it is defined at `system/py2bun-ts/src/runtime/async.ts:19` and re-exported by `runtime/index.ts:1123`. Only the missing `aiter` wrapper for `async for` (`emit.rs:827-828`) stands.

## 1. Docs: GHIDRA.md, PARITY.md, README.md (Gemini 11/20, 25 defects; verified by the reviewer)

| # | Gemini claim | Verdict | Evidence | Fix |
|---|---|---|---|---|
| 1 | `forks.txt` has an inconsistent duplicate of ghidra; no pin in `src.lock.json` | Partial | `third_party/forks.txt:83` (`NationalSecurityAgency/ghidra Java`) and `:145` (`aphrody-labs/ghidra Java`, added by d2a9d994) are two distinct repos, `:16-17` already hold `aphrody-labs/` entries. `src.lock.json` has no `ghidra` entry (rg). | No change to forks.txt; add the pin to `src.lock.json` if one is wanted. |
| 2 | "no Chromium clang tree found under /srv/chromium" is false; commit 1c3e0c59c0 not cited | Confirmed | ssh fr1: `/srv/chromium/src/third_party/llvm-build/Release+Asserts/bin/clang++ -> clang` (2026-11-12), `clang version 24.0.0git`. `GHIDRA.md:7` has no `1c3e0c59`; `git show 1c3e0c59c0` = "clang -O3 full LTO in buildNatives and make LLVM=1; add buildAotCache.sh". | Replace the sentence by the measured path and version; cite 1c3e0c59c0 in the LLVM and AOT sections. |
| 3 | `support/buildAotCache.sh` path wrong; JEP 515 not used | Partial | In the fork tree the file is `Ghidra/RuntimeScripts/support/buildAotCache.sh` (`git ls-files` on fr1); `support/` is the installed layout. Its header cites JEP 483 and 514 only; `GHIDRA.md:13` lists 515 as confirmed on openjdk.org, not as used. | Write the in-tree path; drop 515 or say it is JDK 25 background. |
| 4 | Row (a) mixes the default engine and `ghidra-decompiler` 2.1.0 | Confirmed | `src/ffi/src/re.rs:58` calls `analyze_binary_file` only; `src/ffi/Cargo.toml:28,33` does not enable `aphrody-re/decompile`; `system/ghidra-bun/Cargo.toml:17` `default = []`; the decompiler is behind `decompile = ["dep:ghidra-decompiler"]` (`frameworks/re/Cargo.toml:24`). | Split the row: default `analyze_binary_file` (shared with the relay tools) versus the optional `--features decompile`. |
| 5 | Op list omits `ping`; "beyond 2^53" is imprecise | Confirmed (minor) | `Bridge.java:10,69` has `ping`; `GHIDRA.md:49` omits it; `Bridge.java:327` tests `abs(l) < 2^53`, so `abs(v) >= 2^53` is encoded as `$long`. | Add `ping`; write "longs with abs(v) >= 2^53". |
| 6 | PARITY.md claims parity for launchers that are stubs | Confirmed | `api.ts:59` `DeferredPyGhidraLauncher extends HeadlessPyGhidraLauncher {}`; `api.ts:61-65` `GuiPyGhidraLauncher` always throws; `parity.ts:225-227` checks `typeof` and `.name` only; `PARITY.md:60` "identical"; "Scope and limits" (`PARITY.md:132-136`) silent. | Add a limits bullet; mark `api.launchers` as name-only in `run.ts`. |
| 7 | "Context managers become callbacks/await using, all calls are async" is inaccurate | Partial | README:28 states the callback forms correctly. `PARITY.md:44` "all calls are async" is too broad: `parity.ts:216,223,224` call `ApplicationInfo.fromFile`, `debugCallback`, `getCurrentInterpreter` synchronously. | Reword to "calls crossing the JVM bridge are async". |
| 8 | Parity harness maps JS errors to Python names by hand | Confirmed | `parity.ts:209` catch returns `"ValueError"`; `:233` returns `"TypeError"` by regex; `:239` by regex; `PARITY.md:4` claims nothing beyond the diff and does not mention the mapping. | State the mapping in the generated "Scope and limits" (`run.ts`). |
| 9 | README title `bun ghidra`, binary is `bun-ghidra` | Confirmed | `README.md:1`; `packages/ghidra/package.json:19`; root `package.json` has no `ghidra` entry (rg). | Use `bun-ghidra` or register `ghidra`. |
| 10 | README requires JDK 25, provisioning script installs JDK 21 | Confirmed | `README.md:7`; `provision-fr2.sh:2,6` `openjdk-21-jdk-headless`; `GHIDRA.md:50` `application.java.min=25`. (Line 6 runs only when `java` is absent.) | Install JDK 25 in the script. |
| 11 | README snippet uses undefined `addr` | Confirmed | `README.md:19`. | Add `const addr = await h.flat.toAddr(0x401000);`. |
| 12 | "Exports of" list incomplete | Confirmed (minor) | `README.md:22` versus `index.ts:1-5` re-exports (`createFlat`, `sprintf`, `getContext`, ...). | "Main exports". |
| 13 | `runScript` does not populate location, selection, highlight, state | Confirmed | `api.ts:371` sets `session, project, currentProgram, currentAddress, monitor, flat, scriptArgs, scriptName, javaFlat`; `script.ts:19-24` leaves four fields undefined; `sourceFile = c?.scriptName` (string). `README.md:40` claims all. | Fix the README sentence or populate the fields. |
| 14 | README native-crate paragraph | Partial | `README.md:61` "member line" is the line to add on promotion (`system/ghidra-bun/Cargo.toml:9-10`), not a claim; the `decompile` feature is mentioned in the same line; edition 2021 (`Cargo.toml:4`) versus root 2024 (`Cargo.toml:234`) and `.so`-only copy instruction are real. | Document `.dll`/`.so` -> `.node`; say why edition stays 2021. |
| 15 | py2bun standalone workspace pins ruff 0.0.22 while the root has 0.16.10 | Refuted as a defect | Isolation is documented (`py2bun/README.md:5`); crates differ (`system/py2bun/Cargo.toml:25` `ruff_python_parser =0.0.22`, root `Cargo.toml:617` `package = "rustpython-ruff_python_parser"`). | none |
| 16 | PyO3 signatures omit `mode` | Confirmed | `pymod.rs:18,30` `(source, mode="auto")`; `README.md:6`. | Add `mode="auto"`. |
| 17 | CLI flags differ between the three CLIs | Partial | `README.md:26` comment sits on the `py2bun-rs` line; `main.rs:13-18` implements the flags; `cli.ts:5-8` and `cli.py:10-14` implement fewer; the README does not say so. | List flags per CLI. |
| 18 | Exit-status paragraph omits 2 and `--strict` | Confirmed | `README.md:34`; `main.rs:31,38,62,70`. | Document 0/1/2 and `--strict`. |
| 19 | README:38 says `@aphrody/ghidra/pyghidra`, README:42 says `@aphrody/ghidra` | Confirmed | `emit.rs:461,538` emit `"@aphrody/ghidra"`; `packages/ghidra/package.json:7-14` has no `./pyghidra`. | Fix line 38. |
| 20 | `os.path` and `IGNORED_MODULES` undocumented | Confirmed (minor) | `emit.rs:463,470,503,545`; `names.rs:47`. | Document them. |
| 21 | `GHIDRA_FLAT` is "generated" but no script writes `names.rs`; dead `FLAT_AMBIGUOUS` names | Confirmed | `names.rs:49-53` comment; `gen-script-exports.ts:6` writes `script.generated.ts` only; `names.rs:104` lists `show execute cleanup toString`, none in `names.rs:55-100`; `analyze` is in both. | Say "mirrors", or generate `names.rs`; drop dead names. |
| 22 | README says `toString` cannot await, Python names are `__str__`/`__repr__` | Partial (wording) | `emit.rs:1130,1206`; a Python `def toString` is not sync-forced. | Write "`__str__`/`__repr__` (emitted as toString)". |
| 23 | README:46 says Java classes use `new`, README:40 says `X.new_` | Confirmed | `emit.rs:1872-1877` (`nk == 2` -> `.new_`, `nk == 1` -> `new`). | Delete or correct line 46. |
| 24 | Diagnostics classification wrong | Partial | Star imports: Warning for Java and stdlib (`emit.rs:499`), Error only when unmapped (`:501`). Matrix multiplication: `emit.rs:1584` emits `__py.unsupported` without a diagnostic, so `README.md:50` is wrong in practice and exit status is 0. Warnings at `emit.rs:810,1796` absent from `README.md:51`. | In `emit.rs`, pass the range to `binop_str` and call `self.unsupported`; complete the README lists. |
| 25 | "146 files" not qualified | Refuted | `git ls-files '*.py'` on fr1 = 146; `aa800ba9` exists (2026-11-14 23:11, below HEAD 1c3e0c59); the corpus is pinned to that commit. | none |

## 2a. packages/ghidra/bridge (Bridge.java, GhidraBridge.java): Gemini 8/20

Row numbers follow the Gemini list (sub-numbers = distinct sub-claims).

| # | verdict | evidence (file:line) | fix |
|---|---|---|---|
| 1 | CONFIRMED | Bridge.java:345 `static boolean isRawList(List<?> l) { return true; }`, so line 332 inlines every exact `java.util.ArrayList` returned by any Java method | Add a marker class `InlineList extends ArrayList<Object>`, use it at :71 and :141, test `v instanceof InlineList` at :332 and delete `isRawList` |
| 2.1 | CONFIRMED | Bridge.java:91-92 and :97-98: with a stale `h`, `t == null`, so `cls((String) r.get("c"))` runs; `c` is null, so `switch (n)` at :124 throws NPE; if `c` is set, it uses the static path | Add `reqHandle(r)`, which throws `stale handle`, and use it when `r.containsKey("h")` |
| 2.2 | CONFIRMED | :103 `listOf(null)` returns `[]` (:142); :104 `String.valueOf(null)` returns `"null"`; :106 `isInstance(null)` returns `false` | Use `reqHandle(r)` in `list`, `str` and `instanceof` |
| 3.1 | CONFIRMED | :47 `Json.str(String.valueOf(id)).replace("\"", "")` writes a string id without quotes, which is invalid JSON | Encode the id with `enc(id, sb)` |
| 3.2 | CONFIRMED | :56 `.append(id == null ? "null" : id)` writes a raw string id | Same: `enc(id, sb)` |
| 3.3 | CONFIRMED | :60 the replacement string in `replaceFirst` treats `$` and `\` as special; `[^,]*` stops at the first comma of an unquoted id | Replace with `return err(id, t);` once `err` encodes the id correctly |
| 4.1 | PARTIAL | :176 swallows the `setAccessible` failure; :180-190 `publicMethod` falls back to `m` when there is no public interface or class (rare case: packages not exported by a module) | Try `trySetAccessible()`; if it fails and nothing public was found, throw an explicit error |
| 4.2 | CONFIRMED | :79 `c.getConstructors()` and :173 `newInstance` with no access check on a non-public class, so `IllegalAccessException` | Before :173, check `Modifier.isPublic(c.getModifiers())` or call `trySetAccessible()` |
| 4.3 | PARTIAL | :134 returns the private `getDeclaredField` even when `setAccessible` failed, so `f.get` fails; looking up the subclass first does follow normal Java field shadowing | Return the declared field only if `trySetAccessible()` succeeds, otherwise continue, then fall back to `c.getField(n)` |
| 5 | CONFIRMED | :327 `Math.abs(Long.MIN_VALUE)` is negative, so it is `< 1L<<53` and the raw literal is written | `if (l > -(1L << 53) && l < (1L << 53))` |
| 6 | CONFIRMED | :303 `1e20 == Math.rint(1e20)` makes it integral; :305 `n.longValue()` saturates to `Long.MAX_VALUE` with no bounds check | For a Double or Float, require `Math.abs(d) <= 9007199254740992.0` before converting to `long` |
| 7.1 | CONFIRMED | :222 `catch (RuntimeException ex) { return -1; }` also swallows `IllegalStateException("stale handle")` (:236), `NumberFormatException` (:241) and Base64 `IllegalArgumentException` (:243); the caller then sees "no overload" (:169) | Catch only `NoConv` at :213 and :222 |
| 7.2 | PARTIAL | :254 `convCost(l.get(i), et, new int[1])` drops the element cost (confirmed); the claim about :213 is wrong, because `cost += c[0]` only runs after a successful conversion | Pass `cost` instead of `new int[1]` at :254 |
| 8 | CONFIRMED | :237 cost is 0 for any `t.isInstance(o)` other than Object; :166 `cost < bestCost` keeps the first one in `getMethods()` order, which is unspecified | Break ties by specificity: prefer `t2` when `t1.isAssignableFrom(t2)`, or add an inheritance-distance penalty |
| 9 | CONFIRMED | :155-156 adds the non-static methods when `target == null` (in `call` mode the first loop already covers everything); `Method.invoke(null, ...)` on an instance method throws NPE. The point about interfaces and Object methods does not apply to `static` | Delete :155-156 |
| 10 | CONFIRMED | :124-129 has no `void` case and no `X[]` suffix; `Class.forName("byte[]")` throws `ClassNotFoundException` | Add `case "void"` and `if (n.endsWith("[]")) return cls(n.substring(0, n.length()-2)).arrayType();` |
| 11.1 | CONFIRMED | :351 `parse()` does not check `i == s.length()`, so trailing text is ignored | Throw if `i != s.length()` after `ws()` |
| 11.2 | CONFIRMED | :358 `i++` consumes any character as `:`; `s.charAt(i++) == '}'` treats any other character as `,` | Add `expect(':')`, then accept only `','` or `'}'` |
| 11.3 | CONFIRMED | :363 the same problem for arrays | Accept only `','` or `']'` |
| 11.4 | PARTIAL | :366 `startsWith("true", i)` accepts `truefoo`; the trailing `foo` is caught only by the separator or end checks, which are themselves broken (11.1, 11.2) | Require a delimiter after the literal |
| 11.5 | CONFIRMED | :370-372 when `st == i`, `Long.parseLong("")` throws an NFE with no position (caught at :33) | Throw `"bad JSON at " + i` when `st == i` |
| 11.6 | PARTIAL | :378/:385: an unterminated string or a truncated `\u` throws `StringIndexOutOfBoundsException` (caught at :33); there is no infinite loop | Check bounds and report the position |
| 12.1 | CONFIRMED | :321 `((Number) v).doubleValue()` turns `0.1f` into `0.10000000149011612` | For a Float: `sb.append((float) f)` |
| 12.2 | CONFIRMED | :330 excludes `BigInteger`/`BigDecimal`, so they become a handle at :339-341; `convCost` does not handle them either | Encode `BigInteger` as `{"$long":"..."}` (or `$big`) and decode it in `convCost` |
| 13.1 | REFUTED | :27-38 is the only reader and processes requests sequentially; no other thread touches `handles`, `ids` or `next` in either file | none |
| 13.2 | PARTIAL | :27-39 on EOF, `main` returns without `System.exit` (confirmed); whether non-daemon Ghidra threads keep the JVM alive was not checked; the readLine OOM point is speculative | Add `System.exit(0);` after the loop at :38 |
| 14.1 | CONFIRMED | Bridge.java:9 `ghidra.GhidraLauncher Bridge` contradicts GhidraBridge.java:4 `ghidra.Ghidra GhidraBridge` | Change the Javadoc at :9 to `ghidra.Ghidra GhidraBridge` |
| 14.2 | PARTIAL | GhidraBridge.java:7-8 does ignore `layout`; that the client re-scans the installation was not verified (no client code in scope) | Store `layout` in `Bridge.launchLayout` and expose it through an op |

## 2b. system/ghidra-bun, provision/sync/proof/smoke/gen scripts: Gemini 8/20 (13 defects; verified by the reviewer)

| # | Gemini claim | Verdict | Evidence | Fix |
|---|---|---|---|---|
| 1 | Standalone `[workspace]` breaks the single-workspace rule and cannot build | Partial | `system/ghidra-bun/Cargo.toml:9-11` is a documented interim isolation; `docs/core/ARCHITECTURE-ROOT.md:9` requires one workspace. The "cannot compile" claim is not demonstrated: `aphrody-re` is a path dependency whose `workspace = true` fields resolve against its own root (`frameworks/re/Cargo.toml`, 29 inherited fields); the fr2 proof of 78c7c0ac used this layout. | Promote to the root members as the comment says. |
| 2 | Hard-coded edition, version, license, no `[lints]` | Confirmed | `system/ghidra-bun/Cargo.toml:3-7` edition 2021 versus root `Cargo.toml:234`; no `[lints]`. | Inherit from `[workspace.package]` when promoted. |
| 3 | Decompile loop reopens the binary per function, collapses same-name overloads, drops errors | Confirmed | `lib.rs:33` `if let Ok(c) = aphrody_re::decompile::decompile(path, f.entry_va)`; `frameworks/re/src/decompile.rs:20-21` `Program::open(path, None)?.decompile(address)` per call; `lib.rs:34` keyed by `f.name`. | Open once, key by `name@addr`, report errors. |
| 4 | ESM export surface differs from `plugin.ts`; U+2028/2029 not escaped | Partial | `lib.rs:52-59` exports `functions sections imports exports_ strings entry`; `plugin.ts:35-45` exports a different set (separate entry points: stub `.ghidra.js` versus `?ghidra`). The U+2028/2029 point is not a defect for ES2019+ parsers (JSON superset); not tested in Bun here. | Document the two surfaces or unify them. |
| 5 | No `catch_unwind` at the C boundary; `String::new()` hides read errors | Partial | No `catch_unwind` in `system/ghidra-bun` (rg); `lib.rs:72-75` falls back to an empty stub on error (intentional per the file header). A panic in an `extern "C"` function aborts the process in current Rust (not UB as claimed). | Wrap the body in `catch_unwind` and `log_error`. |
| 6 | `.max(1)`; `analyze` ignores the env default; sync NAPI | Confirmed | `lib.rs:25` `max_fns.max(1)`; `lib.rs:85` `unwrap_or(64)` while `lib.rs:16-21` reads `GHIDRA_BUN_MAX_FUNCTIONS`. | Default to `max_functions()` (the env reader) instead of the literal 64. |
| 7 | Crate name hard-coded | Confirmed | `lib.rs:90`; `ARCHITECTURE-ROOT.md:20`. | `env!("CARGO_PKG_NAME")`. |
| 8 | Standalone `bun-ghidra` bin; no `@types/bun` | Partial | `package.json:18-20`; `docs/ay/NAMING.md:18-19` "no per-tool binaries" (written for the `ay` CLI); no `devDependencies` in the file. | Expose as `ay ghidra` or accept the exception in NAMING.md; add `@types/bun`. |
| 9 | `provision-fr2.sh` weaknesses | Confirmed | `provision-fr2.sh:3` `set -u` without `-e`; `:6` no `apt-get update`; `:8` `curl` without checksum, partial `g.zip` is trusted at `:8`; `:7` `chown ubuntu`; `:12` prints "provisioned" regardless. | `set -euo pipefail`, `.part` plus sha256, `$(id -un)`. |
| 10 | `sync-fr2.ts` weaknesses | Confirmed | `sync-fr2.ts:5` undecoded `.pathname`; `:6` exit code unchecked, no `timeout`; `:9` `dest` unquoted; `:7` syncs `packages/ghidra` and `system/ghidra-bun` but not `frameworks/re` while `ghidra-bun/Cargo.toml:22` has `path = "../re"`; `:11` `process.exit`. | `fileURLToPath`, add `frameworks/re`, quote, check codes. |
| 11 | `native-proof.ts` can pass on a stale bundle | Confirmed | `native-proof.ts:8` no argument check; `:15` `/tmp`; `:19-25` prints `res.success` but never fails; a previous `out/app.js` is read at `:21-22`. | Throw on `!res.success`/non-zero run; use `mkdtempSync`. |
| 12 | `smoke.ts` hard-coded paths, null function, `process.exit` | Partial | `smoke.ts:3,5` Linux defaults (script targets fr2); `:11` `first` may be null (confirmed); `:14` `process.exit(0)` without `stop()` (the JVM follows stdio per `GHIDRA.md:47`). | Guard `first`; `await stop()`. |
| 13 | `gen-script-exports.ts`: untyped exports, name collisions | Partial | `gen-script-exports.ts:5` every export is `(...args: any[]) => Promise<any>` (confirmed; 193 exports, not 192). Collision claim not shown: `script.ts:29` re-exports the generated file only for the `./script` entry, `index.ts` does not. | Type from `Flat`. |

## 3a. packages/ghidra core: rpc.ts, api.ts, flat.ts, context.ts, script.ts: Gemini 11/20

| # | verdict | evidence (file:line) | fix |
|---|---|---|---|
| 1 | CONFIRMED | rpc.ts:183 `$release: () => self.#send({ op: "release", hs: [h] })` does not touch `#refs` and does not unregister; rpc.ts:199 `register(p, h)` has no token; Bridge.java `handles.remove` frees the shared id for every proxy. A later GC release on the dead id is harmless (`if (v != null)`). | `register(p, h, p)`; in `$release`, `unregister(p)`, decrement `#refs`, send only when it reaches 0 |
| 2.1 | CONFIRMED | rpc.ts:257 `new URL(import.meta.url).pathname.replace(...)` leaves `%20` encoded | `fileURLToPath(import.meta.url)` |
| 2.2 | CONFIRMED | rpc.ts:263 `java.endsWith("java")` is false for `...\java.exe`, so it falls back to `javac` from PATH | `java.replace(/java(\.exe)?$/i, "javac$1")` |
| 3.1 | CONFIRMED | rpc.ts:85 `opts.verbose ? "inherit" : "inherit"`; rpc.ts:114 `"bridge exited"` carries no stderr | `"pipe"` when not verbose, keep the stderr tail and add it to the rejection |
| 3.2 | PARTIAL | rpc.ts:107-112: the final fragment without `\n` is dropped. The CRLF claim is false: `JSON.parse` accepts a trailing `\r` as whitespace. | After the loop, `#buf += dec.decode()` and process the remainder |
| 3.3 | CONFIRMED | rpc.ts:120 `catch { return; }`: a corrupted response leaves its pending promise waiting forever | Log the line; on protocol corruption, reject all of `#pending` |
| 4 | PARTIAL | rpc.ts:134-135: `write`/`flush` are unguarded, so a sync throw rejects the promise but `#pending` keeps the entry. The `fromProcess` claim is false: rpc.ts:94 sets `#proc` before use. | `try { write; flush } catch (e) { #pending.delete(id); rej(e) }` |
| 5.1 | PARTIAL | rpc.ts:153: `Object.keys(proxy)` gives 5 keys, so the `$class` branch is skipped, but rpc.ts:156 `return v` then `JSON.stringify` still emits `{"$class":...}` (functions omitted; `toJSON` is in RESERVED), so it works. A user object `{ $class }` with 3 keys or fewer is hijacked. | Mark proxies with a private Symbol, not a key count |
| 5.2 | PARTIAL | Bridge.java (end of the Map branch) `throw new NoConv();` for any Map without a marker. This is a design limit, not silent corruption. | Reject plain objects in `encode` with an explicit JS error |
| 6 | CONFIRMED | rpc.ts:185 `toString` returns a Promise; rpc.ts:16-28 does not declare it, so TS types it as `string`. rpc.ts:186: `String(jobj)` gives the debug tag. | Declare `toString(): Promise<string>` in `JObject` |
| 7.1 | CONFIRMED | api.ts:36 is the only use of `extraClasspath` (written, never read); `StartOptions` (rpc.ts:38-47) has no classpath | Add `classpath?: string[]` and append it to `-cp` (rpc.ts:82) |
| 7.2 | PARTIAL | api.ts:41 `if (started()) return session!;` ignores the new options without a warning | Throw or warn when the options differ |
| 8 | CONFIRMED | api.ts:58-59: the comment says it defers init, but the class is an empty subclass of Headless, so `initGhidra` runs in `start()` | No-op `initGhidra` plus a public `initializeGhidra()` |
| 9.1 | CONFIRMED | api.ts:43-45 `session = s;` before `await this.initGhidra(s)`; no `close` on failure | Assign after init; `catch { await s.close(); throw }` |
| 9.2 | CONFIRMED | api.ts:41, api.ts:74: no in-flight promise, so two concurrent `ensureStarted` calls start two JVMs | Single `starting: Promise<Session>` |
| 10.1 | CONFIRMED | api.ts:281 `dirname(bp!)` with `bp === null` throws a TypeError | `if (bp === null && !o.projectLocation) throw` |
| 10.2 | CONFIRMED | api.ts:301-318: `program` can stay null and is passed to `FlatProgramAPI`/`shouldAskToAnalyze`; api.ts:338 `program!` | `if (program === null) throw` before api.ts:316 |
| 10.3 | CONFIRMED | api.ts:296-328: no try/catch after `openProject`/`acquireBundleHostReference` (api.ts:317) | try/catch that calls `releaseBundleHostReference` and `project.close()` |
| 10.4 | REFUTED | api.ts:317 and api.ts:322-326: the nested acquire is balanced by its `finally`; it is a reference counter, so redundant but harmless | — |
| 10.5 | CONFIRMED | api.ts:333-335: sequential `release`, `save`, `close`; a failing `save` skips `close` | Separate try/finally per step |
| 11.1 | REFUTED | api.ts:59: Deferred behaves exactly like Headless, so the "absent with Deferred" case does not exist. The classloader claim is unproven in the code (rpc.ts:78 GhidraClassLoader loads the install modules). | — |
| 11.2 | PARTIAL | PARITY.md:130: the same `GhidraScriptLoadException` occurs "in both runtimes", so pyghidra fails the same way and "contrary to pyghidra" is false. A missing source bundle directory is a plausible cause. | `GhidraScriptUtil.getBundleHost().add(parentDir, true, false)` in try/finally around api.ts:209-222 |
| 12.1 | PARTIAL | api.ts:372 `import(resolve(scriptPath) + "?run=" + ...)`: a raw Windows path with a query is not portable (not tested in this session) | `pathToFileURL(resolve(scriptPath)).href + "?run=..."` |
| 12.2 | CONFIRMED | api.ts:337 `createFlat(..., { scriptName: "bun-ghidra" })`; api.ts:371 `flat: h.script`; script.generated.ts:126 routes `getScriptArgs` to `flat.getScriptArgs`, which returns `[]` (flat.ts:105) | Build a dedicated `createFlat` in `runScript` with `scriptArgs`/`scriptName` |
| 12.3 | CONFIRMED | api.ts:78-82: `stop()` does not reset `headlessInterpreter` (api.ts:350) | `headlessInterpreter = undefined` in `stop()` |
| 12.4 | CONFIRMED | flat.ts:119: everything outside LOCAL_METHODS goes to `FlatProgramAPI` (api.ts:337). `getGhidraVersion`, `getState`, `goTo` and others are absent from FLAT_PROGRAM_API (flat.ts:7-30), so the bridge errors. | Local implementations, or a `GhidraScript` backend on the bridge side |
| 13.1 | PARTIAL | api.ts:406-407: `# c=foo` becomes a key in ExtensionDetails. ApplicationInfo is safe because api.ts:392 requires `^application.`. `kv.name!` is unchecked. | Skip `#`/`!` lines, trim, validate required keys |
| 13.2 | CONFIRMED | api.ts:412 `${k}=${v}` produces `version=null` | Filter null/undefined in `toString` |
| 14.1 | CONFIRMED | flat.ts:93 `return env;` (raw string) for `askInt`/`askLong`/`askBytes`/`askAddress` (flat.ts:113) | Per-type parsing (`parseInt`, `BigInt`, hex, `toAddr`) |
| 14.2 | CONFIRMED | flat.ts:108 `ask("yesno", true)` never cancels; `=== "true"` is case sensitive | No implicit fallback; `/^(true\|yes\|1)$/i` |
| 14.3 | CONFIRMED | flat.ts:73 message names "script args", but `ask` (flat.ts:91-96) never reads `scriptArgs` | Consume `scriptArgs`, or fix the message |
| 15.1 | CONFIRMED | flat.ts:133 `Number(a).toString(16)`: bigint loses precision and -1 gives `-1` | bigint path plus two's complement (`BigInt.asUintN(64, ...)`) |
| 15.2 | CONFIRMED | flat.ts:137-138 `padStart(width)` pads with spaces; the `0` of `%08x` is not handled | `padStart(width, w.startsWith("0") ? "0" : " ")` |
| 15.3 | CONFIRMED | flat.ts:127: the regex only accepts `[sdxXfn%]`, so `%c`/`%b`/`%o`/`%e` stay literal without consuming an argument and later arguments shift; `%.Ns` (flat.ts:136) ignores the precision | Extend the regex, plus `s.slice(0, p)` for `%s` |
| 16 | CONFIRMED | flat.ts:117 only filters `then`, so `JSON.stringify(flat)` makes a `callFlat("toJSON")` call; `String(flat)` gets a Promise from `toString`/`valueOf`, then a TypeError | Shared RESERVED set (`toJSON`, `valueOf`, `toString`, `constructor`, `inspect`) |
| 17.1 | CONFIRMED | context.ts:23 `let ctx` is a global; context.ts:27 `clearContext()` clears the parent context; script.ts:7-14 are module bindings | `AsyncLocalStorage` plus a context stack |
| 17.2 | CONFIRMED | script.ts:24 `sourceFile = c?.scriptName`; context.ts:5-21 has no `sourceFile` field while flat.ts:53 lists it | Add `sourceFile?: JObject \| null` to `ScriptContext` and bind it |

## 3b. packages/ghidra plugin, analysis, cli, index, preload, tests, parity scripts: Gemini 11/20

The `score` row is Gemini's justification claims (type-check failures, parity inflation).

| # | verdict | evidence (file:line) | fix |
|---|---|---|---|
| score | PARTIAL | Les TS18048/TS2322 se reproduisent bien avec `tsc --strict`. En revanche, la note sur la parité trompeuse va trop loin : `run.ts:88,105-106` publie déjà le compte `bothErr` et une section « Identical errors (not a functional proof) » (`PARITY.md:128`). | Voir les lignes ci-dessous. |
| 1 | CONFIRMED | `plugin.ts:22` déclare `keepAlive`, mais il n'est lu nulle part. `started`/`stop` (l.7) ne servent qu'à `shutdown()` (l.106). | Enregistrer une fois `process.once("beforeExit", () => { if (!o.keepAlive) void shutdown(); })` dans `setup`. |
| 2 | CONFIRMED | Le retour anticipé de `plugin.ts:28` conserve `?ghidra=native` dans `file`. La l.32 transforme un backend inconnu en `undefined` sans erreur. | Retirer le préfixe `ghidra:` puis appliquer `QUERY`, et lever une erreur si la valeur n'est ni `jvm` ni `native`. |
| 3.1 | CONFIRMED | `plugin.ts:39` exécute `analysis.functions` : un JSON `null` lève un TypeError au chargement. | Dans `analyzeToModule`, rejeter tout résultat parsé qui n'est pas un objet non-null. |
| 3.2 | CONFIRMED | `re/src/ghidra.rs:85-104` expose `entry_va`, `size_bytes`, `pseudo_c` et `sections`, sans `language`. `plugin.ts:42` exporte donc `language` à undefined et des formes de fonctions différentes. | Normaliser `BinarySreReport` vers `ProgramSummary` avant `renderModule`. |
| 4.1 | CONFIRMED | `plugin.ts:50` : la clé de cache omet `projectLocation` et `nativeAddon`. | Les ajouter à la clé. |
| 4.2 | PARTIAL | `plugin.ts:67` met en cache la promesse rejetée. Mais `onStart` vide le cache (l.76) à chaque build : le blocage ne dure qu'à l'exécution (preload). | `p.catch(() => cache.delete(key))` |
| 5 | CONFIRMED | `plugin.ts:57` : `require(addon)` résout un chemin relatif depuis `src/plugin.ts`, pas depuis le cwd. | `require(isAbsolute(addon) ? addon : resolve(process.cwd(), addon))` |
| 6 | CONFIRMED | `plugin.ts:60` a `/tmp` en dur. `api.ts:216` donne `projectName = basename_ghidra`, puis `api.ts:238-239` rouvre le programme homonyme déjà présent, ce qui fait collisionner `/a/foo.exe` et `/b/foo.exe`. | Utiliser `join(tmpdir(), …)` et un `projectName` suffixé par un hash du chemin absolu. |
| 7 | CONFIRMED | `plugin.ts:83,87` : `split("#")` tronque un chemin qui contient `#`. | Découper sur `lastIndexOf("#")` en ajoutant toujours le suffixe. |
| 8.1 | CONFIRMED | `tsc --strict` donne `analysis.ts(38,11)`, `(41,23)` et `(45,20)` TS18048. | `const d = ifc ?? await s.newObject(...)` |
| 8.2 | CONFIRMED | `analysis.ts:37-39` et `51-52` : `openProgram` est appelé hors du try/finally, donc `dispose` est sauté s'il lève. | Déplacer `openProgram` dans le try, et faire un try/catch+dispose dans `decompiler()`. |
| 9 | CONFIRMED | `analysis.ts:61,63` : le décompilateur est ouvert même avec `max=0`, `slice(0,NaN)` renvoie `[]` et `slice(0,-1)` coupe le dernier élément. | Borner `limit` puis ouvrir seulement si `decompile && slice.length > 0`. |
| 10.1 | REFUTED | `analysis.ts:98,100` : `getCompilerSpec()` et `getImageBase()` ne renvoient pas null sur un `Program` ouvert (contrat Ghidra). Rien n'est reproduit. | — |
| 10.2 | CONFIRMED | `analysis.ts:103` refait l'appel `getFunctionManager()` déjà fait en l.57 (un aller-retour RPC en trop). | Récupérer `fm` une seule fois et le passer. |
| 11.1 | CONFIRMED | `cli.ts:8,21` : `--max --decompile` donne `Number("--decompile")`, soit NaN, puis `[]`. | Exiger un entier ≥ 0, sinon `exit 2`. |
| 11.2 | CONFIRMED | `cli.ts:9` : `TMPDIR ?? "/tmp"`. | `tmpdir()` |
| 12 | CONFIRMED | `cli.ts:17` passe `rest[0]!`, et `api.ts:371-372` exécute `basename(undefined)`/`resolve(undefined)`, d'où un TypeError après une ouverture complète. `--no-analyze` n'est pas transmis (comparer à l.19). | Vérifier `rest[0]` avant l'appel et passer `analyze: !flag("--no-analyze")`. |
| 13.1 | CONFIRMED | `cli.ts:22` : `listFunctions(h.program)` est appelé sans options. | Passer `max`/`decompile`. |
| 13.2 | CONFIRMED | `cli.ts:24-25` : pas de vérification de `rest[0]`, pas de `break`, pas de normalisation `0x`, et sortie 0 si rien ne correspond. | Valider, retirer `^0x`, `break`, puis `exitCode = 1` si rien n'est trouvé. |
| 14 | PARTIAL | `cli.ts:15-34` : il n'y a pas de catch, donc une stack trace brute et un exit 1. La troncature de stdout par `exit(0)` (l.34) est une hypothèse, non reproduite. | Ajouter un catch qui écrit sur stderr avec `exitCode = 1`, et remplacer `process.exit(0)` par `exitCode`. |
| 15 | PARTIAL | `index.ts:1-4` avec `api.ts:253` : les exports sont redondants mais valides en ESM (même binding, aucune erreur). Les symboles du plugin ne sont pas dans l'index, mais `package.json` les expose via `"./plugin"`, ce qui est volontaire. | Retirer `export { Session, setContext, clearContext }` de `api.ts:253`. |
| 16 | PARTIAL | `preload.ts:4` n'a ni lecture d'env ni hook d'arrêt. `ghidra-bun/src/lib.rs:17` lit bien `GHIDRA_BUN_MAX_FUNCTIONS`, mais c'est un autre composant (onBeforeParse). | Lire les variables `GHIDRA_BUN_*` et ajouter `process.once("beforeExit", shutdown)`. |
| 17.1 | CONFIRMED | `ghidra.test.ts:12-25,28-31` : `s.close()` n'est pas dans un finally. | Utiliser try/finally. |
| 17.2 | CONFIRMED | `ghidra.test.ts:58-60,69-72` : la mutation de l'env et du contexte n'a pas de finally. | Utiliser try/finally. |
| 17.3 | CONFIRMED | `ghidra.test.ts:93` : `TEMP ?? "/tmp"`, et le fichier n'est jamais supprimé. | Utiliser `tmpdir()` et `unlinkSync` dans un finally. |
| 17.4 | CONFIRMED | `test/` ne contient que `ghidra.test.ts` : `ghidraPlugin`, `summarize`, `listFunctions` et `cli` ne sont pas testés. | Ajouter des tests mock pour le plugin et `summarize`. |
| 18.1 | CONFIRMED | `mock-bridge.ts:10` fait `n++` à chaque appel, alors que `Bridge.java:16` utilise un `IdentityHashMap`. | Ajouter une `Map<object, number>` d'identité. |
| 18.2 | CONFIRMED | `mock-bridge.ts:27-31` : `run()` ne gère que `ping`/`static`, alors que `Bridge.java:70-75` appelle `handle2` sur toutes les opérations. | Un seul `dispatch(r)`, partagé par la boucle et `batch`. |
| 19.1 | PARTIAL | `run.ts:9` : `.pathname` donne `/C:/...` sous Windows, mais le script cible fr2 sous Linux (l.1, chemins `/srv`). | `import.meta.dir` |
| 19.2 | PARTIAL | `run.ts:43` : chemin interpolé sans échappement, problème réel uniquement sous Windows. | `JSON.stringify(join(pkg, "src/script.ts"))` |
| 20.1 | CONFIRMED | `run.ts:32` : le code de retour de zip n'est pas vérifié (contrairement à gcc en l.30). | Lever une erreur si `code !== 0`. |
| 20.2 | CONFIRMED | `run.ts:53,58` : les codes sont seulement affichés, puis `readFileSync` (l.61-65) échoue avec ENOENT. | Lever une erreur si `py.code` ou `bn.code` est non nul. |
| 21 | PARTIAL | `run.ts:75` : `same` inclut `bothErr`, et la table l.103 affiche « identical ». Mais l.88 et `PARITY.md:128` signalent bien le cas. La cause « répertoire non enregistré dans `scriptDirectories` » n'est pas vérifiée. | Statut `BOTH_ERROR` à la l.103. |
| 22 | CONFIRMED | `parity.ts:8-9` utilise `as [string, string]` et `!` sans aucune validation. | Lever une erreur d'usage si un élément manque. |
| 23.1 | CONFIRMED | `parity.ts`, entrées decompile/pcode : `dispose` n'est pas dans un finally, et `getDecompiledFunction()`/`getHighFunction()` sont utilisés sans test de null. | try/finally et test de null. |
| 23.2 | CONFIRMED | `parity.ts`, entrée `api.open_filesystem` : `fs` n'est jamais fermé. | try/finally avec `await fs.close()` |
| 24 | CONFIRMED | `packages/ghidra` n'a pas de `tsconfig.json`, et il est absent des références de `C:/aphrody/tsconfig.json:3-18`. `tsc --strict` donne `api.ts(116,17)` TS2322. | Ajouter un `tsconfig.json`, une référence dans le tsconfig racine, et `const c = consumer ?? await s.newObject(...)`. |

## 4a. system/py2bun/src/emit.rs lines 1-860: Gemini 11/20

| # | verdict | preuve (file:line) | correctif |
|---|---|---|---|
| 1.1 | CONFIRMED | emit.rs:86 `Err(_) => return fail(... e.error)` : l'erreur et la position viennent du premier parse | Garder `Err(e2)` et calculer line_col sur `fixed_src` avec `e2.location` |
| 1.2 | PARTIAL | emit.rs:83 `source = &fixed_src` : les lignes ne bougent pas, mais les colonnes des lignes réécrites décalent | Remapper les colonnes des lignes listées dans `fixed_lines` |
| 2 | CONFIRMED | emit.rs:109 `off - ...rposition(...)` : colonne en octets | `src[line_start..off].chars().count() + 1` |
| 3.1 | CONFIRMED | emit.rs:126 `format!("{id}_")` sans contrôle de collision | Renommer avec un suffixe propre au transpileur (`$`) ou vérifier la table du scope |
| 3.2 | CONFIRMED | emit.rs:124-130 : aucune garde pour les noms `__*`, alors que `fresh` produit `__{p}N` (l.350) | Réécrire les identifiants utilisateur qui commencent par `__py` ou `__` |
| 3.3 | PARTIAL | emit.rs:125 laisse passer `constructor`, mais la collision avec `__init__` dépend de `function()` (non lu) | Renommer `constructor` sauf quand le nom vient de `__init__` |
| 4 | CONFIRMED | emit.rs:153 `String::new()` ; l.164 pas de cas `\u{7f}` (alors que l.144 l'a) | Ajouter `\|\| c == '\u{7f}'` et `with_capacity` |
| 5.1 | CONFIRMED | emit.rs:217-218 insère `"*"` dans `imported` | Filtrer `a.name != "*"` |
| 5.2 | CONFIRMED | emit.rs:246 : les compréhensions sont ignorées, donc la cible de `:=` dans une compréhension n'est pas collectée | Parcourir les compréhensions et ne collecter que les cibles de `Expr::Named` |
| 6 | CONFIRMED | emit.rs:348-351 `__{p}{tmp}` sans `lookup` | Boucler tant que `lookup(cand)` est vrai, ou renommer les `__` utilisateur (3.2) |
| 7.1 | CONFIRMED | emit.rs:381 `await __py.starPick` est émis quel que soit `mode` | En `AsyncMode::Off`, émettre une erreur ou une variante synchrone |
| 7.2 | PARTIAL | emit.rs:380 : aucun filtre sur `imports`/`flat_used`, mais qui remplit `star_names` n'a pas été lu | Retirer de `star_names` les noms déjà importés |
| 8.1 | CONFIRMED | emit.rs:404 et 423-424 : `deep.imported` (imports imbriqués) est fusionné au module et retiré de `lets` ; tous les `deep.imports` sont hissés (l.412) | Ne hisser que `shallow.imported` ; aliaser les imports locaux |
| 8.2 | PARTIAL | emit.rs:403 et 423 : un `def` dans un `if` retire `let f`. ES strict rend la fonction locale au bloc, mais l.571 passe par `function()` (non lu, forme exacte inconnue) | Déclarer `let f` et émettre `f = function...` pour les def dans un bloc |
| 9 | CONFIRMED | emit.rs:513 `const { .. } = __ospath` ; les liaisons d'import ES sont immuables et l.424 retire le `let` | Importer sous `__imp_n` puis `let n = __imp_n` si le nom est réassigné |
| 10 | CONFIRMED | emit.rs:408 map plate des `def` top-level ; l.1837-1838 `lookup(nm)` puis `user_funcs.get(nm)` sans scope | Signatures par scope, invalidées si le nom est assigné |
| 11.1 | CONFIRMED | emit.rs:463-468 : `os.path as osp` donne `import * as osp from ".../os"` | Émettre `import { path as osp }` quand `full == "os.path"` avec un alias |
| 11.2 | CONFIRMED | emit.rs:470 et names.rs:47 : `jarray` et `typing` abandonnés sans liaison | Lier un shim, ou émettre un diagnostic quand le nom est utilisé |
| 12.1 | CONFIRMED | emit.rs:1940-1942 `ident_import` renvoie `n` brut ; l.484 | Renvoyer `format!("{n} as {}", ident(n))` quand le nom est renommé |
| 12.2 | PARTIAL | emit.rs:509 `ident(name)` donne `{ type_ }` et cherche la mauvaise propriété (confirmé) ; les doublons `const` ne sont pas dédupliqués par `seen` (l.369) seulement si les noms diffèrent, une ligne identique est dédupliquée | Écrire `{ orig: ident(orig) }` et dédupliquer par nom |
| 12.3 | CONFIRMED | emit.rs:515 : niveau 1 avec module vide donne `"./"` | Module vide : importer `./<name>` pour chaque nom |
| 13 | CONFIRMED | emit.rs:593-594 : un Tuple ou une List tombe dans `"del of a plain name"` | Déplier Tuple et List récursivement |
| 14.1 | CONFIRMED | emit.rs:1302-1316 : le corps de classe ne gère que FunctionDef, Pass, Expr et Assign ; AnnAssign va vers `unsupported` | Gérer AnnAssign : `static x = v` si une valeur existe, sinon rien |
| 14.2 | PARTIAL | emit.rs:603 : sans valeur, rien n'est émis ; Python évalue bien l'objet et l'indice d'une cible complexe (même sans valeur), d'où un effet perdu mineur | Évaluer la cible pour ses effets quand elle n'est pas un Name |
| 15.1 | CONFIRMED | emit.rs:723 et 1766 `any(is_lowercase)` exclut `URL` (l.719 couvre seulement `java_names`) | Supprimer l'exigence de minuscule en position d'appel |
| 15.2 | CONFIRMED | emit.rs:717 `user_classes` global et `lookup` accepte n'importe quel scope | Résoudre le nom dans le scope le plus proche et vérifier qu'il y est lié à une classe |
| 16.1 | CONFIRMED | emit.rs:754 `[a, b] = val` brut ; une Map se déstructure en entrées | `[a,b] = __py.unpack(val, n)` via `__py.iter` (index.ts:353 renvoie les clés) |
| 16.2 | CONFIRMED | emit.rs:754 : aucun contrôle de longueur | `unpack` lève ValueError si la longueur diffère |
| 17 | CONFIRMED | emit.rs:771 et 781 : la chaîne `__py.unsupported(...)` est placée dans un motif LHS, ce qui est une SyntaxError | Lier des temporaires dans le motif, puis `store()` après l'affectation |
| 18.1 | CONFIRMED | emit.rs:795-802 : `+=` natif si le RHS est un littéral (`[1] += "ab"` donne `"1ab"`, BigInt mélangé lève TypeError) | Supprimer le raccourci `simple_rhs` |
| 18.2 | PARTIAL | emit.rs:799 `/=` donne Infinity ; mais le chemin général l.1575 `({l} / {r})` ne lève pas ZeroDivisionError non plus | Router Div vers `__py.truediv` avec contrôle de zéro |
| 18.3 | CONFIRMED | emit.rs:1570-1572 `_aug` est ignoré, `__py.add` toujours utilisé ; `iadd` (index.ts:191) n'est jamais émis | Si `aug && Add`, émettre `__py.iadd` |
| 19 | CONFIRMED | emit.rs:809-814 : `expr(target)` puis `store(target)` évaluent la cible deux fois (seulement un Warning) | Placer l'objet et la clé dans des const temporaires |
| 20.1 | CONFIRMED | emit.rs:824 et 834 : `pattern()` peut renvoyer `__py.unsupported(...)` dans `for (... of` | Itérer sur `const __v`, puis `store(target, "__v")` |
| 20.2 | PARTIAL | emit.rs:827-828 : `it` brut pour `async for` (confirmé), mais `__py.aiter` est introuvable dans runtime/index.ts (rg vide) alors que l.830 l'émet | Définir et exporter `aiter` dans le runtime et l'utiliser aussi pour `is_async` |
| 21.1 | CONFIRMED | emit.rs:871-873 `finally { ctxExit(cm) }` ; index.ts:860 `__exit__(null, null, null)` : ni exception transmise ni suppression | Utiliser `catch(e)` puis `ctxExit(cm, e)`, ne relancer que si le retour est falsy |
| 21.2 | CONFIRMED | index.ts:855-863 : ni `__aenter__`/`__aexit__` ni `Symbol.asyncDispose` | Ajouter `ctxAEnter`/`ctxAExit` et les émettre si `is_async` |

## 4b. system/py2bun/src/emit.rs lines 861-1942: Gemini 9/20

| # | verdict | evidence (file:line) | fix |
|---|---|---|---|
| 1 | CONFIRMED | emit.rs:873 `__py.ctxExit({cm})` in `finally`; index.ts:860 `cm.__exit__(null, null, null)`, return value ignored | Emit `catch (__e) { if (!(await? __py.ctxExitErr(cm, __e))) throw __e; }` plus a success-only `ctxExit`, and add `ctxExitErr` to the runtime |
| 2 | PARTIAL | emit.rs:893-896: the extra `{ }` comes with `block()` indentation (emit.rs:560-563), so indentation is fine. The real effect is block scope: a `def`/`class` in the body becomes block-scoped in strict ESM, and the `try {` at 903 does the same | Hoist `def`/`class` in try bodies as `let` assignments (`name = function...`), or drop the extra braces at 893/896 |
| 3.1 | PARTIAL | emit.rs:936 `{n} = {ev};` with no unbind after the handler; this only changes behaviour when code reads `e` after the `except` | Emit `try { body } finally { e = undefined; }` for `except E as e` |
| 3.2 | REFUTED | emit.rs:925: `py2name` is set only when `!self.lookup(id)`, so a `let` cannot collide with a declared name | - |
| 4 | CONFIRMED | emit.rs:1054 `self.scopes.push(sc)` runs before `self.expr(d)` at 1068/1084/1100. Defaults are emitted into the JS signature or destructuring (1069, 1101), so they are re-evaluated on every call and `x=x` hits the TDZ | Evaluate defaults before 1054 into module or parent `const __dN`, and reference `__dN` |
| 5 | CONFIRMED | emit.rs:1077 `let [..] = __a;` drops extra arguments silently; 1080-1093 destructure only `kwonlyargs` from `__kw`, so `f(a=1)` leaves `a` undefined (index.ts:71-77 `popkw`) | For each positional, use `__a[i]` when present, else `__kw.name` (deleting the key); raise `TypeError` on excess arguments |
| 6.1 | CONFIRMED | emit.rs:1134 `format!("{decl} {sn} = this;")` with no `ident()`. `def m(this)` gives `const this = this`; the `in` example is not valid Python | `ident(sn)` in `alias` |
| 6.2 | REFUTED | `static` at emit.rs:1209: in a JS static method `this` is the class when it is called as `Cls.m()` | - |
| 7 | CONFIRMED | emit.rs:1158 `super({args});` is emitted before the `j < i` loop (1163-1166) | Emit `body[..i]` (when it does not touch `self`) before `super(..)` |
| 8.1 | CONFIRMED | emit.rs:1206 maps both `__str__` and `__repr__` to `toString`, which duplicates the method | Emit `__repr__` under its own name (or a `__repr__` method) when `__str__` exists |
| 8.2 | PARTIAL | emit.rs:1200 `f.is_async \|\|` ignores `sync_forced`, so `async def __init__` emits `async constructor` (invalid JS); a generator `__init__` gives `*constructor`. The "missing implicit return" claim in the title has no evidence | Diagnose `is_async`/`is_gen` when `sync_forced`, and use `!sync_forced && (f.is_async \|\| self.asyncs)` |
| 9 | PARTIAL | emit.rs:1253 and 1547 `...__py.iter(x)`. index.ts:355 handles a sync Java `.iterator()`, but an async generator (only `Symbol.asyncIterator`) is not handled | In async mode emit `...(await __py.a_list(x))` |
| 10.1 | CONFIRMED | emit.rs:1309: only `Assign` is handled, so `AnnAssign` falls to 1315 `unsupported("statement in class body")` | Handle `AnnAssign` with a value as `static name = v` |
| 10.2 | CONFIRMED | emit.rs:1299 pushes an empty scope and 1309-1313 never insert `n`, so `y = x + 1` cannot see `x` | Insert `n` into the class scope and resolve it as `ClassName.n` |
| 11 | REFUTED | emit.rs:1354: every `cond` output starting with `(` is either fully wrapped (1336, 1614-1627) or the chained IIFE `((..)=>..)(..)`, where `!` applied to a call is correct. No failing case could be built | - |
| 12 | CONFIRMED | emit.rs:239: any `Name` (including Store) in `JAVA_ROOTS` sets `ghidra_hit`; names.rs:39-40 includes `db`, `resources`, `agent`; emit.rs:418 then turns on async mode | Set `ghidra_hit` only for a `Load` of a root that is neither assigned nor imported (or only on attribute chains) |
| 13.1 | CONFIRMED | emit.rs:1400 `s.len() > 15` turns safe 16-digit integers (<= 2^53-1) into BigInt. The minus-sign sub-claim is refuted: `USub` is a separate node | Compare the value with `9_007_199_254_740_991` |
| 13.2 | CONFIRMED | emit.rs:1573 `({l} - {r})` and 1575 `({l} / {r})` are native, so BigInt mixed with number throws `TypeError` | Route Sub/Div (and Lt/...) through `__py.sub`/`__py.div` helpers that coerce |
| 14 | CONFIRMED | emit.rs:1407: `inf.fract()` is NaN, so the branch fails and 1410 `{f:?}` emits `inf`, an undefined JS identifier | Map `is_infinite()` to `Infinity`/`-Infinity` and `is_nan()` to `NaN` |
| 15 | CONFIRMED | emit.rs:246: `Collector` skips comprehensions entirely, so a walrus target inside a comprehension is never declared and 1447 `(y = v)` throws a ReferenceError in strict mode | Walk comprehensions in `Collector` only to collect `Expr::Named` targets |
| 16 | CONFIRMED | emit.rs:1455 `matches!(&*b.left, Expr::StringLiteral(_))` only | In async mode route every `Mod` to `__py.a_mod` |
| 17 | CONFIRMED | emit.rs:1461 `let o = self.expr(&u.operand)` runs before 1463 `paren_cond(&u.operand)`, so the operand is emitted twice (duplicate diagnostics, side effects) | Handle `Not` before computing `o` |
| 18.1 | CONFIRMED | emit.rs:1476 `scopes.push(names)` runs before 1481 `self.expr(d)`, so `lambda x=x:` gives `(x = x) =>` (TDZ) | Evaluate defaults before the push |
| 18.2 | CONFIRMED | emit.rs:1473-1475 insert only posonly/args/kwonly; `vararg` is missing from `names` | Insert `p.vararg` (and `kwarg`) into `names` |
| 19.1 | CONFIRMED | emit.rs:1595: every operand is evaluated up front as an IIFE argument, so there is no short-circuit | Evaluate operands sequentially: `(t1 = b, a < t1) && (t2 = c, t1 < t2)` |
| 19.2 | CONFIRMED | emit.rs:1599 `cmp_strs(.., None, None)`, so `is None` in a chain emits `===` instead of `== null` | Pass `Some(&c.operands[i])`, `Some(&c.operands[i+1])` |
| 19.3 | CONFIRMED | emit.rs:1597 `no_await += 1`, so chained `==` uses sync `__py.eq` instead of `a_eq` in async mode | Use an async IIFE plus `await` when `asyncs && no_await == 0` |
| 20 | CONFIRMED | emit.rs:1614-1615 test only `none(re)`; `None is x` reaches 1616 `(null === x)` | Test `none(le) \|\| none(re)` and compare the other operand with `== null` |
| 21.1 | CONFIRMED | emit.rs:1624-1627 use native `<`, which compares arrays as strings, while index.ts:444-450 `cmp` already handles lists | Emit `(__py.cmp(l, r) < 0)` unless both operands are numeric or string literals |
| 21.2 | PARTIAL | emit.rs:1628 sync `__py.contains` in async mode and no `a_contains` in runtime/async.ts; this breaks only for async Java proxies | Add `a_contains` and emit it in async mode |
| 22.1 | CONFIRMED | emit.rs:1642 `scopes.push(names)` runs before 1653 `self.expr(&g.iter)`, so `[x for x in x]` gives `for (const x of __py.iter(x))`, a TDZ ReferenceError | Emit `gens[0].iter` before the push, and add each target only after its own iter |
| 22.2 | CONFIRMED | emit.rs:1695 calls `pattern`, and 770 emits `a.x` for `Attribute`, so `for (const a.x of ..)` is a syntax error | In `decl_pattern`, allow only Name/Tuple/List, else use a temporary plus an assignment |
| 23.1 | PARTIAL | emit.rs:1723 `&self.src[rs + 1..es]`: `rs` is always the ASCII `{`, so no panic was shown; the hand slicing is fragile only if `src` differs from the parsed text | Build the text from `i.debug_text` (`leading`/`trailing`) |
| 23.2 | CONFIRMED | emit.rs:1738: with a `format_spec`, `__py.format(v, ..)` is called with no `a_str`/await in async mode | Emit `__py.format(await __py.a_str(v), ..)` (or add an `a_format`) in async mode |
| 24.1 | CONFIRMED | emit.rs:1815 `super.{m}(..)` with `m = "__str__"`, while the method is defined as `toString` at 1206 | Apply the same `__str__`/`__repr__` to `toString` mapping to `m` |
| 24.2 | REFUTED | emit.rs:1808: the arguments of `super(Cls, self)` are ignored, which is the correct JS semantics; 1229 checks `self` for `Base.__init__` | - |
| 25.1 | CONFIRMED | emit.rs:1842 `if i < slots.len()` drops extra arguments silently | Fall back to the generic path when `args.len() > params.len()` |
| 25.2 | CONFIRMED | emit.rs:1848 overwrites `slots[idx]` even when it is already `Some` | Fall back or diagnose `TypeError` when a slot is already filled |
| 25.3 | CONFIRMED | emit.rs:1843: `call_arg` of `Starred` gives `...__py.iter(xs)` in a single slot, which shifts the following positions | Disable the rewrite when any argument is `Starred` |
| 25.4 | CONFIRMED | emit.rs:408 `user_funcs` holds top-level functions only, but 1837 `self.lookup(nm)` is also true for a local that shadows the name | Apply only when `nm` resolves in the module scope (`scopes[0]`) and in no inner scope |
| 26 | CONFIRMED | emit.rs:1928 `c == '_' && i > 0` gives `__init__` -> `_Init`, `foo__bar` -> `fooBar`, `foo_` -> `foo`; 1529 has no `ident()` | Keep leading/trailing `_` and dunders, convert only internal `_[a-z0-9]`, wrap the result in `ident()` |

## 5a. system/py2bun Rust rest and system/py2bun-ts CLI/wrapper/packaging (first call: plan with 16 defects, no score)

| # | verdict | evidence (file:line) | fix |
|---|---|---|---|
| 1.1 | CONFIRMED | system/py2bun-ts/src/cli.ts:5-8: seuls `-o` et un fichier positionnel sont lus. Aucun support de stdin, `--output`, `--strict`, `--json`, `--async`, `--sync` ni `-h`. | Analyser les mêmes options que main.rs et les transmettre au binaire. |
| 1.2 | CONFIRMED | cli.ts:7 `args[oi + 1]` vaut `undefined` si `-o` est le dernier argument, donc la sortie part sur stdout. Avec `--foo bar`, `bar` devient l'entrée via `find` (L8). | Exiger une valeur après `-o`, rejeter les flags inconnus et sortir en code 2. |
| 1.3 | CONFIRMED | cli.ts:11 appelle `process.exit(2)`. | Remplacer par `process.exitCode = 2` suivi d'un `return` ou d'un bloc `else`. |
| 2.1 | CONFIRMED | system/py2bun-ts/src/index.ts:35 : la signature est `transpile(source, bin)` et le spawn L37 n'a pas de mode. | Ajouter un paramètre `mode` qui ajoute `--async` ou `--sync` aux arguments du spawn. |
| 2.2 | CONFIRMED | index.ts:37-46 : ni `p.exitCode` ni `p.signalCode` ne sont lus. Les lignes `py2bun: ...` sont ignorées (L40). | Si `exitCode` vaut 2 ou si un signal est présent, lever une erreur contenant le stderr brut. |
| 2.3 | REFUTED | system/py2bun/src/main.rs:45 : `eprintln!` émet `\n`, pas CRLF, et `JSON.parse` tolère de toute façon un `\r` final. | - |
| 3.1 | CONFIRMED | main.rs:14 `out = it.next()` donne `None` silencieusement si `-o` est le dernier argument. | Écrire `it.next()` ou afficher l'usage et retourner `ExitCode::from(2)`. |
| 3.2 | CONFIRMED | main.rs:23 `_ => input = Some(a)` : un flag inconnu ou un second fichier écrase l'entrée. | Retourner le code 2 si l'argument commence par `-` (sauf `-`) ou si `input` est déjà défini. |
| 3.3 | CONFIRMED | main.rs:46 `"message":{:?}` : le `Debug` de Rust émet `\u{1b}`, qui n'est pas du JSON valide, et `catch {}` (index.ts:43) avale l'erreur. | Utiliser un échappement JSON réel (`serde_json::to_string` ou un échappeur `\uXXXX` manuel). |
| 3.4 | CONFIRMED | main.rs:4 : `USAGE` indique `py2bun` alors que le binaire s'appelle `py2bun-rs` (Cargo.toml:17), et ne mentionne pas `--output`. | Écrire `usage: py2bun-rs ... [-o|--output OUT]`. |
| 3.5 | PARTIAL | main.rs:56 `syntax_fail = res.ts.is_empty()` : c'est un couplage implicite, pas un bug observé. | Ajouter `syntax_error: bool` dans `Output`. |
| 3.6 | CONFIRMED | main.rs:66 `let _ = ...write_all(...)` : l'erreur d'écriture est ignorée et le code de sortie est 0. | Sur une erreur autre que `BrokenPipe`, écrire sur stderr et retourner le code 2. |
| 4.1 | CONFIRMED | system/py2bun-ts/python/py2bun/cli.py:10-13 : pas de `--async`, `--sync` ni `--json`, et L16 appelle `transpile_with_diagnostics(src)` sans mode. | Ajouter `--async` et `--sync` (transmis comme `mode`) ainsi que `--json`. |
| 4.2 | CONFIRMED | cli.py:15 `open(...).read()` sans `with` et sans `try`. Un `OSError` ou un `UnicodeDecodeError` produit une traceback et le code 1. Même problème pour L21. | Utiliser `with open` et `try/except (OSError, UnicodeDecodeError)`, puis afficher un message et retourner 2. |
| 5.1 | PARTIAL | system/py2bun/src/pymod.rs:1 omet `mode`. En revanche, l'affirmation sur L15 est fausse : emit.rs:385 émet bien `// py2bun {d}`. | Corriger seulement L1 : `transpile(source, mode="auto") -> str`. |
| 5.2 | CONFIRMED | pymod.rs:22-23 : seul `diagnostics.first()` est gardé et l'exception levée est `PyValueError`. | Joindre tous les diagnostics et lever `PySyntaxError`. |
| 6.1 | CONFIRMED | system/py2bun/src/py2.rs:177-201 traite le code ligne par ligne sans état de chaîne triple, donc un `print foo` dans une docstring est réécrit. | Suivre l'état `"""`/`'''` dans `fix` et sauter les lignes situées dans une chaîne. |
| 6.2 | REFUTED | py2.rs:5-23 : `'''#'''` bascule six fois, ce qui laisse l'état final hors chaîne, et le vrai `#` est trouvé. | - |
| 7.1 | PARTIAL | py2.rs:51 : `"else"` correspond bien à `elsewhere`, mais rien n'est modifié tant que `": print"` est absent (L60). | Exiger `else:`, `try:`, `finally:` et `except` suivi d'un espace ou de `:`. |
| 7.2 | PARTIAL | py2.rs:60 `code.find(": print")` ignore les guillemets. L'exemple `{"a: print": 1}` n'est pas modifié, car la queue `print"` est rejetée (L71), mais `{"a: print x": 1}` est corrompu. `if x:  print y` (deux espaces) n'est pas reconnu. | Chercher le `:` au niveau supérieur hors chaînes, puis `trim_start` et `print`. |
| 8.1 | PARTIAL | py2.rs:75 rejette `(` et `[`. Pour `print (a), b`, la ligne reste un tuple valide en Py3 et la sortie change silencieusement. `print [1, 2]` n'est pas une SyntaxError en Py3 (indexation), mais la ligne n'est pas réécrite. | Accepter `(` et `[` quand la ligne contient une virgule de niveau supérieur ou quand le crochet ne colle pas à `print`. |
| 8.2 | REFUTED | py2.rs:95 : le commentaire est retiré (L79-80), donc une virgule finale hors chaîne est forcément au niveau supérieur, et `print (1,)` est déjà rejeté en L75. | - |
| 9.1 | CONFIRMED | py2.rs:112 : `if inner.starts_with('(') ... return None` refuse `except (A, B), e:`. | Accepter `(` en utilisant `first_comma`, qui ignore la profondeur des parenthèses. |
| 9.2 | CONFIRMED | py2.rs:116 : `except A, B, C:` produit `except A as B, C:`. | Vérifier que `name` est un identifiant, sinon retourner `None`. |
| 10.1 | CONFIRMED | py2.rs:139 : la liste d'exclusion contient `'('`, `'['` et `'>'`. | Gérer `>>f,` comme en L82-92 et lever les exclusions de `(` et `[` comme en 8.1. |
| 10.2 | CONFIRMED | py2.rs:154 puis L169 : `parts.push(t)` garde le `# comment` et `format!("{tail}{extra})")` place `)` après le commentaire. | Couper avec `comment_start(t)` et ajouter `)` avant le commentaire. |
| 10.3 | CONFIRMED | py2.rs:185 `changed.push(i + 1)` : une seule ligne est enregistrée. | Ajouter `i+1..=j+1`. |
| 11 | PARTIAL | system/py2bun/src/names.rs:29-35 : `keys`, `values` et `popitem` sont absents. `keys` et `values` fonctionnent nativement sur `Map`, mais `popitem` n'existe pas sur `Map` (emit.rs:1822). | Ajouter `popitem`, `rpartition`, `removeprefix`, `removesuffix` et `swapcase` à `METHODS` et au runtime `m`. |
| 12 | PARTIAL | names.rs:13-15 : `iter`, `next`, `repr`, `int` et `bool` sont absents de `ASYNC_BUILTINS`. Que des proxys Java les reçoivent n'est pas démontré dans ce code. | Ajouter des variantes `a_iter`, `a_next` et `a_repr` si le runtime proxy est asynchrone. |
| 13 | CONFIRMED | names.rs:47 contient `"jarray"`. emit.rs:470 abandonne l'import sans diagnostic. | Retirer `jarray` de `IGNORED_MODULES` et le mapper vers le runtime ou une erreur. |
| 14 | PARTIAL | names.rs:50-58 et 103-111 contiennent des lignes vides doublées, mais en Rust les `///` restent attachés à l'item : c'est cosmétique. | Supprimer les lignes vides. |
| 15.1 | PARTIAL | Le Cargo.toml racine (L12 `members`, L230 `exclude`) ne mentionne pas `system/py2bun`. system/py2bun/Cargo.toml:1-3 déclare son propre `[workspace]`, donc il n'y a pas de conflit Cargo, seulement un `target/` séparé. | Ajouter `system/py2bun` aux `members` racine et supprimer son `[workspace]`. |
| 15.2 | CONFIRMED | system/py2bun/Cargo.toml:14 `crate-type = ["rlib", "cdylib"]` : la `cdylib` est compilée même sans la feature `python`. | Garder seulement `rlib` et passer `--crate-type cdylib` dans la configuration maturin. |
| 16.1 | CONFIRMED | system/py2bun-ts/package.json:1-16 : aucune `devDependencies` ni `peerDependencies`. | Ajouter `"devDependencies": {"@types/bun": "latest"}` et `"peerDependencies": {"@aphrody/ghidra": "workspace:*"}`. |
| 16.2 | CONFIRMED | package.json:10 `"./runtime/*"` expose aussi `async.ts` et `format.ts`, qui sont dans system/py2bun-ts/src/runtime mais pas dans `STDLIB`. | Lister explicitement les modules de `STDLIB` dans `exports`. |

## 5b. Same bundle, second call: Gemini 9/20 (15 defects; verified by the reviewer)

| # | Gemini claim | Verdict | Evidence | Fix |
|---|---|---|---|---|
| 1 | Standalone workspace, thin LTO, abi3-py39, duplicate ruff, separate binary | Partial | `system/py2bun/Cargo.toml:1-3,25-28,31` (thin LTO) versus root `Cargo.toml:959-961` (fat, abort); `system/core/py/Cargo.toml:21` `abi3-py310` versus `py2bun/Cargo.toml:28` `abi3-py39`; `py2bun-rs` bin at `:17`. Isolation is deliberate (README:5). | Promote to the root workspace; align abi3. |
| 2 | Hand-written CLI parsing | Confirmed | `main.rs:14` (-o without value), `:23` (unknown flag becomes input), `:4` usage names `py2bun`, `:66` write error ignored. | Reject `-`-prefixed unknown args with 2; check `-o` value and write result. |
| 3 | `{:?}` produces invalid JSON | Partial | `main.rs:46-50`: Rust Debug writes control characters as `\u{1b}` (invalid JSON); `index.ts:41-43` swallows the failure. The surrogate and `/` points are wrong (raw UTF-8 is valid JSON). | `serde_json::to_string`. |
| 4 | `from_utf8_lossy` hides bad encodings | Confirmed | `main.rs:35` versus stdin path `:29` which errors. | `String::from_utf8`, exit 2. |
| 5 | Triple quotes break the Python 2 rewriter | Partial | Multi-line docstrings are rewritten because `fix` is line-based (`py2.rs:177-201`, confirmed). The same-line example `print """a # b""", 1` is handled by the odd/even quote toggling (`py2.rs:17-19`). | Track triple-quote state across lines. |
| 6 | `: print` detection | Confirmed | `py2.rs:60` `code.find(": print")` matches inside a string (`{"a": "x: print y"}: pass` is rewritten to `print(y"}: pass)`); two spaces, tab or none are not matched. | Find the header colon at depth 0 outside strings. |
| 7 | `(` and `[` rejected after `print` | Partial | `py2.rs:75,139`. Those lines are valid Python 3 expressions (`print (a), b` is a tuple), so they are not syntax errors: output silently differs from Python 2 rather than failing. | Decide by parse, not by first character. |
| 8 | Trailing comma and continuation comment | Confirmed | `py2.rs:82-93,95`: `print >>f,` loses `end=" "`; `py2.rs:154,169`: `)` lands after a trailing `# comment`; `:139` refuses `>>`; `:185` records one line. | Split code and comment on the last line. |
| 9 | `except (A, B), e:` and PEP 758 conflict | Confirmed | `py2.rs:112`; `py2_fallback.rs:16` admits ruff parses `except A, B:` as a Python 3 tuple, so without another Python 2 error `e` is never bound. | Detect in the AST (tuple type, no name) and rewrite or diagnose. |
| 10 | `cli.py` gaps | Confirmed | `cli.py:10-14` no `--json/--async/--sync`; `:15` `open` without `with` or error handling; `:18` prints `-` for stdin. | Add options, `with`, `<stdin>` label. |
| 11 | `cli.ts` gaps | Confirmed | `cli.ts:5-8`, `:10` `process.exit(2)`; plus the reviewer-found `:8` first-argument bug (see summary item 11). | Parse the same flags; fix the index test. |
| 12 | `index.ts` wrapper | Confirmed | `index.ts:28-30` only the crate target dir (no `CARGO_TARGET_DIR`, no root `target/`); `:35` no `mode`; `:37-46` exit code and signal ignored; `:50-51` `async` wrapper over `spawnSync`. | Add `mode`, report crashes, `Bun.spawn`. |
| 13 | Missing ghidra dependency and `./java` exports; Python version | Partial | `packages/ghidra/package.json:7-14` has no `./java`, so every emitted Java import is unresolvable (documented at `py2bun/README.md:41,60`); `package.json` of py2bun declares no dependency. `pyproject.toml` `>=3.9` matches its own `abi3-py39`. | Export `./java` and `./java/*`, or change the emitter. |
| 14 | Test asserts 3 rewrites for 4 statements, hiding a bare-`print` bug | Confirmed | `py2_fallback.rs:5,11`; `py2.rs:70-72`: `rest` empty fails `starts_with([' ','\t'])` and returns `None`, so `print` stays a no-op expression. | Rewrite bare `print` to `print()` and assert 4. |
| 15 | `FLAT_AMBIGUOUS` misaligned with `GHIDRA_FLAT` | Confirmed | `names.rs:104` lists four dead names; `run` (`:94`) and `find` (`:69`) are in `GHIDRA_FLAT` and not ambiguous; `emit.rs:239` sets `ghidra_hit` for any flat name, which forces async mode (`emit.rs:418`). | Move `run`, `find` to the ambiguous list; drop dead names. |

## 6a. system/py2bun-ts/src/runtime/index.ts: Gemini 6/20, defects 1-22

| # | verdict | evidence (file:line) | fix |
|---|---|---|---|
| 1 | CONFIRMED | index.ts:13 `str(args)` with an array gives `"[1, 2]"` (index.ts:628 builds `"[" ... "]"`) | `super(args.length === 1 ? str(args[0]) : args.length ? "(" + args.map(repr).join(", ") + ")" : "")` |
| 2 | CONFIRMED | No `GeneratorExit` in the file; index.ts:57 excludes only `SystemExit` and `KeyboardInterrupt` | `export class GeneratorExit extends BaseException {}` and add `e instanceof GeneratorExit` to the line 57 exclusion |
| 3 | CONFIRMED | index.ts:92,96 `Number(v)`: a float is accepted, a bad string gives NaN | `sliceIdx(v)`: accept int, bool or `__index__`, else throw `TypeError` |
| 4 | REFUTED | index.ts:104: `slice(1, undefined)` gives `PySlice(1, undefined, undefined)`, but `indices` uses `== null` (index.ts:92,95), so behavior is the same | (cosmetic) `new PySlice(a, b ?? null, c ?? null)` |
| 5.1 | PARTIAL | index.ts:110 float `Math.ceil`: imprecise only beyond 2^53, which `as number` already rules out | compute in BigInt when the bounds are big |
| 5.2 | CONFIRMED | index.ts:117-119 `at()` has no bounds check; getitem goes through `seqIndex` (index.ts:314), but a direct `at(99)` returns 99 | in `at()`, throw `IndexError` when `i` is outside `[0, length)` |
| 6 | CONFIRMED | index.ts:122-125 `int(a) as number`, and `int` returns a bigint above MAX_SAFE (index.ts:551, `norm`); `i += step` then mixes BigInt and number | reject a bigint with `OverflowError` or make `PyRange` bigint-aware |
| 7 | PARTIAL | index.ts:141 `(x as any).length > 0`: a non-empty `DataView` gives `false`; `Uint8Array(0)` is correct | `x instanceof DataView ? x.byteLength > 0 : x.length > 0` |
| 8 | CONFIRMED | index.ts:176 `BigInt(x)` throws `SyntaxError` or `RangeError` | in `bi`, throw a py `TypeError` when the input is not int or bool |
| 9 | CONFIRMED | index.ts:187 skips the throw when one side is an object, so index.ts:189 `a + b` turns `[] + "a"` into `"a"` | try `b.__radd__`, then throw `TypeError` instead of `return a + b` |
| 10 | PARTIAL | index.ts:193 `a.push(...iter(b))`: the spread is evaluated before the push, so `a += a` does not loop; `__iadd__` and bytearray are missing | add `a.__iadd__` handling; leave the spread as is |
| 11 | CONFIRMED | index.ts:200 `"a".repeat(2.5)` truncates; a boolean `b` falls through to index.ts:205, so `"a" * true` is NaN | map bool to 0/1, require `isInt`, add `__mul__`/`__rmul__`, and throw `TypeError` at the end |
| 12 | CONFIRMED | index.ts:209 `bi(2.5)` throws `RangeError`; index.ts:226: `((-1 % Inf) + Inf) % Inf` gives NaN | use the Number path when an operand is not an int; handle `b = ±Infinity` before the formula |
| 13 | CONFIRMED | index.ts:230 `bi(a) % bi(m)`: m=0 throws `RangeError`, `pow(-2,3,5)` returns -3, and with `e<0` the loop is skipped so it returns 1 | throw `ValueError` when `mm === 0n`; `base = ((bi(a) % mm) + mm) % mm`; modular inverse when `e < 0n` |
| 14.1 | CONFIRMED | index.ts:244 `1.5 & 2` truncates; index.ts:252 `inv(1.5) = -2.5`, `inv("x") = NaN` | require int or bool, else throw `TypeError` |
| 14.2 | PARTIAL | index.ts:250 `1n << -1n` returns `0n` with no error (the reviewer's RangeError claim is wrong), but `ValueError` is still missing | throw `ValueError("negative shift count")` when `bi(b) < 0n` |
| 15 | CONFIRMED | index.ts:259 `Number(2**53+1n) === 2**53` returns true; Uint8Array is not handled (index.ts:265 returns `false`); Map/Set use `has()` (SameValueZero, index.ts:261-262) | compare bigint vs number as `Number.isInteger(n) && BigInt(n) === b`; add byte equality; look Map/Set keys up with `eq` |
| 16 | CONFIRMED | index.ts:274 `typeof x === "number" && [...c].includes(x)`: O(n) and `True` is rejected | O(1) arithmetic test (bounds plus `(x - start) % step === 0`), with bool mapped to 0/1 |
| 17 | CONFIRMED | index.ts:288 `Number(k)`: `""`, `null` and `[]` all give 0 | accept only an integer number, a bigint, a bool or `__index__` |
| 18 | CONFIRMED | index.ts:308 and index.ts:412 spread `[...o]` up to 3 times per access | spread once (`const cp = [...o]`) or cache a code-point index |
| 19.1 | CONFIRMED | index.ts:321-324 also covers `ArrayBuffer.isView`, but TypedArrays have no `splice` | separate branch for typed arrays (fixed length) |
| 19.2 | CONFIRMED | index.ts:323 and index.ts:340 drop `st`; with `st < 0`, `Math.max(0, e - s)` gives 0, so values are inserted | when `st !== 1`: index-by-index assignment with a length check, and deletion in descending index order |
| 20 | CONFIRMED | index.ts:401 `!it.next` on null throws a native JS TypeError; a list has no `.next`, so it gets wrapped by `iter` and accepted | `if (it == null \|\| typeof it.next !== "function") throw new TypeError(...)` (py class) |
| 21 | CONFIRMED | index.ts:445 `cmp(NaN, 1)` and `cmp(1, "a")` both return 0 | check type compatibility and throw `TypeError` when the values cannot be ordered |
| 22 | CONFIRMED | index.ts:465 and index.ts:468: two full sorts when `reverse` is set; the result is correct, only the cost doubles | one sort with a comparator chosen by `truth(reverse)` |

### defects 23-44

| # | verdict | evidence (file:line) | fix |
|---|---|---|---|
| 23 | CONFIRMED | index.ts:493-495 `sum(it, start = 0)`: a `Kw` becomes `start`; there is no str check | `const [pos,k]=splitKw(args)`; `start=pos[1]??k.start??0`; throw `TypeError` if `typeof start==="string"` |
| 24.1 | CONFIRMED | index.ts:515-520 `10 ** 400` is Infinity, so `Inf/Inf` is NaN; `x * p` gives binary rounding error | if `n>308` return x; if `n<-308` return 0; round through `Number(x+"e"+n)` |
| 24.2 | CONFIRMED | index.ts:509/516 `Math.floor(5n)` and `5n*100` throw TypeError | branch `isBig(x)`: return x if `n>=0`, else do the rounding in bigint |
| 25.1 | CONFIRMED | index.ts:547-551 the number/bigint branches ignore `base` | `if (base!==undefined && typeof x!=="string") throw TypeError("int() can't convert non-string with explicit base")` |
| 25.2 | CONFIRMED | index.ts:554,563 there is no range check: `slice(0,99)` gives 36 digits, so `int("1",99)` is 1 | check `b===0 \|\| 2<=b<=36`, else throw ValueError |
| 25.3 | CONFIRMED | index.ts:553 `.replace(/_/g,"")` strips every `_` | allow `_` only between two digits (or after the prefix) |
| 25.4 | CONFIRMED | index.ts:562 base 0 with no prefix becomes `b=10`, so "010" gives 10 | in base 0, throw ValueError if `/^0+[1-9]/` |
| 26 | CONFIRMED | index.ts:583 `return Number(x)` (null and [] give 0); 577 removes `_`; a large bigint gives Infinity | accept only number/bigint/bool/str/`__float__`, else TypeError; validate `_`; bigint over range raises OverflowError |
| 27 | REFUTED | index.ts:596 -0 only comes from a float operation; "-0.0" is Python's `str(-0.0)` | none |
| 28 | CONFIRMED | index.ts:632 spread `fromCharCode(...x)` (RangeError on large buffers, DataView is not iterable); 621 escapes only <0x20 and 0x7f | loop over the bytes and emit `\xHH` for `<0x20 \|\| >=0x7f` |
| 29 | CONFIRMED | index.ts:651 encodes without `encoding`; 652 `Uint8Array.from` wraps 256 to 0 | signature `(x, encoding?)`, TypeError when no encoding; ValueError if v is outside 0..255 |
| 30.1 | CONFIRMED | index.ts:662 `case int` does not match boolean | add `\|\| typeof x==="boolean"`; `issubclass(bool,int)` returns true |
| 30.2 | PARTIAL | index.ts:664 `typeof x==="number"`; JS cannot tell 1 from 1.0, but `type(1)` returns int (697) | `case float: return typeof x==="number" && !Number.isInteger(x)` (consistent with `type`) |
| 30.3 | CONFIRMED | index.ts:692 user classes do not inherit from `PyObject` | `if (b===object) return true;` |
| 31 | CONFIRMED | index.ts:729-732 `2**32\|0` is 0 but the bigint is hashed as a string; `true` is hashed as "True"; no unhashable check | bool/bigint return `Number(x)` (same as number); TypeError on Array/Map/Set |
| 32 | CONFIRMED | index.ts:741 `defineProperty(Function.prototype,"__name__")` at module load | resolve `__name__` in `getattr` instead of patching the global prototype |
| 33 | CONFIRMED | index.ts:784 `a.shift()` on [] returns undefined | `if(!init.length&&!a.length) throw TypeError("reduce() of empty iterable with no initial value")` |
| 34.1 | CONFIRMED | index.ts:799-800 the catch maps every error to FileNotFoundError; 796 `"w+"` reads before creating the file | map by `e.code` (ENOENT, EACCES, EISDIR); do not read for `w`/`w+` |
| 34.2 | CONFIRMED | index.ts:814-816 `Uint8Array.indexOf("\n")` always returns -1; no `closed` check in read/readline/write | in binary mode search for byte 10; add `if(this.closed) throw ValueError("I/O operation on closed file")` |
| 34.3 | CONFIRMED | index.ts:832 `appendFileSync` ignores `pos`/`r+` and does not update `buf` | write at `pos` (`fs.writeSync(fd, data, pos)`) and keep `buf` in sync |
| 34.4 | CONFIRMED | index.ts:860 `__exit__(null,null,null)` and `ctxExit(cm)` takes no exception | `ctxExit(cm, e?)` passes `(type(e), e, null)` and uses the return value to suppress |
| 35 | CONFIRMED | index.ts:907 `if (a.length===0) break` gives "Xabc"; 896 `split("").join` gives "aXbXc" | if `a===""`: insert b before each character and at the end, at most n times |
| 36.1 | CONFIRMED | index.ts:950-952 `rsplit("abc","",1)` gives `["ab","c"]` with no ValueError | `if(sep==="") throw ValueError("empty separator")` |
| 36.2 | CONFIRMED | index.ts:950-952 rebuilds with `join(" ")` and loses spacing and leading whitespace | scan from the right (`lastIndexOf`, or whitespace runs in reverse) |
| 37 | CONFIRMED | index.ts:965-972 `startswith` has no `end`; `endswith` has neither start nor end | `(o,p,s?,e?)` with `o.slice(s??0, e??o.length)` normalized like a Python slice |
| 38 | CONFIRMED | index.ts:1012-1014 an empty Set returns undefined | `if(!o.size) throw new KeyError("pop from an empty set")` |
| 39 | CONFIRMED | index.ts:1020 `native(...) ?? d` replaces a legitimate null (non-Map receiver only) | `const v = native(o,"get",[k]); return v===undefined ? (d??null) : v` |
| 40 | CONFIRMED | index.ts:1037 Set: a `Kw` goes to `iter`; 1032 Map: extra positional args are ignored | Set: `stripKw(a)`; Map: `if(pos.length>1) throw TypeError` |
| 41.1 | CONFIRMED | index.ts:1060 `findIndex` ignores start/stop | search the slice `[start,stop)` normalized, then add the offset |
| 41.2 | CONFIRMED | index.ts:1065,1072,1076 no `end`; negative start becomes 0 in JS; `rfind` has no bounds | normalize `[start,end]` like a slice, search the substring, add the offset |
| 42 | CONFIRMED | index.ts:1094 `/^\d+$/` is ASCII only; 1097 `\s` misses `\x1c-\x1f` and `\x85` | isdigit: `/^[\p{Nd}\p{No}]+$/u` (approx.); isspace: `/^[\s\x1c-\x1f\x85]+$/` |
| 43 | CONFIRMED | index.ts:1115 a `Kw` object is truthy so `keep` is true; only `\r\n\|\n\|\r` are handled | `splitKw` for `keepends`; separators `[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]` plus `\r\n` |
| 44 | CONFIRMED | index.ts:1118 `indexOf("")` is 0, so it returns `["","","abc"]`; `rpartition` is missing from `m` (1116-1121) | `if(sep==="") throw ValueError("empty separator")`; add `rpartition` using `lastIndexOf` |

## 6b. runtime async/format/json/math/os/random/re/struct/sys/time and tests: Gemini 11/20

Rows 1.x to 4.x: async.ts, format.ts, json.ts, math.ts. Rows 5.x to 11.x: os.ts, random.ts, re.ts, struct.ts, sys.ts, time.ts, tests.

| # | verdict | evidence (file:line) | fix |
|---|---|---|---|
| 1.1 | CONFIRMED | async.ts:31-32: both branches `return py.str(x)` | Delete line 31 |
| 1.2 | CONFIRMED | async.ts:43 calls sync `py.sorted`; index.ts:464 `key ? key(v)`, so an async key yields Promises and `cmp` (index.ts:456) returns 0, leaving the order unchanged | Resolve keys with `await Promise.all(arr.map(k.key))`, then sort on them |
| 1.3.1 | CONFIRMED | async.ts:47 `i === 0 && a.length === 1`: with a Kw, length is 2, so `it` is not materialized; index.ts:475 then runs `iter(pos[0])` on an AsyncGenerator | Split the Kw first; if `pos.length===1`, run `materialize(pos[0])` |
| 1.3.2 | CONFIRMED | index.ts:481-483 `k.key(best)` is not awaited | Await the keys in a_min/a_max before comparing |
| 1.4 | CONFIRMED | async.ts:65 drops the Kw, so `strict` is ignored | Read `strict` from the Kw; raise ValueError on unequal lengths |
| 1.5 | PARTIAL | async.ts:69 eager `materialize`; Python `map` takes no kwargs, so the Kw point is moot | Iterate lazily with `aiter` |
| 1.6.1 | PARTIAL | async.ts:78: the double `await` is harmless (idempotent); every JObject going through `$str()` does break `%x`/`%d` | Convert with `$str()` only for `%s` |
| 1.6.2 | PARTIAL | Promise<Array> refuted: `conv(args)` awaits and passes the array to `py.mod` (async.ts:80). Map refuted: its values are not converted | Handle `args instanceof Map` by resolving its values |
| 1.7 | CONFIRMED | async.ts:86 only checks `isJ(a)` | Add the symmetric `isJ(b) && b.equals` |
| 2.1 | PARTIAL | format.ts:10 `\d{3}` does not match hex letters, so `"_x"` on 0xdeadbeef gives `deadbeef`, not `de_adb_eef`; scientific notation is unaffected (only the integer part is grouped); `,` with x is accepted | Use a step of 4 for `_` with b/o/x/X; reject `,` with them |
| 2.2.1 | CONFIRMED | format.ts:27-32: 999999.9 `.6g` gives exp=5 and `toFixed(0)`, so "1000000"; 0.00009999999 gives "1e-04" (Python: "0.0001") | Derive the exponent from `x.toExponential(prec-1)` |
| 2.2.2 | CONFIRMED | format.ts:30,33 strip trailing zeros without checking `alt` | Skip the stripping when `alt` is set |
| 2.3 | PARTIAL | format.ts:40 accepts `,` with x/b/o; no `z`; "008d" parses correctly (zero=0, width=08) | Add `z?`; reject `,` with non-decimal types |
| 2.4 | CONFIRMED | format.ts:68 `Number(n)` gives Infinity, producing "inf" with no OverflowError; format.ts:72 is lowercase for F/E/G | Raise OverflowError on non-finite bigint; uppercase when `"EFG".includes(t)` |
| 2.5 | CONFIRMED | format.ts:66 `body = "0x"+…`, then :89 `sg + fill.repeat(padn) + body`, so `#06x` on 255 gives "000xff" | Keep `pfx` separate: `sg + pfx + fill.repeat(w-sg-pfx-body) + body` |
| 2.6 | CONFIRMED | format.ts:121: the regex leaves `%y` untouched with no error | Add a `%.` fallback branch that raises ValueError |
| 2.7.1 | CONFIRMED | format.ts:124 width="-5", so spec "-5d" means sign `-`, right-aligned | `n=toInt(list[ai++]); if(n<0){left=true;width=String(-n)}` |
| 2.7.2 | PARTIAL | format.ts:119 `list=[]` with named args, so "undefined" goes into spec and `format` raises ValueError (not TypeError) | Raise `TypeError("* wants int")` |
| 2.8 | CONFIRMED | format.ts:148-149 `case "a": s = repr(v)` | Escape code points >0x7e in the output of `repr` |
| 2.9 | CONFIRMED | format.ts:153 `String(v)`: a bigint gives "65" and "ab" is accepted | Accept a 1-char string or an int in 0..0x10ffff, otherwise TypeError/OverflowError |
| 2.10.1 | CONFIRMED | format.ts:165 `toString(16)`, never uppercased for X | `if(conv==="X") digits=digits.toUpperCase()` |
| 2.10.2 | CONFIRMED | format.ts:167 only handles `+`; space and `#` are ignored | Add the ` ` sign and the 0x/0X/0o prefix |
| 2.10.3 | PARTIAL | format.ts:160 `toInt` only for d/i/u; a float with `%.3x` gives `Math.abs(1.5).toString(16)` = "1.8"; bigint is handled by `typeof v === "bigint"` (no crash) | Apply `toInt` (with a TypeError on float) for o/x/X |
| 2.11 | CONFIRMED | format.ts:171 `Number(v)`, so `"%x" % "123"` gives "7b" | Raise TypeError when v is a string on numeric conversions |
| 2.12.1 | CONFIRMED | format.ts:190-191 mix auto/manual with no check | Track the mode; raise ValueError on a mix |
| 2.12.2 | PARTIAL | format.ts:199: "-1" becomes a string key, giving undefined; Python raises TypeError (it does not return "2") | Raise TypeError/KeyError when the key is missing |
| 2.12.3 | CONFIRMED | format.ts:222 `!a` maps to `repr` | Use `ascii()` |
| 2.12.4 | CONFIRMED | format.ts:214-219 the loop runs off the end with no error; :227-229 a lone `}` is emitted | Raise ValueError on unmatched `{` and `}` |
| 3.1 | CONFIRMED | json.ts:8 `return Number(x)` | Serialize bigint exactly (custom replacer / raw insertion) |
| 3.2 | CONFIRMED | json.ts:20 runs the regex over the whole string: `dumps("a,b:1")` gives `"a,b: 1"` (the `,` before `b` is spared, the reviewer's example is inexact) | Replace only outside string literals |
| 3.3 | CONFIRMED | json.ts:25 `JSON.parse` returns number | Use a reviver that turns large integers into BigInt from the source |
| 3.4 | CONFIRMED | json.ts:19: `JSON.stringify(Infinity/NaN)` gives "null" | Emit Infinity/-Infinity/NaN; honour `allow_nan` |
| 4.1 | CONFIRMED | math.ts:17-30 delegate to Math.* (log(0) = -Infinity, asin(2) = NaN), unlike sqrt :9 | Check the domain; raise ValueError("math domain error") |
| 4.2 | CONFIRMED | math.ts:12-14 `Math.floor(x)` raises a TypeError on a bigint | `typeof x==="bigint" ? x : Math.floor(x)` |
| 4.3.1 | CONFIRMED | math.ts:40 `Math.abs(int(x))`; index.ts:551 `int` returns `norm(bigint)` for large values | Compute in BigInt, then normalize |
| 4.3.2 | CONFIRMED | index.ts:549 `Math.trunc`, so gcd(1.5,3) = 1 | Raise TypeError when the arg is not an integer |
| 4.3.3 | CONFIRMED | math.ts:43 `g = g` | Delete it |
| 4.4 | PARTIAL | math.ts:49: factorial(-3) does return 1 (confirmed); factorial(1.5) raises RangeError from `BigInt(1.5)`, not a silent result | Raise ValueError when n<0 and TypeError when n is not an integer |
| 4.5 | CONFIRMED | math.ts:53 `a % b` gives NaN | Raise ValueError when b===0 or a is infinite |
| 4.6.1 | CONFIRMED | math.ts:54: on a bigint `Math.sqrt` raises TypeError; 4503599761588224 = 67108865²−1 rounds to 67108865 | Use Newton in BigInt with an r*r≤n correction |
| 4.6.2 | CONFIRMED | math.ts:54 `Math.sqrt(-1)` gives NaN, no error | Raise ValueError("isqrt() argument must be nonnegative") when n<0 |

| 5.1 | CONFIRMED | os.ts:7 `linesep = "\n"` | `linesep = process.platform === "win32" ? "\r\n" : "\n"` |
| 5.2 | CONFIRMED | os.ts:15-16 bare `catch {}` always throws FileNotFoundError | map `err.code` ENOENT→FileNotFoundError, EACCES/EPERM→PermissionError, else OSError |
| 5.3 | CONFIRMED | os.ts:19 `..._a` ignored, always `recursive: true` | read `exist_ok` kw; if false and the dir exists, throw FileExistsError |
| 5.4 | CONFIRMED | os.ts:20,21,23,40 raw `fs.*Sync`; index.ts:54-63 `catches` uses `e instanceof t`, so Node errors never match OSError | wrap `fs` calls in an errno→OSError-subclass translator |
| 5.5.1 | CONFIRMED | os.ts:26 `p.join(acc, x)` normalizes (`join("a","../b")` gives `"b"`) | concatenate with `sep` without normalizing |
| 5.5.2 | CONFIRMED | os.ts:26 `p.join("a","")` gives `"a"`; Python gives `"a/"` | append `sep` when the last segment is `""` |
| 5.6 | CONFIRMED (win32 only) | os.ts:28 checks only `/`; `win32.dirname(".\\foo")` is `"."`, so it returns `""` | test `!/[\\/]/.test(x)` |
| 5.7 | PARTIAL | os.ts:35 `extname("...")` is `"."` (bug confirmed); the `"..ext"` example is wrong: Node returns `".ext"`, Python returns `("..ext","")`, so it is a second bug | strip leading dots from the basename before looking for the last `.` |
| 5.8 | CONFIRMED | os.ts:38 `p.dirname("foo")` is `"."`; `"a/b/"` gives `["a","b"]` | split at the last separator without stripping the trailing slash |
| 5.9 | CONFIRMED | os.ts:39 `/^~/` also matches `~user` | `/^~(?=$\|[\\/])/` |
| 6.1 | CONFIRMED | random.ts:6 no `step`, no ValueError | add `step`, compute `n`, throw ValueError if `n <= 0` |
| 6.2 | CONFIRMED | random.ts:5 no `a > b` check | `if (a > b) throw new ValueError("empty range for randrange()")` |
| 7.1.1 | CONFIRMED | re.ts:3 `\Z`→`$`, `\A`→`^`, then flag `m` at re.ts:4 | `\A`→`(?<![\s\S])`, `\Z`→`(?![\s\S])` |
| 7.1.2 | CONFIRMED | re.ts:3 `/\\Z/g` has no escape awareness, so `\\A` becomes `\^` | tokenize escapes (`\\.`) before substituting |
| 7.1.3 | CONFIRMED | re.ts:2 exports `X = 64`; re.ts:4 never tests `f & 64` | when `f & 64`, strip unescaped whitespace and `#` comments outside `[...]` |
| 7.2 | CONFIRMED | re.ts:17-25 `start()`/`end()`/`span()` take no argument | add the `d` flag and read `m.indices[g]` / `indices.groups[name]` |
| 7.3 | PARTIAL | re.ts:3 `conv` does not translate `(?i)`; it is invalid in JS whether or not it is wrapped in `^(?:`, so the wrapping is not the cause | extract leading inline flags `(?aiLmsux)` into `flags` |
| 7.4 | CONFIRMED | re.ts:42 `m.slice(1)` / `m[1]` can be `undefined` | `m.slice(1).map(x => x ?? "")`, `m[1] ?? ""` |
| 7.5.1 | CONFIRMED | re.ts:53 `groups: undefined`, so re.ts:8 `group("name")` returns null | `groups: typeof a.at(-1) === "object" ? a.at(-1) : undefined` |
| 7.5.2 | CONFIRMED | re.ts:54 only `\N`; `\g<..>` and an escaped `\\1` are not handled | parse the replacement template (`\\`, `\g<name>`, `\g<n>`, `\n`) |
| 7.6.1 | CONFIRMED | re.ts:57 no `maxsplit`; re.ts:68 `(p, s, f = 0)` | `split(p, s, maxsplit = 0, f = 0)` and a manual `matchAll` loop with the remainder in the last element |
| 7.6.2 | CONFIRMED | re.ts:58 `s.split(re)` returns `undefined` for non-participating groups | `.map(x => x ?? null)` |
| 8.1.1 | CONFIRMED | struct.ts:3 SIZES has no `p`, `P`, `n`, `N` | add `P`/`n`/`N` (8 bytes) and `p` |
| 8.1.2 | CONFIRMED | struct.ts:22 plain sum, `calcsize("BI")` = 5; `l` = 4 | in `@` mode or with no prefix, align to the field size, `l`/`L` = 8 on LP64 |
| 8.1.3 | CONFIRMED | struct.ts:12-15 a `g` regex with `exec` skips `$` and `%` silently | anchored loop that allows only `\s` between tokens, otherwise ValueError |
| 8.2.1 | CONFIRMED | struct.ts:41 `vals[vi++]` with no count check | compare the expected count to `vals.length` and throw `error` |
| 8.2.2 | CONFIRMED | struct.ts:31-32 `b[k]` on a string gives `"a"`, written as 0 | require `Uint8Array`, or encode strings with TextEncoder |
| 8.2.3 | CONFIRMED | struct.ts:44 and :78 treat `c` like `B` (number) | pack `v[0]`, unpack `buf.slice(o, o + 1)` |
| 8.2.4 | CONFIRMED | struct.ts:61 no `byteLength` check | `if (buf.byteLength !== calcsize(fmt)) throw new error(...)` |
| 8.3 | CONFIRMED | struct.ts: no `error` export | `export class error extends ValueError {}` and use it for every raise |
| 9.1 | PARTIAL | sys.ts:4 `byteorder` is missing (confirmed); `freebsd` vs `freebsdN` is minor | `export const byteorder = "little"` (or detect endianness) |
| 9.2 | CONFIRMED | sys.ts:10-11 returns the boolean from `process.stdout.write` | `(process.stdout.write(s), [...s].length)` |
| 9.3 | CONFIRMED | sys.ts:12 `read: () => ""` | read fd 0 lazily with `fs.readFileSync(0, "utf8")` and a cursor |
| 10.1 | CONFIRMED | time.ts:5 `Atomics.wait` clamps a negative timeout to 0, so no error | `if (s < 0) throw new ValueError("sleep length must be non-negative")` |
| 10.2 | CONFIRMED | time.ts:6 no `secs`, `Date.toString()` format | `(secs?) => format "Ddd Mmm dd HH:MM:SS yyyy"` from `new Date((secs ?? Date.now() / 1000) * 1000)` |
| 11.1 | CONFIRMED | runtime.test.ts:2-5 imports only `index`, `math`, `json`, `struct` | add tests for `os`, `re`, `random`, `sys`, `time`, `async`, `string` |
| 11.2 | REFUTED | emit.rs:366 always emits `"@aphrody/py2bun/runtime"` in double quotes (test_py2bun.py:9 asserts it) | none |
| 11.3.1 | CONFIRMED | wrapper.test.ts:20-22 checks stderr only | `expect(p.exitCode).toBe(0)` |
| 11.3.2 | REFUTED | wrapper.test.ts:69-70 compares `print` output, which emits `\n`; nothing in it uses `os.linesep` | none |

