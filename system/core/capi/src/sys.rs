//! Rust FFI bindings to the central Layer-0 Pure C, Assembly & WebAssembly Core (`C:\aphrody\src\include\ay\sys.h`).
//!
//! Subsystems use canonical upstream prefixes (`ay_*`, `drm_*`, `mesa_*`, `wl_*`, `xcb_*`, `xwm_*`,
//! `nt_*`, `wine_*`, `wasm_*`) so multi-million-LoC Linux, Freedesktop, ReactOS, Wine, and WebAssembly
//! trees integrate without global symbol collisions or vendor wrapper rewrites.

pub type NtStatus = i32;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AyCpuCaps {
    pub arch_id: u32,
    pub has_sse42: u32,
    pub has_avx2: u32,
    pub has_avx512f: u32,
    pub tsc_sample: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DrmModeFbCmd2 {
    pub fb_id: u32,
    pub width: u32,
    pub height: u32,
    pub pixel_format: u32,
    pub flags: u32,
    pub handles: [u32; 4],
    pub pitches: [u32; 4],
    pub offsets: [u32; 4],
    pub modifier: [u64; 4],
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WlBox {
    pub id: u32,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WasmModuleInfo {
    pub magic: u32,
    pub version: u32,
    pub section_mask: u32,
    pub section_count: u32,
    pub custom_section_count: u32,
    pub code_bytes: u32,
    pub export_section_bytes: u32,
    pub total_bytes: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct AyUiSpringState {
    pub value: f32,
    pub target: f32,
    pub velocity: f32,
    pub damping_ratio: f32,
    pub stiffness: f32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AyUiAdaptiveShell {
    pub window_class: u32,
    pub nav_kind: u32,
    pub margin_px: u32,
    pub gutter_px: u32,
    pub columns: u32,
    pub nav_rail_width_px: u32,
    pub bottom_bar_h_px: u32,
    pub content_x: u32,
    pub content_y: u32,
    pub content_w: u32,
    pub content_h: u32,
}

#[cfg(feature = "aysys-link")]
unsafe extern "C" {
    pub fn ay_sys_abi_version() -> u32;
    pub fn ay_rdtsc() -> u64;
    pub fn ay_fnv1a64(data: *const u8, len: usize) -> u64;
    pub fn ay_cpu_probe(out_caps: *mut AyCpuCaps) -> i32;
    pub fn drm_fb_cmd2_init(
        cmd: *mut DrmModeFbCmd2,
        width: u32,
        height: u32,
        fourcc: u32,
        modifier: u64,
        gem_handle: u32,
    ) -> i32;
    pub fn mesa_select_egl_platform(host_os: u32, has_wayland_fd: u32, has_drm_fd: u32) -> i32;
    pub fn wl_wire_encode(
        dst: *mut u8,
        cap: usize,
        object_id: u32,
        opcode: u16,
        payload_words: *const u32,
        word_count: u32,
    ) -> i32;
    pub fn wl_wire_decode_hdr(
        src: *const u8,
        len: usize,
        out_object_id: *mut u32,
        out_opcode: *mut u16,
        out_size: *mut u16,
    ) -> i32;
    pub fn wl_tile_compute(
        mode: u32,
        out_w: u32,
        out_h: u32,
        gap_px: u32,
        master_permille: u32,
        surface_ids: *const u32,
        count: u32,
        out_boxes: *mut WlBox,
    ) -> i32;
    pub fn nt_errno_to_ntstatus(neg_errno: i32) -> NtStatus;
    pub fn nt_status_to_errno(status: NtStatus) -> i32;
    pub fn wine_pack_server_req(
        dst64: *mut u8,
        req_opcode: i32,
        inline_payload: *const u8,
        inline_len: u32,
        reply_max: u64,
    ) -> i32;
    pub fn wasm_uleb128_decode(
        src: *const u8,
        cap: usize,
        out_val: *mut u64,
        out_len: *mut u32,
    ) -> i32;
    pub fn wasm_inspect_module(
        bytes: *const u8,
        len: usize,
        out_info: *mut WasmModuleInfo,
    ) -> i32;
    pub fn wasm_simd_dot_i32(
        a: *const i32,
        b: *const i32,
        count: usize,
        out_sum: *mut i64,
    ) -> i32;
    pub fn ay_ui_color_argb(theme_mode: u32, role_id: u32) -> u32;
    pub fn ay_ui_argb_to_abgr(argb: u32) -> u32;
    pub fn ay_ui_state_blend_argb(base_argb: u32, content_argb: u32, opacity_permille: u32) -> u32;
    pub fn ay_ui_spring_init(
        st: *mut AyUiSpringState,
        preset_id: u32,
        initial: f32,
        target: f32,
    ) -> i32;
    pub fn ay_ui_spring_step(st: *mut AyUiSpringState, dt_sec: f32) -> i32;
    pub fn ay_ui_window_class(width_dp: u32) -> u32;
    pub fn ay_ui_compute_shell(
        width_dp: u32,
        height_dp: u32,
        out_shell: *mut AyUiAdaptiveShell,
    ) -> i32;
    pub fn ay_ui_emit_m3_card_html(
        dst: *mut u8,
        cap: usize,
        title: *const u8,
        title_len: usize,
        body: *const u8,
        body_len: usize,
        cta_label: *const u8,
        cta_len: usize,
        cta_href: *const u8,
        href_len: usize,
    ) -> i32;
}
