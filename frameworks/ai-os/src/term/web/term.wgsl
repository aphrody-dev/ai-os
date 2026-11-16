struct TermUniforms {
  viewport_px: vec2f,
  cell_px: vec2f,
  atlas_px: vec2f,
  grid_cols: u32,
  grid_rows: u32,
  cursor_x: u32,
  cursor_y: u32,
  cursor_style: u32,
  blink_on: u32,
  sel_start: i32,
  sel_end: i32,
  sel_bg_abgr: u32,
  sel_fg_abgr: u32,
  cursor_bg_abgr: u32,
  cursor_fg_abgr: u32,
  accent_abgr: u32,
  error_abgr: u32,
  time_sec: f32,
  hover_link_slot: u32,
  focused: u32,
  pad0: u32,
};

struct GpuCell {
  cp: u32,
  fg_abgr: u32,
  bg_abgr: u32,
  flags: u32,
  pos_packed: u32,
};

@group(0) @binding(0) var<uniform> u: TermUniforms;
@group(0) @binding(1) var<storage, read> cells: array<GpuCell>;
@group(0) @binding(2) var<storage, read> glyphs: array<vec4f>;
@group(0) @binding(3) var glyph_sampler: sampler;
@group(0) @binding(4) var glyph_tex: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) local_uv: vec2f,
  @location(1) atlas_uv: vec2f,
  @location(2) glyph_active: f32,
  @location(3) fg: vec4f,
  @location(4) bg: vec4f,
  @location(5) @interpolate(flat) flags: u32,
  @location(6) @interpolate(flat) is_cursor: u32,
  @location(7) @interpolate(flat) col: u32,
  @location(8) @interpolate(flat) cp: u32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) iid: u32,
) -> VsOut {
  let c = cells[iid];
  let g = glyphs[iid];
  let col = c.pos_packed & 0xFFFFu;
  let row = c.pos_packed >> 16u;

  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 1.0),
  );
  let k = corners[vid];

  let p0 = vec2f(f32(col), f32(row)) * u.cell_px;
  let px = p0 + k * u.cell_px;
  let ndc = vec2f(
    (px.x / max(1.0, u.viewport_px.x)) * 2.0 - 1.0,
    1.0 - (px.y / max(1.0, u.viewport_px.y)) * 2.0,
  );

  let idx = i32(row * u.grid_cols + col);
  let selected =
    u.sel_start >= 0 &&
    u.sel_end >= 0 &&
    idx >= min(u.sel_start, u.sel_end) &&
    idx <= max(u.sel_start, u.sel_end);

  var fg = unpack4x8unorm(c.fg_abgr);
  var bg = unpack4x8unorm(c.bg_abgr);
  if (selected) {
    bg = unpack4x8unorm(u.sel_bg_abgr);
    fg = unpack4x8unorm(u.sel_fg_abgr);
  }
  if ((c.flags & 2u) != 0u) {
    fg = vec4f(fg.rgb * 0.68, fg.a);
  }

  let is_cur = select(0u, 1u, u.cursor_style > 0u && col == u.cursor_x && row == u.cursor_y);

  var out: VsOut;
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.local_uv = k;
  out.atlas_uv = g.xy + k * g.zw;
  out.glyph_active = select(0.0, 1.0, g.z > 0.0 && g.w > 0.0);
  out.fg = fg;
  out.bg = bg;
  out.flags = c.flags;
  out.is_cursor = is_cur;
  out.col = col;
  out.cp = c.cp;
  return out;
}

fn sd_seg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h);
}

