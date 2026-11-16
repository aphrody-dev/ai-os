// SPDX-License-Identifier: Apache-2.0
// Byte compatibility with @aphrody/vault: an AYV1 envelope sealed by the TS package (master key
// = 32 x 0x07, factice payload) opens here; age round trip with a fresh X25519 identity.
use aphrody_vault::{ayv1, envelope, valid_name};

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn opens_ts_vector() {
    let env = hex(include_str!("vectors/ayv1-master07.hex").trim());
    let plain = ayv1::open(&[7u8; 32], "doc|json|interop", &env).unwrap();
    assert_eq!(&plain[..], br#"{"factice":"interop-vector"}"#);
    assert!(ayv1::open(&[7u8; 32], "doc|json|other", &env).is_err());
    assert!(ayv1::open(&[8u8; 32], "doc|json|interop", &env).is_err());
}

#[test]
fn seal_open_round_trip() {
    let env = ayv1::seal(&[1u8; 32], "a", b"factice").unwrap();
    assert_eq!(&ayv1::open(&[1u8; 32], "a", &env).unwrap()[..], b"factice");
}

#[test]
fn age_round_trip() {
    let id = age::x25519::Identity::generate();
    let r = id.to_public().to_string();
    use age::secrecy::ExposeSecret;
    let text = id.to_string();
    let env = envelope::encrypt_blocking(b"factice", &[r]).unwrap();
    assert_eq!(&envelope::decrypt_blocking(&env, text.expose_secret()).unwrap()[..], b"factice");
}

#[test]
fn names() {
    assert!(valid_name("VAULT_PROOF_TOKEN"));
    assert!(!valid_name("../x"));
    assert!(!valid_name(""));
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(target_os = "linux")]
async fn store_round_trip_when_systemd_creds_works() {
    let dir = std::env::temp_dir().join(format!("vault-rs-{}", std::process::id()));
    unsafe { std::env::set_var("ENV_KIT_SECRET_DIR", &dir) };
    if aphrody_vault::set_secret("VAULT_RS_TEST", b"factice").await.is_ok() {
        assert_eq!(&aphrody_vault::get_secret("VAULT_RS_TEST").await.unwrap()[..], b"factice");
        assert!(aphrody_vault::list_secrets().await.unwrap().contains(&"VAULT_RS_TEST".to_string()));
    }
    let _ = std::fs::remove_dir_all(dir);
}
