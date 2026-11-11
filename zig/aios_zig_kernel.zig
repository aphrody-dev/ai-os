// Freestanding Zig WASM32 / Native SIMD compute kernel for @aphrody/ai-os benchmark arena
var zig_scratch: [65536]u8 align(16) = undefined;

export fn zig_scratch_ptr() [*]u8 {
    return &zig_scratch;
}

export fn zig_cosine_f32(a: [*]const f32, b: [*]const f32, len: usize) f32 {
    if (len == 0) return 0.0;
    var dot: f32 = 0.0;
    var na: f32 = 0.0;
    var nb: f32 = 0.0;
    var i: usize = 0;
    while (i < len) : (i += 1) {
        const av = a[i];
        const bv = b[i];
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
    }
    const denom = @sqrt(na * nb);
    if (denom <= 1e-20) return 0.0;
    return dot / denom;
}

export fn zig_fnv1a64(ptr: [*]const u8, len: usize) u64 {
    var h: u64 = 0xcbf29ce484222325;
    var i: usize = 0;
    while (i < len) : (i += 1) {
        h ^= @as(u64, ptr[i]);
        h *%= 0x00000100000001b3;
    }
    return h;
}