fn cov_arm(px: vec2f, c: vec2f, end_p: vec2f, kind: u32, lw: f32) -> f32 {
  if (kind == 0u) {
    return 0.0;
  }
  if (kind == 1u) {
    let d = sd_seg(px, c, end_p) - lw * 0.5;
    return clamp(0.5 - d, 0.0, 1.0);
  }
  if (kind == 2u) {
    let d = sd_seg(px, c, end_p) - lw;
    return clamp(0.5 - d, 0.0, 1.0);
  }
  // Double line (two parallel strokes separated by ~2.5*lw)
  let dir = end_p - c;
  let is_h = abs(dir.x) >= abs(dir.y);
  let perp = select(vec2f(lw * 1.4, 0.0), vec2f(0.0, lw * 1.4), is_h);
  let d1 = sd_seg(px, c + perp, end_p + perp) - lw * 0.42;
  let d2 = sd_seg(px, c - perp, end_p - perp) - lw * 0.42;
  return clamp(0.5 - min(d1, d2), 0.0, 1.0);
}

// Returns N, E, S, W stroke weights: 0=none, 1=light, 2=heavy, 3=double
fn box_arms(cp: u32) -> vec4u {
  switch (cp) {
    case 0x2500u: { return vec4u(0u, 1u, 0u, 1u); } // ─
    case 0x2501u: { return vec4u(0u, 2u, 0u, 2u); } // ━
    case 0x2502u: { return vec4u(1u, 0u, 1u, 0u); } // │
    case 0x2503u: { return vec4u(2u, 0u, 2u, 0u); } // ┃
    case 0x250Cu: { return vec4u(0u, 1u, 1u, 0u); } // ┌
    case 0x250Du: { return vec4u(0u, 2u, 1u, 0u); } // ┍
    case 0x250Eu: { return vec4u(0u, 1u, 2u, 0u); } // ┎
    case 0x250Fu: { return vec4u(0u, 2u, 2u, 0u); } // ┏
    case 0x2510u: { return vec4u(0u, 0u, 1u, 1u); } // ┐
    case 0x2511u: { return vec4u(0u, 0u, 1u, 2u); } // ┑
    case 0x2512u: { return vec4u(0u, 0u, 2u, 1u); } // ┒
    case 0x2513u: { return vec4u(0u, 0u, 2u, 2u); } // ┓
    case 0x2514u: { return vec4u(1u, 1u, 0u, 0u); } // └
    case 0x2515u: { return vec4u(1u, 2u, 0u, 0u); } // ┕
    case 0x2516u: { return vec4u(2u, 1u, 0u, 0u); } // ┖
    case 0x2517u: { return vec4u(2u, 2u, 0u, 0u); } // ┗
    case 0x2518u: { return vec4u(1u, 0u, 0u, 1u); } // ┘
    case 0x2519u: { return vec4u(1u, 0u, 0u, 2u); } // ┙
    case 0x251Au: { return vec4u(2u, 0u, 0u, 1u); } // ┚
    case 0x251Bu: { return vec4u(2u, 0u, 0u, 2u); } // ┛
    case 0x251Cu: { return vec4u(1u, 1u, 1u, 0u); } // ├
    case 0x2520u: { return vec4u(2u, 1u, 2u, 0u); } // ┠
    case 0x2523u: { return vec4u(2u, 2u, 2u, 0u); } // ┣
    case 0x2524u: { return vec4u(1u, 0u, 1u, 1u); } // ┤
    case 0x2528u: { return vec4u(2u, 0u, 2u, 1u); } // ┨
    case 0x252Bu: { return vec4u(2u, 0u, 2u, 2u); } // ┫
    case 0x252Cu: { return vec4u(0u, 1u, 1u, 1u); } // ┬
    case 0x2530u: { return vec4u(0u, 1u, 2u, 1u); } // ┰
    case 0x2533u: { return vec4u(0u, 2u, 2u, 2u); } // ┳
    case 0x2534u: { return vec4u(1u, 1u, 0u, 1u); } // ┴
    case 0x2538u: { return vec4u(2u, 1u, 0u, 1u); } // ┸
    case 0x253Bu: { return vec4u(2u, 2u, 0u, 2u); } // ┻
    case 0x253Cu: { return vec4u(1u, 1u, 1u, 1u); } // ┼
    case 0x254Bu: { return vec4u(2u, 2u, 2u, 2u); } // ╋
    case 0x2550u: { return vec4u(0u, 3u, 0u, 3u); } // ═
    case 0x2551u: { return vec4u(3u, 0u, 3u, 0u); } // ║
    case 0x2552u: { return vec4u(0u, 3u, 1u, 0u); } // ╒
    case 0x2553u: { return vec4u(0u, 1u, 3u, 0u); } // ╓
    case 0x2554u: { return vec4u(0u, 3u, 3u, 0u); } // ╔
    case 0x2555u: { return vec4u(0u, 0u, 1u, 3u); } // ╕
    case 0x2556u: { return vec4u(0u, 0u, 3u, 1u); } // ╖
    case 0x2557u: { return vec4u(0u, 0u, 3u, 3u); } // ╗
    case 0x2558u: { return vec4u(1u, 3u, 0u, 0u); } // ╘
    case 0x2559u: { return vec4u(3u, 1u, 0u, 0u); } // ╙
    case 0x255Au: { return vec4u(3u, 3u, 0u, 0u); } // ╚
    case 0x255Bu: { return vec4u(1u, 0u, 0u, 3u); } // ╛
    case 0x255Cu: { return vec4u(3u, 0u, 0u, 1u); } // ╜
    case 0x255Du: { return vec4u(3u, 0u, 0u, 3u); } // ╝
    case 0x255Eu: { return vec4u(1u, 3u, 1u, 0u); } // ╞
    case 0x255Fu: { return vec4u(3u, 1u, 3u, 0u); } // ╟
    case 0x2560u: { return vec4u(3u, 3u, 3u, 0u); } // ╠
    case 0x2561u: { return vec4u(1u, 0u, 1u, 3u); } // ╡
    case 0x2562u: { return vec4u(3u, 0u, 3u, 1u); } // ╢
    case 0x2563u: { return vec4u(3u, 0u, 3u, 3u); } // ╣
    case 0x2564u: { return vec4u(0u, 3u, 1u, 3u); } // ╤
    case 0x2565u: { return vec4u(0u, 1u, 3u, 1u); } // ╥
    case 0x2566u: { return vec4u(0u, 3u, 3u, 3u); } // ╦
    case 0x2567u: { return vec4u(1u, 3u, 0u, 3u); } // ╧
    case 0x2568u: { return vec4u(3u, 1u, 0u, 1u); } // ╨
    case 0x2569u: { return vec4u(3u, 3u, 0u, 3u); } // ╩
    case 0x256Au: { return vec4u(1u, 3u, 1u, 3u); } // ╪
    case 0x256Bu: { return vec4u(3u, 1u, 3u, 1u); } // ╫
    case 0x256Cu: { return vec4u(3u, 3u, 3u, 3u); } // ╬
    case 0x2574u: { return vec4u(0u, 0u, 0u, 1u); } // ╴
    case 0x2575u: { return vec4u(1u, 0u, 0u, 0u); } // ╵
    case 0x2576u: { return vec4u(0u, 1u, 0u, 0u); } // ╶
    case 0x2577u: { return vec4u(0u, 0u, 1u, 0u); } // ╷
    case 0x2578u: { return vec4u(0u, 0u, 0u, 2u); } // ╸
    case 0x2579u: { return vec4u(2u, 0u, 0u, 0u); } // ╹
    case 0x257Au: { return vec4u(0u, 2u, 0u, 0u); } // ╺
    case 0x257Bu: { return vec4u(0u, 0u, 2u, 0u); } // ╻
    case 0x257Cu: { return vec4u(0u, 2u, 0u, 1u); } // ╼
    case 0x257Du: { return vec4u(1u, 0u, 2u, 0u); } // ╽
    case 0x257Eu: { return vec4u(0u, 1u, 0u, 2u); } // ╾
    case 0x257Fu: { return vec4u(2u, 0u, 1u, 0u); } // ╿
    default: { return vec4u(0u); }
  }
}

