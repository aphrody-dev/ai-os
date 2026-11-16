// Context7 v2 docs client. Key: CTX7_API_KEY (vault name), or upstream's CONTEXT7_API_KEY; optional.
import { tool } from "../llm/generate";
import { s } from "../llm/schema";

export const CONTEXT7_BASE = "https://context7.com/api/v2";

function headers() {
  const h: Record<string, string> = { accept: "application/json, text/plain" };
  const key = Bun.env.CTX7_API_KEY || Bun.env.CONTEXT7_API_KEY;
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

export async function searchLibraries(
  libraryName: string,
  query = libraryName,
  fetchFn: typeof fetch = fetch,
) {
  const url = new URL(`${CONTEXT7_BASE}/libs/search`);
  url.searchParams.set("libraryName", libraryName);
  url.searchParams.set("query", query);
  const r = await fetchFn(url, {
    headers: headers(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`context7 search ${r.status}`);
  const j: any = await r.json();
  const list: any[] = Array.isArray(j) ? j : (j.results ?? j.libraries ?? []);
  return list.map((l) => ({
    id: String(l.id ?? l.libraryId),
    title: String(l.title ?? l.name ?? ""),
    description: String(l.description ?? ""),
  }));
}

export async function getLibraryDocs(
  libraryId: string,
  query: string,
  fetchFn: typeof fetch = fetch,
) {
  const url = new URL(`${CONTEXT7_BASE}/context`);
  url.searchParams.set(
    "libraryId",
    libraryId.startsWith("/") ? libraryId : `/${libraryId}`,
  );
  url.searchParams.set("query", query);
  url.searchParams.set("type", "txt");
  const r = await fetchFn(url, {
    headers: headers(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`context7 docs ${r.status}`);
  return (await r.text()).slice(0, 40_000);
}

export const context7Tools = {
  docs_search: tool({
    description: "Find a library on Context7 (returns ids for docs_fetch).",
    inputSchema: s.object({ library: s.string(), query: s.string() }, [
      "query",
    ]),
    execute: async ({ library, query }) => searchLibraries(library, query),
  }),
  docs_fetch: tool({
    description:
      "Fetch current documentation snippets for a Context7 library id.",
    inputSchema: s.object({ libraryId: s.string(), query: s.string() }),
    execute: async ({ libraryId, query }) => getLibraryDocs(libraryId, query),
  }),
};
