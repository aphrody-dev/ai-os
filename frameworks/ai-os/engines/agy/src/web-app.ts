import {
  diagnoseGoogleAuth,
  inspectWasmAndWebGpuCapabilities,
  listActiveCollections,
  SKILL_COLLECTION_PACKS,
} from "../../../src/index.ts";
import {
  buildGitingestDigest,
  GOOGLE_AI_ECOSYSTEM_SURFACES,
  GOOGLE_AI_ORGS,
  loadGoogleOrgsCatalog,
} from "./depot-orgs.ts";
import {
  GEMMA_4_MODEL_CATALOG,
  runGemma4KeylessInference,
  selectOptimalGemma4Model,
} from "./gemma4-lab.ts";
import {
  readCurrentAgyMode,
  runHumanizerAndImpeccableAudit,
  switchAgyMode,
  type AgyExecutionMode,
} from "./modes-and-collections.ts";
import {
  askOpenNotebookLm,
  generateDeepMindResearchNotebook,
  generateNotebookLmAudioOverview,
  ingestNotebookLmSource,
} from "./notebook-engine.ts";
import {
  calculateContextOptimizationSavings,
  computeSubscriptionRentabilisation,
  GEMINI_AND_LOCAL_PRICING,
  GOOGLE_AI_PLANS,
} from "./ultra-finops.ts";

