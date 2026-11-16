import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildBm25Index,
  rankBm25,
  reciprocalRankFusion,
  type Bm25Index,
} from "./bm25";
import {
  STATIC_DIMS,
  dequantizeVectorRow,
  toAlignedFloat32Array,
  toInt8Array,
} from "./quantize";
import { StaticEmbedder, defaultDataDir } from "./static-embedder";

export interface UseCaseResult {
  id: string;
  description: string;
  category: string;
  featuresUsed: string[];
  tokenCount: number;
  similarity: number;
}

export interface UseCaseVector {
  id: string;
  description: string;
  category: string;
  featuresUsed: string[];
  tokenCount: number;
  vector: Float32Array;
  chunkContent: string;
}

export interface EmbedderLike {
  embed(text: string): Promise<number[]>;
}

export const DEFAULT_MIN_SIMILARITY = 0.3;

let cachedCorpus: { vectors: UseCaseVector[]; bm25: Bm25Index } | null = null;

export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch in dotProduct: ${a.length} !== ${b.length}`,
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function loadVectors(dataDir = defaultDataDir()): UseCaseVector[] {
  const genDir = join(dataDir, "gen");
  const vectorsFile = join(genDir, "guide-chunks.json.gz");
  const i8File = join(genDir, "guide-chunks.i8");
  const scaleFile = join(genDir, "guide-chunks.scale.f32");

  if (
    !existsSync(vectorsFile) ||
    !existsSync(i8File) ||
    !existsSync(scaleFile)
  ) {
    throw new Error(`Vectors files not found in ${genDir}`);
  }

  const jsonContent = new TextDecoder().decode(Bun.gunzipSync(readFileSync(vectorsFile)));
  const items = JSON.parse(jsonContent) as Array<Omit<UseCaseVector, "vector">>;
  const i8Buf = readFileSync(i8File);
  const scaleBuf = readFileSync(scaleFile);

  const n = items.length;
  if (scaleBuf.byteLength !== n * 4) {
    throw new Error(
      `Corrupt vector scale file ${scaleFile}: ${scaleBuf.byteLength} !== ${n * 4}`,
    );
  }
  const dims = n > 0 ? i8Buf.byteLength / n : STATIC_DIMS;
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`Corrupt vector i8 file ${i8File}`);
  }

  const qTable = toInt8Array(i8Buf);
  const scales = toAlignedFloat32Array(scaleBuf);

  const out: UseCaseVector[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      ...items[i],
      vector: dequantizeVectorRow(qTable, scales, i, dims),
    });
  }
  return out;
}

export async function searchUseCases(
  query: string,
  limit = 10,
  minSimilarity = DEFAULT_MIN_SIMILARITY,
  embedder?: EmbedderLike,
): Promise<UseCaseResult[]> {
  const actualEmbedder = embedder ?? StaticEmbedder.getInstance();
  const queryVector = await actualEmbedder.embed(query);

  if (!cachedCorpus) {
    const vectors = loadVectors();
    cachedCorpus = {
      vectors,
      bm25: buildBm25Index(
        vectors.map((v) => ({
          id: v.id,
          text: `${v.id} ${v.description}\n\n${v.chunkContent}`,
        })),
      ),
    };
  }

  const best = new Map<string, { item: UseCaseVector; similarity: number }>();
  for (const item of cachedCorpus.vectors) {
    if (item.vector.length === 0) continue;
    const sim = dotProduct(queryVector, item.vector);
    const existing = best.get(item.id);
    if (!existing || sim > existing.similarity) {
      best.set(item.id, { item, similarity: sim });
    }
  }

  const dense = [...best.values()].sort((a, b) => b.similarity - a.similarity);
  const bm25Matches = rankBm25(cachedCorpus.bm25, query);

  const topDenseSim = dense.length > 0 ? dense[0].similarity : 0;
  if (topDenseSim < minSimilarity && bm25Matches.length === 0) {
    return [];
  }

  const fused = reciprocalRankFusion([
    topDenseSim < minSimilarity ? [] : dense.map((r) => r.item.id),
    bm25Matches.map((r) => r.id),
  ]);

  return fused.slice(0, limit).flatMap(({ id }) => {
    const r = best.get(id);
    if (!r) return [];
    return [
      {
        id: r.item.id,
        description: r.item.description,
        category: r.item.category,
        featuresUsed: r.item.featuresUsed,
        tokenCount: r.item.tokenCount,
        similarity: Number(r.similarity.toFixed(4)),
      },
    ];
  });
}
