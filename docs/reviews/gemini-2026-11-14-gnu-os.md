# Gemini review: docs/native/gnu/OS.md (2026-11-14)

- Reviewer: Gemini, model Carbon High, on gemini.google.com via claude-in-chrome (chat c76f2e7a97a5af2e). The relay `gemini_review` call timed out.
- Input: the OS.md plan, plus the state of the gnu.aphrody.com distribution.
- Score: **10.5/20**.

| Axis | Score | Verdict |
| --- | --- | --- |
| ABI, kernel, libc coherence | 2/4 | sys.h vs system/posix vs distro glibc vs rustix linux_raw |
| Toolchain, GSRC DAG, bootstrap | 2/4 | LLVM vs commencement.scm and GNU C extensions; GSRC graph cyclic and not hermetic |
| Monorepo governance | 2.5/4 | rule 1 vs rule 2 collision, Cargo workspace inflation, no Bun boundary, 434 vs 569 not reconciled |
| Proof protocol and isolation | 2/4 | scalar 94 % falsifiable by SKIPs; testsuites run on the same host as the gnu service |
| GNU Coding Standards | 2/4 | Texinfo dropped; Rust blind spots: SIGPIPE, non-UTF-8 bytes, LC_COLLATE |

## Defects and the corrections we accept

- **D1.** Two explicit targets:
  - `x86_64-unknown-linux-gnu` proves behaviour.
  - A later `x86_64-aphrody-sys` target forces rustix `use_libc` over system/posix -> sys.h.
  - Never mix system/posix and glibc in one binary.
- **D2.** Production builds use clang with a legacy C flag profile. A GCC fallback is allowed only for packages that clang refuses (nested functions); the list is measured. commencement.scm is a reference only, not a goal.
- **D3.** One canonical registry reconciling GSRC (434), the feed (569) and gnu.org:
  - `status_gnu` = active | decommissioned | non-gnu-gsrc.
  - Tiers 0-3: only tiers 0 and 1 are rewritten; tiers 2 and 3 stay upstream.
  - lzip goes into the fr1 base tooling.
- **D4.** A frozen stage0-host sysroot on fr1 (make, perl, m4, texinfo, pkg-config, lzip) breaks the GSRC cycles (gettext/libiconv, bison/m4, autoconf/automake/perl).
- **D5.** Package layout and workspace:
  - For a fork, `system/gnu/<id>` holds only package.toml, the adapter, any patches and PROOF.md, with no source copy.
  - system/gnu gets a dedicated Cargo workspace, plus a shared `system/gnu/rt` crate.
  - Bun stays out of the OS build (DEPS.rules).
  - bc must ship bc and dc with decimal arithmetic. m4 must support frozen state (-F/-R).
- **D6.** PROOF.md gets a quadruplet instead of a single rate:
  - pass_rate = PASS / (TOTAL - XFAIL);
  - max_skip_delta <= +1 % against the GNU C baseline run in the same sandbox;
  - error_count = 0;
  - critical_smoke = 100 % on real configure scripts.
  - Thresholds depend on criticality: 100 % for m4, ed and sed.
- **D7.** Every gnu-check runs in a systemd-nspawn or rootless podman sandbox with `--network=none`, MemoryMax, TasksMax and a bounded tmpfs, pre-generated locales and no R2 credentials. The aphrody-gnu service stays isolated from tests.
- **D8.** Texinfo is kept, and `.md` files supplement it rather than replace it. The `system/gnu/rt` crate restores SIGPIPE to SIG_DFL, standardizes `--help`/`--version` and does byte-oriented I/O (bstr).
- **D9.** packages.toml gains `license` and `provenance` fields (clean-room | derived-gnu | third-party-fork | upstream-tarball), recorded for traceability. The owner rule is that licences never drive architecture (memory `licenses-go-to-human`).

## Reservation

Gemini wrote that fr2 "hosts prod". In fact fr2 has been the unrestricted test, benchmark and research VPS since 2026-11-14, and the gnu.aphrody.com tracker is a research service. D7 is still accepted, to protect the R2 secrets.