function renderStudioHtml(): string {
  const catalog = loadGoogleOrgsCatalog();
  const orgCounts = GOOGLE_AI_ORGS.map(
    (o) =>
      `<li><strong>${o}</strong>: ${catalog[o].length} tracked repositories</li>`,
  ).join("");
  const fit = selectOptimalGemma4Model();
  const finops = computeSubscriptionRentabilisation();
  const mode = readCurrentAgyMode();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AGY Sovereign Google AI Studio & Ecosystem Hub</title>
  <style>
    :root {
      --bg: #0b0f19;
      --surface: #131a2a;
      --border: #23304a;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #60a5fa;
      --ok: #34d399;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
      padding: 2rem;
      max-width: 1280px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
      margin-bottom: 1.5rem;
    }
    h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; }
    .badge {
      background: #1e293b;
      border: 1px solid var(--border);
      color: var(--ok);
      padding: 0.25rem 0.75rem;
      border-radius: 999px;
      font-size: 0.8rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1rem;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
    }
    .card h2 {
      font-size: 1rem;
      color: var(--accent);
      margin-bottom: 0.65rem;
    }
    ul { padding-left: 1.15rem; color: var(--muted); font-size: 0.9rem; }
    p, code { font-size: 0.9rem; color: var(--muted); }
    code { color: var(--text); background: #0f172a; padding: 0.1rem 0.35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>AGY Studio — Local-First Keyless Google AI Ecosystem</h1>
      <p>Powered by sole AI owner <code>@aphrody/ai-os</code> (Bun v${Bun.version} + Rust WASM32 + WebGPU + CUDA sm_89)</p>
    </div>
    <span class="badge">Mode: ${mode.mode} (${mode.activeTools.length} MCP tools)</span>
  </header>
  <main class="grid">
    <section class="card">
      <h2>5-Org Keyless Google Depot</h2>
      <ul>${orgCounts}</ul>
    </section>
    <section class="card">
      <h2>Gemma 4 Local Hardware Fit (RTX 4070)</h2>
      <p>Recommended: <code>${fit.model.id}</code> (${fit.totalRequiredMb} MB / ${fit.availableVramMb} MB VRAM, 100% GPU: ${fit.fits100PctGpu})</p>
      <p>Pipelines: JAX+Optax+Tunix, CUDA 13.4 sm_89, PyTorch+Heretic</p>
    </section>
    <section class="card">
      <h2>Google AI Ultra Rentabilisation</h2>
      <p>Plan: <strong>${finops.plan.displayName}</strong> ($${finops.monthlyPriceUsd}/mo)</p>
      <p>Extracted Value: <strong>$${finops.totalExtractedMonthlyValueUsd}/mo</strong> (${finops.rentabilisationPct}% ROI)</p>
    </section>
    <section class="card">
      <h2>Open NotebookLM & DeepMind Notebooks</h2>
      <p>Headless API endpoints: <code>/api/notebooklm</code>, <code>/api/gemma</code>, <code>/api/depot</code>, <code>/api/ultra</code>, <code>/api/modes</code></p>
    </section>
  </main>
</body>
</html>`;
}

export async function routeAgyWebRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "GET" && path === "/") {
    return new Response(renderStudioHtml(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (req.method === "GET" && (path === "/health" || path === "/api/status")) {
    const mode = readCurrentAgyMode();
    return Response.json({
      ok: true,
      package: "@aphrody/agy",
      version: "2.0.0",
      aiOwner: "@aphrody/ai-os",
      mode,
      wasmWebGpu: inspectWasmAndWebGpuCapabilities(),
      surfacesCount: GOOGLE_AI_ECOSYSTEM_SURFACES.length,
    });
  }

  if (req.method === "GET" && path === "/api/depot") {
    const orgFilter = url.searchParams.get("org");
    const catalog = loadGoogleOrgsCatalog();
    return Response.json({
      ok: true,
      orgs: GOOGLE_AI_ORGS,
      surfaces: GOOGLE_AI_ECOSYSTEM_SURFACES,
      repositories:
        orgFilter && orgFilter in catalog
          ? { [orgFilter]: catalog[orgFilter as keyof typeof catalog] }
          : catalog,
    });
  }

  if (req.method === "POST" && path === "/api/ingest") {
    const body = (await req.json().catch(() => ({}))) as { path?: string };
    if (!body.path) {
      return Response.json(
        { ok: false, error: "Missing 'path'" },
        { status: 400 },
      );
    }
    return Response.json(buildGitingestDigest(body.path));
  }

  if (path === "/api/gemma") {
    if (req.method === "GET") {
      return Response.json({
        ok: true,
        models: GEMMA_4_MODEL_CATALOG,
        optimalFit: selectOptimalGemma4Model(),
      });
    }
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        prompt?: string;
        modelId?: string;
        enableThinking?: boolean;
      };
      const res = await runGemma4KeylessInference({
        prompt: body.prompt ?? "Summarize Gemma 4 architecture.",
        modelId: body.modelId,
        enableThinking: body.enableThinking,
      });
      return Response.json(res);
    }
  }

  if (path === "/api/notebooklm") {
    const body = (await req.json().catch(() => ({}))) as {
      action?: "ingest" | "ask" | "audio" | "deepmind_ipynb";
      notebookId?: string;
      title?: string;
      textOrPath?: string;
      question?: string;
      topic?: string;
    };
    const notebookId = body.notebookId ?? "default";
    if (body.action === "ingest") {
      return Response.json(
        ingestNotebookLmSource({
          notebookId,
          title: body.title ?? "Untitled Source",
          textOrPath: body.textOrPath ?? "",
        }),
      );
    }
    if (body.action === "audio") {
      return Response.json(
        generateNotebookLmAudioOverview({
          notebookId,
          topic: body.topic,
        }),
      );
    }
    if (body.action === "deepmind_ipynb") {
      return Response.json(
        generateDeepMindResearchNotebook({
          topic: body.topic ?? "Gemma 4 Sparse Attention",
        }),
      );
    }
    return Response.json(
      await askOpenNotebookLm({
        notebookId,
        question: body.question ?? "Summarize key findings.",
      }),
    );
  }

  if (req.method === "GET" && path === "/api/ultra") {
    return Response.json({
      ok: true,
      plans: GOOGLE_AI_PLANS,
      pricing: GEMINI_AND_LOCAL_PRICING,
      contextOptimization: calculateContextOptimizationSavings(),
      rentabilisation: computeSubscriptionRentabilisation(),
    });
  }

  if (path === "/api/modes") {
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        mode?: AgyExecutionMode;
        domainFocus?: string;
        humanizeText?: string;
      };
      if (body.humanizeText !== undefined) {
        return Response.json(runHumanizerAndImpeccableAudit(body.humanizeText));
      }
      const next = switchAgyMode(
        body.mode === "fullstack" ? "fullstack" : "minimal",
        {
          domainFocus: body.domainFocus,
        },
      );
      return Response.json({ ok: true, state: next });
    }
    return Response.json({
      ok: true,
      state: readCurrentAgyMode(),
      availableCollections: SKILL_COLLECTION_PACKS,
      activeCollections: listActiveCollections(),
    });
  }

  if (req.method === "GET" && path === "/api/auth") {
    return Response.json(await diagnoseGoogleAuth());
  }

  return Response.json(
    { ok: false, error: `Not found: ${req.method} ${path}` },
    { status: 404 },
  );
}

export function startAgyWebServer(options?: {
  port?: number;
  hostname?: string;
}) {
  const port = options?.port ?? Number(process.env.AGY_WEB_PORT ?? 4325);
  const hostname = options?.hostname ?? "127.0.0.1";
  return Bun.serve({
    port,
    hostname,
    fetch: routeAgyWebRequest,
  });
}
