import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "./bm25";
import {
  STATIC_EMBEDDING_DIMS,
  toAlignedFloat32Array,
  toInt8Array,
} from "./quantize";

interface StaticModelData {
  words: string[];
  wordIndex: Map<string, number>;
  table: Int8Array;
  scales: Float32Array;
}

export function defaultDataDir(): string {
  return join(import.meta.dir, "..", "..", "data");
}

export function encodeTokens(
  text: string,
  wordIndex: ReadonlyMap<string, number>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const tok of tokenize(text)) {
    const directIdx = wordIndex.get(tok);
    if (directIdx !== undefined) {
      out.push([directIdx, 1]);
      continue;
    }
    if (tok.includes("-")) {
      const matched: number[] = [];
      for (const part of tok.split("-")) {
        const idx = wordIndex.get(part);
        if (idx !== undefined) matched.push(idx);
      }
      if (matched.length > 0) {
        const weight = 1 / matched.length;
        for (const idx of matched) out.push([idx, weight]);
      }
    }
  }
  return out;
}

export function accumulateNormalizedVector(
  enc: ReadonlyArray<[number, number]>,
  table: Int8Array | Float32Array,
  scales: Float32Array,
  out = new Float32Array(STATIC_EMBEDDING_DIMS),
): Float32Array {
  out.fill(0);
  if (enc.length === 0) return out;
  for (const [i, f] of enc) {
    const wt = scales[i] * f;
    const offset = i * STATIC_EMBEDDING_DIMS;
    for (let k = 0; k < STATIC_EMBEDDING_DIMS; k++) {
      out[k] += wt * table[offset + k];
    }
  }
  let normSq = 0;
  for (let k = 0; k < STATIC_EMBEDDING_DIMS; k++) normSq += out[k] * out[k];
  const norm = Math.sqrt(normSq) || 1;
  for (let k = 0; k < STATIC_EMBEDDING_DIMS; k++) out[k] /= norm;
  return out;
}

export class StaticEmbedder {
  private static instance: StaticEmbedder | null = null;
  private model: StaticModelData | null = null;

  private constructor() {}

  public static getInstance(): StaticEmbedder {
    if (!StaticEmbedder.instance)
      StaticEmbedder.instance = new StaticEmbedder();
    return StaticEmbedder.instance;
  }

  private ensureModel(dataDir = defaultDataDir()): StaticModelData {
    if (this.model) return this.model;
    const modelDir = join(dataDir, "gen");
    const wordsPath = join(modelDir, "query-words.json");
    const tablePath = join(modelDir, "query-words.i8");
    const scalesPath = join(modelDir, "query-words.scale.f32");

    if (
      !existsSync(wordsPath) ||
      !existsSync(tablePath) ||
      !existsSync(scalesPath)
    ) {
      throw new Error(`Static model files missing in ${modelDir}`);
    }

    const rawWords: unknown = JSON.parse(readFileSync(wordsPath, "utf8"));
    if (!Array.isArray(rawWords)) {
      throw new Error(`Corrupt query-words.json in ${modelDir}`);
    }
    const words = rawWords.map(String);
    const wordIndex = new Map<string, number>();
    for (let i = 0; i < words.length; i++) wordIndex.set(words[i], i);

    const table = toInt8Array(readFileSync(tablePath));
    const scales = toAlignedFloat32Array(readFileSync(scalesPath));
    this.model = { words, wordIndex, table, scales };
    return this.model;
  }

  public async embed(text: string): Promise<number[]> {
    const { wordIndex, table, scales } = this.ensureModel();
    const enc = encodeTokens(text, wordIndex);
    return Array.from(accumulateNormalizedVector(enc, table, scales));
  }
}
