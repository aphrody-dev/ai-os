export const STATIC_DIMS = 256;
export const STATIC_EMBEDDING_DIMS = STATIC_DIMS;

export function l2Normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export function toAlignedFloat32Array(buf: Uint8Array): Float32Array {
  const aligned = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  );
  return new Float32Array(aligned);
}

export function toInt8Array(buf: Uint8Array): Int8Array {
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function dequantizeVectorRow(
  qTable: Int8Array,
  scales: Float32Array,
  index: number,
  dims = STATIC_DIMS,
): Float32Array {
  const scale = scales[index];
  if (!scale) return new Float32Array(0);
  const offset = index * dims;
  const vec = new Float32Array(dims);
  for (let k = 0; k < dims; k++) {
    vec[k] = qTable[offset + k] * scale;
  }
  return l2Normalize(vec);
}

export function quantizeVectors(
  vectors: Array<ArrayLike<number>>,
  dims = STATIC_DIMS,
): { qTable: Int8Array; scales: Float32Array } {
  const n = vectors.length;
  const qTable = new Int8Array(n * dims);
  const scales = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = vectors[i];
    if (!v || v.length === 0) continue;
    let maxAbs = 0;
    for (let k = 0; k < dims; k++) {
      const a = Math.abs(v[k] || 0);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs === 0) continue;
    const scale = maxAbs / 127;
    scales[i] = scale;
    const offset = i * dims;
    for (let k = 0; k < dims; k++) {
      const q = Math.round((v[k] || 0) / scale);
      qTable[offset + k] = Math.max(-127, Math.min(127, q));
    }
  }
  return { qTable, scales };
}
