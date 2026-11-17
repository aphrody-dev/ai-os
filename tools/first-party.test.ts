import { describe, expect, test } from "bun:test";
import { withFirstParty } from "./first-party.ts";

const present = () => true;

describe("withFirstParty", () => {
  test("merges and sorts", () => {
    expect(withFirstParty(["system/core", "frameworks/rag-core"], ["system/guard", "frameworks/toolcall"], present)).toEqual([
      "frameworks/rag-core",
      "frameworks/toolcall",
      "system/core",
      "system/guard",
    ]);
  });
  test("no first-party crate leaves the extracted members as they are", () => {
    expect(withFirstParty(["a", "b"], [], present)).toEqual(["a", "b"]);
  });
  test("a crate without a manifest is refused", () => {
    expect(() => withFirstParty([], ["system/guard"], () => false)).toThrow("without a Cargo.toml: system/guard");
  });
  test("a crate that the extraction also produces is refused", () => {
    expect(() => withFirstParty(["system/core"], ["system/core"], present)).toThrow("also produces: system/core");
  });
  test("a crate listed twice is refused", () => {
    expect(() => withFirstParty([], ["a", "a"], present)).toThrow("listed twice: a");
  });
});
