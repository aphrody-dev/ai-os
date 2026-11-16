//! `aphrody_jni` native JNI (Java 25+) bridge exposing `aphrody-core` (Tree-sitter, BLAKE3,
//! directory index) and `aphrody-re` (binary triage, x86-64 disasm, Ghidra P-Code/Pseudo-C,
//! MinGW-REA, `.pdata`, and Lua 5.2) to `com.aphrody.core.AphrodyNative`.

use std::path::{Path, PathBuf};

use aphrody_core::{SupportedLanguage, TreeSitterEngine, hash, index};
use aphrody_re::{
    ReEngine, SreAnalyzeOptions, analyze_binary_bytes, analyze_pe_mingw_rea, audit_lua52_bytecode,
    disassemble_x64, is_lua52_bytecode, pdata, transcode_lua52_bytecode, triage_bounded,
};
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jboolean, jint, jlong};
use jni::{Env, EnvUnowned, jni_str};

fn throw_runtime(env: &mut Env<'_>, msg: impl AsRef<str>) -> jni::errors::Error {
    let jmsg = jni::strings::JNIString::from(msg.as_ref());
    let _ = env.throw_new(jni_str!("java/lang/RuntimeException"), &jmsg);
    jni::errors::Error::JavaException
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_abiVersion<'local>(
    _unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
) -> jint {
    1
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_languages<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let csv = SupportedLanguage::ALL
                .iter()
                .map(SupportedLanguage::name)
                .collect::<Vec<_>>()
                .join(",");
            JString::from_str(env, csv)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_parseJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    path: JString<'local>,
    content: JString<'local>,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let p = path.to_string();
            let c = content.to_string();
            let summary = TreeSitterEngine::parse_file(Path::new(&p), &c)
                .ok_or_else(|| throw_runtime(env, format!("unsupported language: {p}")))?;
            let json = serde_json::to_string(&summary).map_err(|e| throw_runtime(env, e.to_string()))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_queryJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    path: JString<'local>,
    content: JString<'local>,
    query: JString<'local>,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let p = path.to_string();
            let c = content.to_string();
            let q = query.to_string();
            let lang = TreeSitterEngine::detect_language(Path::new(&p))
                .ok_or_else(|| throw_runtime(env, format!("unsupported language: {p}")))?;
            let matches = TreeSitterEngine::query_sexpr(lang, &c, &q)
                .map_err(|e| throw_runtime(env, e))?;
            let json = serde_json::to_string(&matches).map_err(|e| throw_runtime(env, e.to_string()))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_blake3Hex<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    data: JByteArray<'local>,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let bytes = env.convert_byte_array(&data)?;
            let hex = hash::blake3_hex(&bytes);
            JString::from_str(env, hex)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_indexJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    root: JString<'local>,
    includes: JString<'local>,
    follow_ignore: jboolean,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let r = root.to_string();
            let inc_raw = includes.to_string();
            let inc: Vec<PathBuf> = inc_raw
                .split(['\n', ';'])
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .collect();
            let idx = index::build(Path::new(&r), &inc, follow_ignore);
            let json = serde_json::to_string(&idx).map_err(|e| throw_runtime(env, e.to_string()))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_reTriageJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    data: JByteArray<'local>,
    strings_limit: jint,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let bytes = env.convert_byte_array(&data)?;
            let rep = triage_bounded(&bytes, strings_limit.max(0) as usize)
                .map_err(|e| throw_runtime(env, e.to_string()))?;
            let json = serde_json::to_string(&rep).map_err(|e| throw_runtime(env, e.to_string()))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_reAuditBytesJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    label: JString<'local>,
    data: JByteArray<'local>,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let lbl = label.to_string();
            let bytes = env.convert_byte_array(&data)?;
            let rep = ReEngine::audit_bytes(&bytes, &lbl)
                .map_err(|e| throw_runtime(env, e.to_string()))?;
            let json = serde_json::to_string(&rep).map_err(|e| throw_runtime(env, e.to_string()))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_reDisasmJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    data: JByteArray<'local>,
    rip: jlong,
    limit: jint,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let bytes = env.convert_byte_array(&data)?;
            let insns = disassemble_x64(&bytes, rip as u64, limit.max(1) as usize);
            let json = serde_json::to_string(&insns).map_err(|e| throw_runtime(env, e.to_string()))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_rePdataJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    data: JByteArray<'local>,
    max_roots: jint,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let bytes = env.convert_byte_array(&data)?;
            let json = pdata::inspect_json(&bytes, max_roots.max(1) as u32)
                .map_err(|e| throw_runtime(env, e))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_reGhidraDecompileBytesJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    data: JByteArray<'local>,
    max_functions: jint,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let bytes = env.convert_byte_array(&data)?;
            let opts = SreAnalyzeOptions {
                max_functions: max_functions.max(1) as usize,
                ..SreAnalyzeOptions::default()
            };
            let rep = analyze_binary_bytes("memory.bin", &bytes, &opts)
                .map_err(|e| throw_runtime(env, e.to_string()))?;
            let json = serde_json::to_string(&rep).map_err(|e| throw_runtime(env, e.to_string()))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_reMingwAuditJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    path: JString<'local>,
    max_functions: jint,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let p = path.to_string();
            let rep = analyze_pe_mingw_rea(Path::new(&p), max_functions.max(16) as usize)
                .map_err(|e| throw_runtime(env, e.to_string()))?;
            let json = serde_json::to_string(&rep).map_err(|e| throw_runtime(env, e.to_string()))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_reLua52AuditJson<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    data: JByteArray<'local>,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            let bytes = env.convert_byte_array(&data)?;
            if !is_lua52_bytecode(&bytes) {
                return Err(throw_runtime(env, "input is not Lua 5.2 bytecode"));
            }
            let rep = audit_lua52_bytecode(&bytes)
                .map_err(|e| throw_runtime(env, e.to_string()))?;
            let json = serde_json::to_string(&rep).map_err(|e| throw_runtime(env, e.to_string()))?;
            JString::from_str(env, json)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aphrody_core_AphrodyNative_reLua52Transcode<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    data: JByteArray<'local>,
    target_int: jint,
    target_sizet: jint,
) -> JByteArray<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JByteArray<'local>> {
            let bytes = env.convert_byte_array(&data)?;
            let out = transcode_lua52_bytecode(&bytes, target_int as u8, target_sizet as u8)
                .map_err(|e| throw_runtime(env, e.to_string()))?;
            env.byte_array_from_slice(&out)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}
