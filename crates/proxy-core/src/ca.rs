//! Root CA management.
//!
//! Germi generates one long-lived root CA the first time it runs and persists it
//! (PEM cert, PEM key, DER cert) under the app data dir. hudsucker then mints a
//! short-lived leaf certificate per intercepted host, signed by this CA. The
//! user must install + trust the CA once for HTTPS interception to work — that's
//! the single biggest onboarding step (see README).
//!
//! The CA is persisted (not regenerated per run) on purpose: regenerating would
//! force the user to re-trust it every launch and invalidate cached leaf certs.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use hudsucker::certificate_authority::RcgenAuthority;
use hudsucker::rcgen::{
    date_time_ymd, BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use hudsucker::rustls::crypto::aws_lc_rs;

/// In-memory handle to the root CA material.
#[derive(Clone)]
pub struct CertAuthority {
    pub cert_pem: String,
    pub key_pem: String,
    pub cert_der: Vec<u8>,
}

impl CertAuthority {
    /// Generate a fresh self-signed root CA (ECDSA P-256 by default in rcgen).
    pub fn generate() -> Result<Self> {
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        params
            .distinguished_name
            .push(DnType::CommonName, "Germi Proxy CA");
        params
            .distinguished_name
            .push(DnType::OrganizationName, "Germi");
        params.not_before = date_time_ymd(2024, 1, 1);
        params.not_after = date_time_ymd(2034, 1, 1);

        let key_pair = KeyPair::generate().context("generate CA key pair")?;
        let cert = params.self_signed(&key_pair).context("self-sign CA cert")?;

        Ok(Self {
            cert_pem: cert.pem(),
            key_pem: key_pair.serialize_pem(),
            cert_der: cert.der().to_vec(),
        })
    }

    /// Load the CA from `dir`, generating + persisting it on first run.
    pub fn load_or_generate(dir: &Path) -> Result<Self> {
        let cert_path = dir.join("germi-ca.pem");
        let key_path = dir.join("germi-ca.key");
        let der_path = dir.join("germi-ca.der");

        if cert_path.exists() && key_path.exists() && der_path.exists() {
            // Re-assert owner-only perms so a key written by an older,
            // world-readable build is repaired in place on this upgraded load
            // (not only when the key is freshly written).
            repair_key_perms(&key_path);
            return Ok(Self {
                cert_pem: fs::read_to_string(&cert_path).context("read CA cert")?,
                key_pem: fs::read_to_string(&key_path).context("read CA key")?,
                cert_der: fs::read(&der_path).context("read CA der")?,
            });
        }

        create_ca_dir(dir).context("create CA dir")?;
        let ca = Self::generate()?;
        fs::write(&cert_path, &ca.cert_pem).context("write CA cert")?;
        write_key_private(&key_path, &ca.key_pem).context("write CA key")?;
        fs::write(&der_path, &ca.cert_der).context("write CA der")?;
        Ok(ca)
    }

    /// Persist the CA material (cert PEM, key PEM, cert DER) under `dir`. The
    /// private key is written owner-only (see [`write_key_private`]).
    pub fn save(&self, dir: &Path) -> Result<()> {
        create_ca_dir(dir).context("create CA dir")?;
        fs::write(dir.join("germi-ca.pem"), &self.cert_pem).context("write CA cert")?;
        write_key_private(&dir.join("germi-ca.key"), &self.key_pem).context("write CA key")?;
        fs::write(dir.join("germi-ca.der"), &self.cert_der).context("write CA der")?;
        Ok(())
    }

    /// Build the hudsucker authority that mints per-host leaf certs.
    pub fn to_authority(&self) -> Result<RcgenAuthority> {
        let key_pair = KeyPair::from_pem(&self.key_pem).context("parse CA key pem")?;
        let issuer =
            Issuer::from_ca_cert_pem(&self.cert_pem, key_pair).context("parse CA cert pem")?;
        // Cache up to 1000 minted leaf certs (keyed by host) to avoid re-signing.
        Ok(RcgenAuthority::new(
            issuer,
            1_000,
            aws_lc_rs::default_provider(),
        ))
    }
}

/// Write the CA *private key* with owner-only permissions. The root key signs
/// every leaf cert the proxy mints, so on a shared host it must not be readable
/// by other users (whoever reads it can MITM anyone who trusts the Germi CA).
#[cfg(unix)]
fn write_key_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents.as_bytes())?;
    // `mode` only applies on creation; tighten explicitly so a key written by an
    // older (world-readable) build is repaired in place too.
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn write_key_private(path: &Path, contents: &str) -> std::io::Result<()> {
    // On Windows the per-user app-data dir ACL protects the key.
    fs::write(path, contents)
}

/// Create the CA directory owner-only (`0700`) from the start — closing the
/// window where a default-umask `0755` dir is briefly world-listable — and
/// tighten an already-existing dir too. Only the newly-created leaf gets the
/// mode, so existing parent app-data dirs keep their own permissions.
#[cfg(unix)]
fn create_ca_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn create_ca_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
}

/// Re-assert owner-only perms on an existing key file (best-effort).
#[cfg(unix)]
fn repair_key_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn repair_key_perms(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn ca_key_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("germi-ca-perm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        CertAuthority::load_or_generate(&dir).unwrap();
        let mode = fs::metadata(dir.join("germi-ca.key"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "CA key must be readable only by owner");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn load_repairs_world_readable_key() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("germi-ca-repair-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        CertAuthority::load_or_generate(&dir).unwrap();
        let key = dir.join("germi-ca.key");
        // Simulate an old, world-readable key left on disk by an earlier build.
        fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).unwrap();
        // A subsequent load (fast path) must repair it back to owner-only.
        CertAuthority::load_or_generate(&dir).unwrap();
        let mode = fs::metadata(&key).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "load must repair a world-readable key");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_produces_valid_material() {
        let ca = CertAuthority::generate().unwrap();
        assert!(ca.cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(ca.key_pem.contains("PRIVATE KEY"));
        assert!(!ca.cert_der.is_empty());
        // Round-trips into a usable hudsucker authority (exercises rustls crypto).
        ca.to_authority().expect("build authority");
    }

    #[test]
    fn load_or_generate_persists_and_reloads() {
        let dir = std::env::temp_dir().join(format!("germi-ca-test-{}", std::process::id()));
        let a = CertAuthority::load_or_generate(&dir).unwrap();
        let b = CertAuthority::load_or_generate(&dir).unwrap();
        // Second load returns the same persisted material.
        assert_eq!(a.cert_pem, b.cert_pem);
        let _ = fs::remove_dir_all(&dir);
    }
}
