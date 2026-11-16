// Sign-in of the relay's Google web session (Gemini): the relay's Chrome opens headful directly on Google sign-in, the
// session is watched through the page's login state, and the window closes by itself as soon as it is signed in.
// Nothing is typed: the owner does the sign-in in the window. Called by `<binary> auth login gemini-web`
// (system/env-kit/src/auth-services.ts) after the toast click.
import { quickScript } from "../review/gemini-web.ts";
import { writeSession } from "../../../../system/env-kit/src/auth-paths.ts";
import { closeBrowser, launchBrowser, listTabs, Tab } from "./cdp.ts";

const ORIGIN = "https://gemini.google.com";

/** Google sign-in page that returns to Gemini once signed in. */
export const signInUrl = (origin = ORIGIN) =>
  `https://accounts.google.com/ServiceLogin?hl=en&continue=${encodeURIComponent(`${origin}/app`)}`;

export type SignInResult = { ok: boolean; note: string; ms: number };

export async function signInGeminiWeb(
  o: {
    origin?: string;
    timeoutMs?: number;
    pollMs?: number;
    /** Where the window opens (tests point it at a fixture instead of Google). */
    url?: string;
    /** Tests only: no visible window. */
    headless?: boolean;
    log?: (s: string) => void;
  } = {},
): Promise<SignInResult> {
  const t0 = performance.now();
  const origin = o.origin ?? ORIGIN;
  const log = o.log ?? (() => {});
  // The headless relay Chrome holds the profile: restart it visible, on the sign-in page.
  await closeBrowser();
  await launchBrowser(!!o.headless, o.url ?? signInUrl(origin));
  log("window opened, waiting for sign-in");
  const end = Date.now() + (o.timeoutMs ?? 600_000);
  while (Date.now() < end) {
    await Bun.sleep(o.pollMs ?? 2000);
    const page = (await listTabs().catch(() => [])).find((t) =>
      t.url.startsWith(`${origin}/`),
    );
    if (!page) continue;
    const tab = await Tab.open(page.url, `${origin}/`).catch(() => null);
    if (!tab) continue;
    let state = "wait";
    try {
      state = await tab.eval<string>(quickScript());
    } catch {
    } finally {
      tab.close();
    }
    if (state === "ok") {
      // Let the session cookies settle, then close the window: Browser.close flushes the profile.
      await Bun.sleep(1500);
      await closeBrowser();
      writeSession("gemini-web", true, "signed in");
      log("signed in, window closed");
      return {
        ok: true,
        note: "signed in",
        ms: Math.round(performance.now() - t0),
      };
    }
  }
  await closeBrowser();
  writeSession("gemini-web", false, "sign-in not completed");
  return {
    ok: false,
    note: "sign-in not completed before the timeout",
    ms: Math.round(performance.now() - t0),
  };
}
