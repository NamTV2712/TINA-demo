use anyhow::{bail, Result};
use ring::hmac;
use std::{env, fs, path::PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub fn read_secret() -> Result<String> {
    let home =
        env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("TINA Desktop auth is unavailable"))?;
    let path = PathBuf::from(home)
        .join("Library/Application Support/local.tina.capture/desktop-ingest-token");
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| anyhow::anyhow!("TINA Desktop auth is unavailable"))?;
    if !metadata.file_type().is_file() {
        bail!("TINA Desktop auth is unavailable");
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        bail!("TINA Desktop auth file permissions are not private");
    }
    let secret = fs::read_to_string(path)
        .map_err(|_| anyhow::anyhow!("TINA Desktop auth is unavailable"))?
        .trim()
        .to_string();
    if decode_hex(&secret).is_none_or(|bytes| bytes.len() != 32) {
        bail!("TINA Desktop auth is invalid");
    }
    Ok(secret)
}

pub fn verify_proof(secret_hex: &str, challenge: &str, proof_hex: &str) -> bool {
    let (Some(secret), Some(proof)) = (decode_hex(secret_hex), decode_hex(proof_hex)) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, &secret);
    hmac::verify(&key, challenge.as_bytes(), &proof).is_ok()
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digits = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(digits, 16).ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::verify_proof;

    #[test]
    fn verifies_the_server_proof_for_the_current_challenge() {
        let secret = "0b".repeat(20);
        let proof = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";

        assert!(verify_proof(&secret, "Hi There", proof));
        assert!(!verify_proof(&secret, "different challenge", proof));
        assert!(!verify_proof(&secret, "Hi There", "not a proof"));
    }
}
