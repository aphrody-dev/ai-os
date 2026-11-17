// Crates written in this repository (extract.toml [first-party]): workspace members that the extraction neither produces nor removes.
// Their manifests inherit from the root workspace, so the root Cargo.toml lists them next to the extracted members.

/** The workspace members: the extracted ones plus the first-party crates, sorted. A first-party crate must exist and must not be an extracted unit. */
export function withFirstParty(extracted: string[], firstParty: string[], exists: (dir: string) => boolean): string[] {
  const missing = firstParty.filter((c) => !exists(c));
  if (missing.length) throw new Error(`first-party crates without a Cargo.toml: ${missing.join(", ")}`);
  const clash = firstParty.filter((c) => extracted.includes(c));
  if (clash.length) throw new Error(`first-party crates that the extraction also produces: ${clash.join(", ")}`);
  const dup = firstParty.filter((c, i) => firstParty.indexOf(c) !== i);
  if (dup.length) throw new Error(`first-party crates listed twice: ${dup.join(", ")}`);
  return [...extracted, ...firstParty].sort();
}
