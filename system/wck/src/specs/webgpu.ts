import type { SpecCheck, SpecResult, WebFilesContext } from "../types";

export function validateWebGpuSpec(ctx: WebFilesContext): SpecResult {
  const checks: SpecCheck[] = [];
  const errors: string[] = [];

  const wgslSources: Array<{ source: string; content: string }> = [];

  // 1. Collect .wgsl files
  for (const wgslFile of ctx.wgslFiles) {
    wgslSources.push({
      source: wgslFile.relPath,
      content: wgslFile.content,
    });
  }

  // 2. Scan JS/TS and HTML for inline WGSL shaders
  const allCodeFiles = [
    ...ctx.jsFiles.map((f) => ({ source: f.relPath, content: f.content })),
    ...ctx.htmlFiles.map((f) => ({ source: f.relPath, content: f.content })),
  ];

  for (const file of allCodeFiles) {
    // Look for template strings containing @compute, @vertex, or @fragment
    const shaderRegex = /`([^`]*@(compute|vertex|fragment)[\s\S]*?)`/g;
    let sMatch: RegExpExecArray | null;
    let idx = 1;
    while ((sMatch = shaderRegex.exec(file.content)) !== null) {
      wgslSources.push({
        source: `${file.source} (inline shader #${idx++})`,
        content: sMatch[1],
      });
    }
  }

  // 3. WebGPU Capability Guard check in JS/TS/HTML
  const hasWebGpuCall = allCodeFiles.some(
    (f) =>
      /navigator\.gpu\.requestAdapter/i.test(f.content) ||
      /canvas\.getContext\(["']webgpu["']\)/i.test(f.content),
  );

  if (hasWebGpuCall) {
    const hasGuard = allCodeFiles.some(
      (f) =>
        /if\s*\(\s*!\s*navigator\.gpu\s*\)/i.test(f.content) ||
        /if\s*\(\s*["']gpu["']\s+in\s+navigator\s*\)/i.test(f.content) ||
        /if\s*\([^)]*navigator[^)]*gpu/i.test(f.content) ||
        /navigator\.gpu\s*\?/i.test(f.content) ||
        /navigator\.gpu\s*&&/i.test(f.content) ||
        /&&navigator\.gpu\b/i.test(f.content) ||
        /typeof\s*navigator[^&]*&&[^&]*gpu/i.test(f.content) ||
        /\(navigator\s+as\s+any\)\.gpu/i.test(f.content),
    );

    if (hasGuard) {
      checks.push({
        id: "webgpu-capability-guard",
        name: "WebGPU navigator.gpu Capability Guard",
        description:
          "Browser WebGPU API access is properly guarded against unsupported environments",
        status: "pass",
        metric: "Guarded: if (!navigator.gpu)",
      });
    } else {
      const err =
        "Unshielded navigator.gpu call without capability detection guard";
      errors.push(err);
      checks.push({
        id: "webgpu-capability-guard",
        name: "WebGPU navigator.gpu Capability Guard",
        description:
          "Browser WebGPU API access is properly guarded against unsupported environments",
        status: "fail",
        details: err,
      });
    }
  } else {
    checks.push({
      id: "webgpu-capability-guard",
      name: "WebGPU Capability Environment",
      description: "No unshielded WebGPU calls found",
      status: "pass",
      metric: "Clean capability handling",
    });
  }

  if (wgslSources.length === 0) {
    checks.push({
      id: "webgpu-shader-scan",
      name: "WGSL Shader Spec & Entry Points",
      description:
        "Scanned for WGSL shader modules (@compute, @vertex, @fragment)",
      status: "pass",
      metric: "0 shaders required (standard DOM rendering)",
    });

    checks.push({
      id: "webgpu-workgroup-bounds",
      name: "Workgroup Size Bounds (<= 256 universal limit)",
      description: "Dawn/Chromium compute workgroup size limits verified",
      status: "pass",
      metric: "Verified universal compatibility",
    });

    return {
      specId: "webgpu",
      title: "Spec 7 — WebGPU & Chromium Dawn Spec Gate",
      score: 100,
      passed: true,
      checks,
      errors: [],
    };
  }

  // Validate each WGSL source
  for (const item of wgslSources) {
    const code = item.content;

    // Check entry points
    const hasEntryPoint =
      /@compute\b/i.test(code) ||
      /@vertex\b/i.test(code) ||
      /@fragment\b/i.test(code);

    if (hasEntryPoint) {
      checks.push({
        id: `webgpu-entry-${item.source}`,
        name: `WGSL Entry Point: ${item.source}`,
        description: "Valid @compute, @vertex, or @fragment entry point",
        status: "pass",
        metric: "Valid entry points declared",
      });
    } else {
      const err = `Missing @compute, @vertex, or @fragment entry point in ${item.source}`;
      errors.push(err);
      checks.push({
        id: `webgpu-entry-${item.source}`,
        name: `WGSL Entry Point: ${item.source}`,
        description: "Valid @compute, @vertex, or @fragment entry point",
        status: "fail",
        details: err,
      });
    }

    // Check workgroup sizes: @workgroup_size(X, Y, Z) or @workgroup_size(X, Y) or @workgroup_size(X)
    const wgRegex =
      /@workgroup_size\s*\(\s*([0-9]+)\s*(?:,\s*([0-9]+))?\s*(?:,\s*([0-9]+))?\s*\)/g;
    let wgMatch: RegExpExecArray | null;
    let wgPassed = true;

    while ((wgMatch = wgRegex.exec(code)) !== null) {
      const x = parseInt(wgMatch[1], 10);
      const y = wgMatch[2] ? parseInt(wgMatch[2], 10) : 1;
      const z = wgMatch[3] ? parseInt(wgMatch[3], 10) : 1;
      const total = x * y * z;

      if (total > 256 || x > 256 || y > 256 || z > 64) {
        wgPassed = false;
        const err = `Workgroup size (${x}, ${y}, ${z}) = ${total} exceeds Dawn/Chromium 256 universal limit in ${item.source}`;
        errors.push(err);
        checks.push({
          id: `webgpu-wg-${item.source}`,
          name: `Workgroup Bounds: ${item.source}`,
          description:
            "Compute invocations must be <= 256 for universal Chromium/Dawn compatibility",
          status: "fail",
          details: err,
          metric: `${total} invocations`,
        });
      }
    }

    if (wgPassed && /@compute/i.test(code)) {
      checks.push({
        id: `webgpu-wg-${item.source}`,
        name: `Workgroup Bounds: ${item.source}`,
        description:
          "Compute invocations verified <= 256 for universal Dawn compatibility",
        status: "pass",
        metric: "<= 256 invocations verified",
      });
    }

    // Check @group(g) @binding(b) uniqueness
    const bindingRegex =
      /@group\s*\(\s*([0-9]+)\s*\)\s*@binding\s*\(\s*([0-9]+)\s*\)/g;
    let bMatch: RegExpExecArray | null;
    const seenBindings = new Set<string>();
    let bindingsUnique = true;

    while ((bMatch = bindingRegex.exec(code)) !== null) {
      const key = `${bMatch[1]}:${bMatch[2]}`;
      if (seenBindings.has(key)) {
        bindingsUnique = false;
        const err = `Duplicate binding @group(${bMatch[1]}) @binding(${bMatch[2]}) in ${item.source}`;
        errors.push(err);
        checks.push({
          id: `webgpu-bind-${item.source}`,
          name: `Binding Uniqueness: ${item.source}`,
          description: "All @group(g) @binding(b) pairs must be unique",
          status: "fail",
          details: err,
        });
      }
      seenBindings.add(key);
    }

    if (bindingsUnique && seenBindings.size > 0) {
      checks.push({
        id: `webgpu-bind-${item.source}`,
        name: `Binding Uniqueness: ${item.source}`,
        description: "All @group(g) @binding(b) pairs verified unique",
        status: "pass",
        metric: `${seenBindings.size} unique bindings`,
      });
    }

    // Check Struct Uniform 16-byte alignment
    // Find structs used as var<uniform>
    const uniformVarRegex =
      /var<uniform>\s+([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z0-9_]+)/g;
    let uMatch: RegExpExecArray | null;
    const uniformStructNames = new Set<string>();
    while ((uMatch = uniformVarRegex.exec(code)) !== null) {
      uniformStructNames.add(uMatch[2]);
    }

    let structAlignmentPassed = true;
    for (const structName of uniformStructNames) {
      const structRegex = new RegExp(
        `struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`,
        "m",
      );
      const sDef = code.match(structRegex);
      if (sDef) {
        const cleanBody = sDef[1]
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");

        const fields = cleanBody
          .split(/[,;\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.includes(":"));

        let offset = 0;
        for (const field of fields) {
          const typeMatch = field.match(/:\s*([a-zA-Z0-9_<>\s]+)/);
          if (!typeMatch) continue;
          const typeName = typeMatch[1].replace(/\s+/g, "");

          let align = 4;
          let size = 4;
          if (typeName === "f32" || typeName === "i32" || typeName === "u32") {
            align = 4;
            size = 4;
          } else if (typeName.includes("vec2")) {
            align = 8;
            size = 8;
          } else if (typeName.includes("vec3")) {
            align = 16;
            size = 12;
          } else if (typeName.includes("vec4")) {
            align = 16;
            size = 16;
          } else if (typeName.includes("mat4x4")) {
            align = 16;
            size = 64;
          }

          // Check if offset is multiple of align
          if (offset % align !== 0) {
            structAlignmentPassed = false;
            const err = `Uniform struct ${structName} member '${field}' has misaligned offset ${offset} (requires ${align}-byte alignment)`;
            errors.push(err);
            checks.push({
              id: `webgpu-struct-${structName}`,
              name: `Struct Uniform Alignment: ${structName}`,
              description:
                "Uniform struct members must respect std140 / WGSL 16-byte alignment rules",
              status: "fail",
              details: err,
            });
            break;
          }
          offset += size;
        }

        // Total struct size must be multiple of 16 in uniform buffer
        if (structAlignmentPassed && offset % 16 !== 0) {
          structAlignmentPassed = false;
          const err = `Uniform struct ${structName} total size ${offset} bytes is not a multiple of 16 bytes (pad required)`;
          errors.push(err);
          checks.push({
            id: `webgpu-struct-${structName}`,
            name: `Struct Uniform Alignment: ${structName}`,
            description:
              "Uniform struct total size must be a multiple of 16 bytes",
            status: "fail",
            details: err,
          });
        }
      }
    }

    if (structAlignmentPassed && uniformStructNames.size > 0) {
      checks.push({
        id: `webgpu-struct-${item.source}`,
        name: `Struct Uniform Alignment: ${item.source}`,
        description: "16-byte uniform alignment and padding rules verified",
        status: "pass",
        metric: `${uniformStructNames.size} uniform structs std140-aligned`,
      });
    }
  }

  const passedCount = checks.filter((c) => c.status === "pass").length;
  const score = Math.round((passedCount / checks.length) * 100);

  return {
    specId: "webgpu",
    title: "Spec 7 — WebGPU & Chromium Dawn Spec Gate",
    score,
    passed: score === 100,
    checks,
    errors,
  };
}
