import { expect, test } from "bun:test";
import { sendMessage } from "../src/gmail";
import { GOOGLE_SCOPES } from "../src/google-auth";

test("gmail send refuses without explicit confirmation", async () => {
  await expect(
    sendMessage(
      { clientId: "x", clientSecret: "y", refreshToken: "z" },
      { to: "a@b.c", subject: "s", body: "b" },
      false,
    ),
  ).rejects.toThrow("explicit confirmation required");
});

test("gmail scopes request only readonly + send", () => {
  expect(GOOGLE_SCOPES.gmail).toEqual([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
});