fn procedural_cov(cp: u32, uv: vec2f) -> f32 {
  let px = uv * u.cell_px;
  let cw = u.cell_px.x;
  let ch = u.cell_px.y;
  let lw = max(1.25, round(min(cw, ch) * 0.085));
  let c = vec2f(round(cw * 0.5), round(ch * 0.5));

  // Block Elements & Shades (U+2580..U+259F)
  if (cp >= 0x2580u && cp <= 0x259Fu) {
    if (cp == 0x2580u) { return select(0.0, 1.0, uv.y < 0.5); }
    if (cp >= 0x2581u && cp <= 0x2587u) {
      return select(0.0, 1.0, uv.y >= 1.0 - f32(cp - 0x2580u) * 0.125);
    }
    if (cp == 0x2588u) { return 1.0; }
    if (cp >= 0x2589u && cp <= 0x258Fu) {
      return select(0.0, 1.0, uv.x <= 1.0 - f32(cp - 0x2588u) * 0.125);
    }
    if (cp == 0x2590u) { return select(0.0, 1.0, uv.x >= 0.5); }
    if (cp == 0x2591u) { return 0.25; }
    if (cp == 0x2592u) { return 0.50; }
    if (cp == 0x2593u) { return 0.75; }
    if (cp == 0x2594u) { return select(0.0, 1.0, uv.y <= 0.125); }
    if (cp == 0x2595u) { return select(0.0, 1.0, uv.x >= 0.875); }
    // Quadrant masks (UL=1, UR=2, LL=4, LR=8)
    var qm = 0u;
    switch (cp) {
      case 0x2596u: { qm = 4u; }
      case 0x2597u: { qm = 8u; }
      case 0x2598u: { qm = 1u; }
      case 0x2599u: { qm = 13u; }
      case 0x259Au: { qm = 9u; }
      case 0x259Bu: { qm = 7u; }
      case 0x259Cu: { qm = 11u; }
      case 0x259Du: { qm = 2u; }
      case 0x259Eu: { qm = 6u; }
      case 0x259Fu: { qm = 14u; }
      default: { qm = 0u; }
    }
    let bit = select(0u, 1u, uv.x >= 0.5) + select(0u, 2u, uv.y >= 0.5);
    return select(0.0, 1.0, (qm & (1u << bit)) != 0u);
  }

  // Powerline triangles, chevrons & rounded pill endcaps (U+E0B0..U+E0B7)
  if (cp == 0xE0B0u) {
    let edge = 1.0 - abs(uv.y - 0.5) * 2.0;
    return clamp((edge - uv.x) * cw * 0.9 + 0.5, 0.0, 1.0);
  }
  if (cp == 0xE0B2u) {
    let edge = abs(uv.y - 0.5) * 2.0;
    return clamp((uv.x - edge) * cw * 0.9 + 0.5, 0.0, 1.0);
  }
  if (cp == 0xE0B1u) {
    let d1 = sd_seg(px, vec2f(0.0, 0.0), vec2f(cw, c.y));
    let d2 = sd_seg(px, vec2f(cw, c.y), vec2f(0.0, ch));
    return clamp(0.5 - (min(d1, d2) - lw * 0.55), 0.0, 1.0);
  }
  if (cp == 0xE0B3u) {
    let d1 = sd_seg(px, vec2f(cw, 0.0), vec2f(0.0, c.y));
    let d2 = sd_seg(px, vec2f(0.0, c.y), vec2f(cw, ch));
    return clamp(0.5 - (min(d1, d2) - lw * 0.55), 0.0, 1.0);
  }
  if (cp == 0xE0B4u) {
    let r = length(vec2f(uv.x, (uv.y - 0.5) * 2.0));
    return clamp((1.0 - r) * cw * 0.85 + 0.5, 0.0, 1.0);
  }
  if (cp == 0xE0B6u) {
    let r = length(vec2f(1.0 - uv.x, (uv.y - 0.5) * 2.0));
    return clamp((1.0 - r) * cw * 0.85 + 0.5, 0.0, 1.0);
  }
  if (cp == 0xE0B5u) {
    let r = length(vec2f(uv.x, (uv.y - 0.5) * 2.0));
    return clamp(1.0 - abs(1.0 - r) * cw * 0.75, 0.0, 1.0);
  }
  if (cp == 0xE0B7u) {
    let r = length(vec2f(1.0 - uv.x, (uv.y - 0.5) * 2.0));
    return clamp(1.0 - abs(1.0 - r) * cw * 0.75, 0.0, 1.0);
  }

  // Rounded arcs ╭ ╮ ╯ ╰ (U+256D..U+2570)
  if (cp >= 0x256Du && cp <= 0x2570u) {
    let rad = min(c.x, c.y);
    let sx = select(1.0, -1.0, cp == 0x256Eu || cp == 0x256Fu); // center left for ╮ ╯
    let sy = select(1.0, -1.0, cp == 0x256Fu || cp == 0x2570u); // center up for ╯ ╰
    let ctr = c + vec2f(sx * rad, sy * rad);
    let in_arc = select(0.0, 1.0, (px.x - c.x) * sx >= 0.0 && (px.x - ctr.x) * sx <= 0.0 &&
                                   (px.y - c.y) * sy >= 0.0 && (px.y - ctr.y) * sy <= 0.0);
    let d_arc = abs(length(px - ctr) - rad) - lw * 0.5;
    let d_h = sd_seg(px, vec2f(ctr.x, c.y), vec2f(select(0.0, cw, sx > 0.0), c.y)) - lw * 0.5;
    let d_v = sd_seg(px, vec2f(c.x, ctr.y), vec2f(c.x, select(0.0, ch, sy > 0.0))) - lw * 0.5;
    let d = min(select(1e4, d_arc, in_arc > 0.5), min(d_h, d_v));
    return clamp(0.5 - d, 0.0, 1.0);
  }

  // Diagonals ╱ ╲ ╳ (U+2571..U+2573)
  if (cp == 0x2571u) {
    return clamp(0.5 - (sd_seg(px, vec2f(0.0, ch), vec2f(cw, 0.0)) - lw * 0.5), 0.0, 1.0);
  }
  if (cp == 0x2572u) {
    return clamp(0.5 - (sd_seg(px, vec2f(0.0, 0.0), vec2f(cw, ch)) - lw * 0.5), 0.0, 1.0);
  }
  if (cp == 0x2573u) {
    let d = min(sd_seg(px, vec2f(0.0, ch), vec2f(cw, 0.0)), sd_seg(px, vec2f(0.0, 0.0), vec2f(cw, ch)));
    return clamp(0.5 - (d - lw * 0.5), 0.0, 1.0);
  }

  // Box arms table
  if (cp >= 0x2500u && cp <= 0x257Fu) {
    let arms = box_arms(cp);
    var cov = 0.0;
    cov = max(cov, cov_arm(px, c, vec2f(c.x, 0.0), arms.x, lw));
    cov = max(cov, cov_arm(px, c, vec2f(cw, c.y), arms.y, lw));
    cov = max(cov, cov_arm(px, c, vec2f(c.x, ch), arms.z, lw));
    cov = max(cov, cov_arm(px, c, vec2f(0.0, c.y), arms.w, lw));
    return cov;
  }

  return -1.0;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  var color = in.bg.rgb;

  // OSC 133 error gutter bar cleanly on column 0 only
  if ((in.flags & 4096u) != 0u && in.col == 0u && in.local_uv.x < 0.16) {
    let err = unpack4x8unorm(u.error_abgr).rgb;
    color = mix(color, err, 0.94);
  }

  // Cursor behind glyph (focused block mode)
  let show_cur = in.is_cursor != 0u && u.blink_on != 0u;
  let cur_bg = unpack4x8unorm(u.cursor_bg_abgr).rgb;
  let cur_fg = unpack4x8unorm(u.cursor_fg_abgr).rgb;
  let block_cur = show_cur && u.focused != 0u && (u.cursor_style <= 2u);
  if (block_cur) {
    color = cur_bg;
  }

  var text_rgb = select(in.fg.rgb, cur_fg, block_cur);

  // Check procedural SDF geometry first (crisp Box Drawing, Block Elements, Shades, Powerline)
  let sdf = procedural_cov(in.cp, in.local_uv);
  if (sdf >= 0.0) {
    color = mix(color, text_rgb, sdf);
  } else if (in.glyph_active > 0.5) {
    let texel = textureSampleLevel(glyph_tex, glyph_sampler, in.atlas_uv, 0.0);
    let chroma = max(texel.r, max(texel.g, texel.b)) - min(texel.r, min(texel.g, texel.b));
    let sample_rgb = select(text_rgb, texel.rgb, chroma > 0.06);
    let weight = select(texel.a, clamp(texel.a * 1.12, 0.0, 1.0), (in.flags & 1u) != 0u);
    color = mix(color, sample_rgb, weight);
  }

  // Underline styles (bits 13..15: 1=single, 2=double, 3=curly, 4=dotted, 5=dashed) & OSC 8 links
  let ul_style = (in.flags >> 13u) & 7u;
  let has_ul = (in.flags & 8u) != 0u;
  let eff_ul = select(0u, select(ul_style, 1u, ul_style == 0u), has_ul || ul_style > 0u);
  if (eff_ul == 1u && in.local_uv.y > 0.87 && in.local_uv.y < 0.94) {
    color = mix(color, text_rgb, 0.92);
  } else if (eff_ul == 2u && ((in.local_uv.y > 0.82 && in.local_uv.y < 0.87) || (in.local_uv.y > 0.92 && in.local_uv.y < 0.97))) {
    color = mix(color, text_rgb, 0.92);
  } else if (eff_ul == 3u) {
    let wave = 0.89 + 0.055 * sin(in.local_uv.x * 12.56637);
    if (abs(in.local_uv.y - wave) < 0.045) {
      color = mix(color, text_rgb, 0.94);
    }
  } else if (eff_ul == 4u && in.local_uv.y > 0.87 && in.local_uv.y < 0.94 && fract(in.local_uv.x * 4.0) < 0.48) {
    color = mix(color, text_rgb, 0.9);
  } else if (eff_ul == 5u && in.local_uv.y > 0.87 && in.local_uv.y < 0.94 && in.local_uv.x < 0.68) {
    color = mix(color, text_rgb, 0.9);
  } else if ((in.flags & 1024u) != 0u) {
    let link_slot = (in.flags >> 18u) & 15u;
    let hovered = u.hover_link_slot > 0u && link_slot == u.hover_link_slot;
    let acc = unpack4x8unorm(u.accent_abgr).rgb;
    if (in.local_uv.y > 0.89 && in.local_uv.y < 0.96) {
      color = mix(color, acc, select(0.65, 1.0, hovered));
    }
  }

  // Overline (bit 16 = 65536) & Strikethrough (bit 7 = 128)
  if ((in.flags & 65536u) != 0u && in.local_uv.y < 0.07) {
    color = mix(color, text_rgb, 0.9);
  }
  if ((in.flags & 128u) != 0u && in.local_uv.y > 0.46 && in.local_uv.y < 0.53) {
    color = mix(color, text_rgb, 0.85);
  }

  // Focused bar/underline cursors OR unfocused hollow cursor outline
  if (in.is_cursor != 0u) {
    if (u.focused == 0u) {
      let bx = 1.5 / max(1.0, u.cell_px.x);
      let by = 1.5 / max(1.0, u.cell_px.y);
      if (in.local_uv.x < bx || in.local_uv.x > 1.0 - bx || in.local_uv.y < by || in.local_uv.y > 1.0 - by) {
        color = cur_bg;
      }
    } else if (u.blink_on != 0u) {
      if ((u.cursor_style == 5u || u.cursor_style == 6u) && in.local_uv.x < max(0.13, 2.0 / u.cell_px.x)) {
        color = cur_bg;
      } else if ((u.cursor_style == 3u || u.cursor_style == 4u) && in.local_uv.y > 0.86) {
        color = cur_bg;
      }
    }
  }

  return vec4f(color, 1.0);
}
