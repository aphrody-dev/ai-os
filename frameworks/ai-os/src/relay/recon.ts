// relay recon: end-to-end survey of gemini.google.com (front end, network, internal APIs, CSS, DOM) in the relay's Chrome
// (CDP), indexed in <RELAY_HOME>/recon.sqlite (FTS5) and summarized as JSON. No secret: URLs are reduced to
// origin + path + parameter names (values kept only for rpcids, bl, hl); no cookies, headers or bodies.
// Used to detect interface changes (selectors, RPC) before they break gemini_ask in web mode.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Tab, launchBrowser, relayHome } from "./cdp.ts";

/** Expression evaluated in the page: returns the serializable survey. */
export const RECON_EXPR = `(async () => {
  const keep = new Set(['rpcids', 'bl', 'hl', 'source-path']);
  const clean = (u) => { try { const x = new URL(u, location.href); const q = [...x.searchParams.keys()].map(k => keep.has(k) ? k + '=' + x.searchParams.get(k) : k); return x.origin + x.pathname + (q.length ? '?' + q.join('&') : ''); } catch { return 'invalid'; } };
  const res = performance.getEntriesByType('resource').map(e => ({ url: clean(e.name), type: e.initiatorType, bytes: e.transferSize, ms: Math.round(e.duration), proto: e.nextHopProtocol }));
  const scripts = [...document.scripts].map(s => s.src ? clean(s.src) : 'inline:' + s.textContent.length);
  const sheets = [...document.styleSheets].map(s => { let rules = -1, selectors = []; try { rules = s.cssRules.length; selectors = [...s.cssRules].slice(0, 400).map(r => r.selectorText).filter(Boolean); } catch {} return { href: s.href ? clean(s.href) : 'inline', rules, selectors }; });
  const tags = {}; for (const e of document.querySelectorAll('*')) tags[e.tagName.toLowerCase()] = (tags[e.tagName.toLowerCase()] ?? 0) + 1;
  const aria = [...document.querySelectorAll('[aria-label]')].map(e => e.tagName.toLowerCase() + '[aria-label="' + e.getAttribute('aria-label') + '"]');
  const nav = performance.getEntriesByType('navigation')[0];
  return { url: clean(location.href), title: document.title, protocol: nav?.nextHopProtocol, lang: document.documentElement.lang,
    domNodes: document.querySelectorAll('*').length, resources: res, scripts, sheets, tags,
    aria: [...new Set(aria)], globals: Object.keys(window).filter(k => /^(WIZ|AF_|IJ_|_F_|__)/.test(k)),
    rpcids: [...new Set(res.flatMap(r => (r.url.match(/rpcids=([A-Za-z0-9,]+)/)?.[1] ?? '').split(',').filter(Boolean)))] };
})()`;

export async function recon(url = "https://gemini.google.com/app") {
  await launchBrowser(true);
  const tab = await Tab.open(url, new URL(url).origin);
  try {
    await tab.navigate(url);
    await Bun.sleep(6000);
    const r: any = await tab.eval(RECON_EXPR);
    const at = new Date().toISOString();
    const db = new Database(join(relayHome(), "recon.sqlite"), {
      create: true,
    });
    db.run(
      "CREATE TABLE IF NOT EXISTS item(at TEXT, page TEXT, kind TEXT, key TEXT, data TEXT)",
    );
    db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(kind, key, tokenize='trigram')",
    );
    const ins = db.prepare("INSERT INTO item VALUES (?,?,?,?,?)");
    const fts = db.prepare("INSERT INTO fts(kind, key) VALUES (?,?)");
    db.transaction(() => {
      const put = (kind: string, key: string, data: unknown = null) => (
        ins.run(at, r.url, kind, key, JSON.stringify(data)),
        fts.run(kind, key)
      );
      for (const x of r.resources) put("resource", x.url, x);
      for (const s of r.scripts) put("script", s);
      for (const s of r.sheets)
        for (const sel of s.selectors) put("css", sel, { sheet: s.href });
      for (const [t, n] of Object.entries(r.tags)) put("tag", t, n);
      for (const a of r.aria) put("aria", a);
      for (const g of r.globals) put("global", g);
      for (const id of r.rpcids) put("rpc", id);
    })();
    db.close();
    return {
      at,
      url: r.url,
      protocol: r.protocol,
      domNodes: r.domNodes,
      resources: r.resources.length,
      origins: [...new Set(r.resources.map((x: any) => new URL(x.url).origin))]
        .length,
      scripts: r.scripts.length,
      cssSheets: r.sheets.length,
      cssRules: r.sheets.reduce(
        (s: number, x: any) => s + Math.max(0, x.rules),
        0,
      ),
      customElements: Object.keys(r.tags).filter((t) => t.includes("-")).length,
      aria: r.aria.length,
      rpcids: r.rpcids,
      signedIn: !r.aria.some((a: string) => /Se connecter|Sign in/.test(a)),
    };
  } finally {
    tab.close();
  }
}
