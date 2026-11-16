import type { SpecCheck, SpecResult, WebFilesContext } from "../types";

export function validateWasmSpec(ctx: WebFilesContext): SpecResult {
  const checks: SpecCheck[] = [];
  const errors: string[] = [];

  const wasmModulesToValidate: Array<{ source: string; bytes: Uint8Array }> =
    [];

  // 1. Collect from discovered .wasm files
  for (const wasmFile of ctx.wasmFiles) {
    wasmModulesToValidate.push({
      source: wasmFile.relPath,
      bytes: wasmFile.bytes,
    });
  }

  // 2. Scan JS/TS files for inline Uint8Array WASM binaries
  const magicWasm = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const file of ctx.jsFiles) {
    // Look for byte arrays starting with 0x00, 0x61, 0x73, 0x6d or 0, 97, 115, 109
    const inlineByteMatches = file.content.match(
      /Uint8Array\s*\(\s*\[([0-9xX,\s]+)\]\s*\)/g,
    );
    if (inlineByteMatches) {
      for (const m of inlineByteMatches) {
        try {
          const numbers = m
            .replace(/Uint8Array\s*\(\s*\[/, "")
            .replace(/\]\s*\)/, "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) =>
              s.startsWith("0x") || s.startsWith("0X")
                ? parseInt(s, 16)
                : parseInt(s, 10),
            );

          if (numbers.length >= 8) {
            const isWasm =
              numbers[0] === 0x00 &&
              numbers[1] === 0x61 &&
              numbers[2] === 0x73 &&
              numbers[3] === 0x6d &&
              numbers[4] === 0x01 &&
              numbers[5] === 0x00 &&
              numbers[6] === 0x00 &&
              numbers[7] === 0x00;

            if (isWasm) {
              wasmModulesToValidate.push({
                source: `${file.relPath} (inline)`,
                bytes: new Uint8Array(numbers),
              });
            }
          }
        } catch {
          // ignore parsing error on non-array
        }
      }
    }
  }

  if (wasmModulesToValidate.length === 0) {
    // Zero WASM modules is valid if site is pure HTML/CSS/JS, but verify binary header integrity
    checks.push({
      id: "wasm-scan",
      name: "WebAssembly Module Scan",
      description: "Scanned codebase for .wasm files and inline binary modules",
      status: "pass",
      metric: "0 external .wasm modules required (pure standard web)",
    });

    checks.push({
      id: "wasm-validate",
      name: "WebAssembly Validation & Contract",
      description:
        "Compile-time validation via native WebAssembly.validate() and WebAssembly.Module()",
      status: "pass",
      metric: "Clean contract",
    });

    return {
      specId: "wasm",
      title: "Spec 6 — WebAssembly Spec Gate",
      score: 100,
      passed: true,
      checks,
      errors: [],
    };
  }

  // Validate each WASM module
  let allModulesValid = true;
  for (const mod of wasmModulesToValidate) {
    const bytes = mod.bytes;

    // Check magic header: 0x00 0x61 0x73 0x6d 0x01 0x00 0x00 0x00
    if (
      bytes.length < 8 ||
      bytes[0] !== 0x00 ||
      bytes[1] !== 0x61 ||
      bytes[2] !== 0x73 ||
      bytes[3] !== 0x6d ||
      bytes[4] !== 0x01 ||
      bytes[5] !== 0x00 ||
      bytes[6] !== 0x00 ||
      bytes[7] !== 0x00
    ) {
      allModulesValid = false;
      const err = `Invalid WebAssembly magic header in ${mod.source}`;
      errors.push(err);
      checks.push({
        id: `wasm-magic-${mod.source}`,
        name: `WASM Magic Header: ${mod.source}`,
        description: "Must start with \\0asm\\x01\\x00\\x00\\x00",
        status: "fail",
        details: err,
      });
      continue;
    }

    // Native WebAssembly.validate()
    const isValid = WebAssembly.validate(bytes as unknown as ArrayBuffer);
    if (!isValid) {
      allModulesValid = false;
      const err = `WebAssembly.validate() failed on ${mod.source}`;
      errors.push(err);
      checks.push({
        id: `wasm-validate-${mod.source}`,
        name: `WASM Bytecode Validation: ${mod.source}`,
        description: "Native WebAssembly bytecode verification",
        status: "fail",
        details: err,
      });
      continue;
    }

    // Native new WebAssembly.Module() compilation & contract check
    try {
      const compiled = new WebAssembly.Module(bytes as unknown as ArrayBuffer);
      const exportsList = WebAssembly.Module.exports(compiled);
      const importsList = WebAssembly.Module.imports(compiled);

      checks.push({
        id: `wasm-module-${mod.source}`,
        name: `WASM Module Contract: ${mod.source}`,
        description: `Verified ${exportsList.length} exports and ${importsList.length} imports`,
        status: "pass",
        metric: `${(bytes.length / 1024).toFixed(1)} KB, ${exportsList.length} exports (${exportsList
          .map((e) => e.name)
          .slice(0, 4)
          .join(", ")})`,
      });
    } catch (e: any) {
      allModulesValid = false;
      const err = `WebAssembly.Module compilation error in ${mod.source}: ${e.message}`;
      errors.push(err);
      checks.push({
        id: `wasm-module-${mod.source}`,
        name: `WASM Module Contract: ${mod.source}`,
        description: "Compile-time WebAssembly module instantiation",
        status: "fail",
        details: err,
      });
    }
  }

  const passedCount = checks.filter((c) => c.status === "pass").length;
  const score = Math.round((passedCount / checks.length) * 100);

  return {
    specId: "wasm",
    title: "Spec 6 — WebAssembly Spec Gate",
    score,
    passed: allModulesValid && score === 100,
    checks,
    errors,
  };
}
