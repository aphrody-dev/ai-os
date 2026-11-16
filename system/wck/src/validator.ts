import { loadWebContext } from "./context";
import { validateSeoSpec } from "./specs/seo";
import { validateAiSeoSpec } from "./specs/aiseo";
import { validateModernWebGuidelinesSpec } from "./specs/mwg";
import { validateCoreWebVitalsSpec } from "./specs/cwv";
import { validateLighthouseGate } from "./specs/lh";
import { validateWasmSpec } from "./specs/wasm";
import { validateWebGpuSpec } from "./specs/webgpu";
import type {
  SpecId,
  SpecResult,
  ValidateOptions,
  ValidationReport,
} from "./types";

export function validateWeb(
  targetPath: string,
  options: ValidateOptions = {},
): ValidationReport {
  const ctx = loadWebContext(targetPath);

  const seo = validateSeoSpec(ctx);
  const aiseo = validateAiSeoSpec(ctx);
  const mwg = validateModernWebGuidelinesSpec(ctx);
  const cwv = validateCoreWebVitalsSpec(ctx);
  const lh = validateLighthouseGate(ctx);
  const wasm = validateWasmSpec(ctx);
  const webgpu = validateWebGpuSpec(ctx);

  const specs: Record<SpecId, SpecResult> = {
    seo,
    aiseo,
    mwg,
    cwv,
    lh,
    wasm,
    webgpu,
  };

  const specList = Object.values(specs);
  const overallScore = Math.round(
    specList.reduce((acc, s) => acc + s.score, 0) / specList.length,
  );
  const allPassed = specList.every((s) => s.passed && s.score === 100);

  const summary = allPassed
    ? "ALL 7 COMPILE-TIME WEB SPECS PASSED (100/100/100/100/100/100/100)"
    : `WEB GATE FAILED: Overall ${overallScore}/100 - One or more specs did not reach 100/100`;

  return {
    targetPath,
    timestamp: new Date().toISOString(),
    allPassed,
    overallScore,
    specs,
    summary,
  };
}

export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push(
    "===============================================================================",
  );
  lines.push(
    "           WCK: Compile-Time Web & Lighthouse Gate           ",
  );
  lines.push(
    "===============================================================================",
  );
  lines.push(`Target: ${report.targetPath}`);
  lines.push(
    `Status: ${report.allPassed ? "PASSED (100% Guaranteed)" : "FAILED"}`,
  );
  lines.push(`Overall Score: ${report.overallScore}/100`);
  lines.push(
    "-------------------------------------------------------------------------------",
  );

  for (const [id, spec] of Object.entries(report.specs)) {
    const badge =
      spec.score === 100 ? "[PASS 100/100]" : `[FAIL  ${spec.score}/100]`;
    lines.push(`${badge} ${spec.title}`);

    for (const check of spec.checks) {
      const mark = check.status === "pass" ? "  OK " : "  FAIL";
      const metric = check.metric ? ` (${check.metric})` : "";
      const details = check.details ? ` -> ${check.details}` : "";
      lines.push(`   ${mark} ${check.name}${metric}${details}`);
    }

    if (spec.errors.length > 0) {
      for (const err of spec.errors) {
        lines.push(`     ! ERROR: ${err}`);
      }
    }
    lines.push("");
  }

  lines.push(
    "===============================================================================",
  );
  lines.push(report.summary);
  lines.push(
    "===============================================================================",
  );

  return lines.join("\n");
}
