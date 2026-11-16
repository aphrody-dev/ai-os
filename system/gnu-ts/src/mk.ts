// Shared `KEY = value` reader for Makefiles, Starlark constants (.scl), build.config files and kernel defconfigs.
/** First assignment of every upper-case variable (`=`, `:=`, `?=`), backslash continuations joined, value trimmed. */
export function vars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text
    .replace(/\\\n/g, " ")
    .matchAll(/^([A-Z][A-Z0-9_]*)[ \t]*[?:]?=[ \t]*(.*)$/gm))
    out[m[1]!] ??= m[2]!.trim();
  return out;
}

/** Value without its surrounding double quotes (`"r596125"` -> `r596125`). */
export const unquote = (v: string | undefined): string | null =>
  v === undefined ? null : (/^"?([^"]*)"?/.exec(v)?.[1] ?? "");
