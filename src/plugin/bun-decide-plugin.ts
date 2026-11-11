import { plugin, type BunPlugin } from "bun";
import { readFileSync } from "node:fs";
import {
  convertVerboseLlmToDecision,
  decideSystem1,
  generateSystem1GbnfGrammar,
  maskToolSchemasWithHammer,
  OPEN_SOURCE_SYSTEM1_MODELS,
  tuneHostForCpuSsdSystem1,
  type DecideSystem1Options,
  type DecisionToolSpec,
  type System1DecisionEnvelope,
} from "../system1/decisional-engine.ts";

export interface DecidePolicyFileSpec {
  name?: string;
  description?: string;
  confidenceThreshold?: number;
  hammerMasking?: boolean;
  includeBunDocsRefs?: boolean;
  tools?: DecisionToolSpec[];
}

export interface PolicyRouterInstance {
  readonly name: string;
  readonly tools: readonly DecisionToolSpec[];
  readonly gbnfGrammar: string;
  decide(prompt: string): System1DecisionEnvelope;
  transduce(verboseLlmOutput: string): System1DecisionEnvelope;
}

export function createPolicyRouter(
  spec: DecidePolicyFileSpec,
): PolicyRouterInstance {
  const rawTools = spec.tools ?? [];
  const hammer = spec.hammerMasking
    ? maskToolSchemasWithHammer(rawTools)
    : undefined;

  const opts: DecideSystem1Options = {
    tools: rawTools,
    confidenceThreshold: spec.confidenceThreshold ?? 0.58,
    includeBunDocsRefs: spec.includeBunDocsRefs ?? false,
    hammerMaskMap: hammer?.maskToOriginal,
  };

  const gbnfGrammar = generateSystem1GbnfGrammar(
    hammer ? hammer.maskedTools : rawTools,
  );

  return {
    name: spec.name ?? "sovereign-system1-router",
    tools: rawTools,
    gbnfGrammar,
    decide(prompt: string): System1DecisionEnvelope {
      return decideSystem1(prompt, opts);
    },
    transduce(verboseLlmOutput: string): System1DecisionEnvelope {
      return convertVerboseLlmToDecision(verboseLlmOutput, opts);
    },
  };
}

// Bun.decide and Bun.transduceDecision runtime installation

const GLOBAL_DECIDE_SYMBOL = Symbol.for("sovereign.bun.decide.runtime");

interface GlobalDecideBridge {
  decideSystem1: typeof decideSystem1;
  convertVerboseLlmToDecision: typeof convertVerboseLlmToDecision;
  createPolicyRouter: typeof createPolicyRouter;
  generateSystem1GbnfGrammar: typeof generateSystem1GbnfGrammar;
  tuneHostForCpuSsdSystem1: typeof tuneHostForCpuSsdSystem1;
  OPEN_SOURCE_SYSTEM1_MODELS: typeof OPEN_SOURCE_SYSTEM1_MODELS;
}

function ensureBunDecideGlobalInstalled(): void {
  const g = globalThis as unknown as Record<symbol, GlobalDecideBridge>;
  g[GLOBAL_DECIDE_SYMBOL] = {
    decideSystem1,
    convertVerboseLlmToDecision,
    createPolicyRouter,
    generateSystem1GbnfGrammar,
    tuneHostForCpuSsdSystem1,
    OPEN_SOURCE_SYSTEM1_MODELS,
  };

  const bunObj = Bun as unknown as Record<string, unknown>;
  if (typeof bunObj.decide !== "function") {
    Object.defineProperty(bunObj, "decide", {
      value: (prompt: string, options?: DecideSystem1Options) =>
        decideSystem1(prompt, options),
      writable: true,
      configurable: true,
    });
  }
  if (typeof bunObj.transduceDecision !== "function") {
    Object.defineProperty(bunObj, "transduceDecision", {
      value: (rawVerboseOutput: string, options?: DecideSystem1Options) =>
        convertVerboseLlmToDecision(rawVerboseOutput, options),
      writable: true,
      configurable: true,
    });
  }
}

export function generateDecidePolicyModuleCode(
  filePath: string,
  rawContent: string,
): string {
  const isToml = filePath.toLowerCase().endsWith(".toml");
  const parsed = (
    isToml ? Bun.TOML.parse(rawContent) : JSON.parse(rawContent)
  ) as DecidePolicyFileSpec;

  const normPath = filePath.replace(/\\/g, "/");
  return `
const bridge = globalThis[Symbol.for("sovereign.bun.decide.runtime")];
export const policyPath = ${JSON.stringify(normPath)};
export const policySpec = ${JSON.stringify(parsed, null, 2)};
export const router = bridge.createPolicyRouter(policySpec);
export const tools = router.tools;
export const gbnfGrammar = router.gbnfGrammar;
export function decide(prompt) { return router.decide(prompt); }
export function transduce(verboseOutput) { return router.transduce(verboseOutput); }
export default router;
`;
}

export const bunDecidePlugin: BunPlugin = {
  name: "sovereign-bun-decide-plugin",
  setup(build) {
    ensureBunDecideGlobalInstalled();

    // 1. Virtual module `bun:decide`
    build.onResolve({ filter: /^bun:decide$/ }, () => ({
      path: "bun:decide",
      namespace: "bun-decide-virtual",
    }));

    build.onLoad({ filter: /.*/, namespace: "bun-decide-virtual" }, () => ({
      loader: "js",
      contents: `
const bridge = globalThis[Symbol.for("sovereign.bun.decide.runtime")];
export const decide = bridge.decideSystem1;
export const transduce = bridge.convertVerboseLlmToDecision;
export const createPolicyRouter = bridge.createPolicyRouter;
export const generateSystem1GbnfGrammar = bridge.generateSystem1GbnfGrammar;
export const tuneHostForCpuSsdSystem1 = bridge.tuneHostForCpuSsdSystem1;
export const OPEN_SOURCE_SYSTEM1_MODELS = bridge.OPEN_SOURCE_SYSTEM1_MODELS;
export default {
  decide: bridge.decideSystem1,
  transduce: bridge.convertVerboseLlmToDecision,
  createPolicyRouter: bridge.createPolicyRouter,
  generateSystem1GbnfGrammar: bridge.generateSystem1GbnfGrammar,
  tuneHostForCpuSsdSystem1: bridge.tuneHostForCpuSsdSystem1,
  OPEN_SOURCE_SYSTEM1_MODELS: bridge.OPEN_SOURCE_SYSTEM1_MODELS,
};
`,
    }));

    // 2. Compile declarative `*.decide.json` & `*.decide.toml` files into native System-1 routers
    build.onLoad({ filter: /\.decide\.(json|toml)$/i }, (args) => {
      const content = readFileSync(args.path, "utf8");
      return {
        loader: "js",
        contents: generateDecidePolicyModuleCode(args.path, content),
      };
    });
  },
};

export function registerBunDecidePlugin(): void {
  ensureBunDecideGlobalInstalled();
  try {
    plugin(bunDecidePlugin);
  } catch {
    // Already registered in current Bun isolate
  }
}

// Auto-install on import so `Bun.decide(...)` and `import ... from "bun:decide"` work immediately
registerBunDecidePlugin();
