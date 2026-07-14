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
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use hudsucker::certificate_authority::RcgenAuthority;
use hudsucker::rcgen::{
    date_time_ymd, BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, PublicKeyData,
};
use hudsucker::rustls::crypto::aws_lc_rs;
use hudsucker::rustls::pki_types::{pem::PemObject, CertificateDer};

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
        if let Some(candidate) = Self::load(dir)? {
            // Re-assert owner-only perms so a key written by an older,
            // world-readable build is repaired in place on this upgraded load
            // (not only when the key is freshly written).
            repair_key_perms(&dir.join("germi-ca.key"));
            return Ok(candidate);
        }

        let ca = Self::generate()?;
        ca.save(dir)?;
        Ok(ca)
    }

    /// Read an existing, internally-consistent CA without creating, repairing,
    /// or replacing anything. Viewer processes use this path because they share
    /// the main process's app-data directory but must remain strictly read-only.
    pub fn load(dir: &Path) -> Result<Option<Self>> {
        let cert_path = dir.join("germi-ca.pem");
        let key_path = dir.join("germi-ca.key");
        let der_path = dir.join("germi-ca.der");

        if !(cert_path.exists() && key_path.exists() && der_path.exists()) {
            return Ok(None);
        }
        let candidate = Self {
            cert_pem: fs::read_to_string(&cert_path).context("read CA cert")?,
            key_pem: fs::read_to_string(&key_path).context("read CA key")?,
            cert_der: fs::read(&der_path).context("read CA der")?,
        };
        // Only reuse one internally-consistent identity. Constructing an
        // `Issuer` does not verify that the private key belongs to the PEM
        // certificate, and it does not inspect our separately exported DER.
        // A partially replaced set could therefore appear usable here but
        // mint leaf certificates no client trusts (or export stale DER).
        Ok(candidate.material_is_consistent().then_some(candidate))
    }

    /// Persist the CA material (cert PEM, key PEM, cert DER) under `dir`. Each file
    /// is staged to a temp path and renamed into place, so a crash mid-write can't
    /// leave a truncated file or a half-updated set. The private key is written
    /// owner-only (see [`write_key_private`]).
    pub fn save(&self, dir: &Path) -> Result<()> {
        create_ca_dir(dir).context("create CA dir")?;

        let cert = dir.join("germi-ca.pem");
        let key = dir.join("germi-ca.key");
        let der = dir.join("germi-ca.der");
        let cert_tmp = stage_file(dir, self.cert_pem.as_bytes(), false).context("write CA cert")?;
        let key_tmp = stage_file(dir, self.key_pem.as_bytes(), true).context("write CA key")?;
        let der_tmp = stage_file(dir, &self.cert_der, false).context("write CA der")?;

        // Renames are fast metadata ops, so the window where the three files could
        // disagree is far narrower than writing full contents between each.
        // `persist` performs a replacing move on Windows too; `fs::rename` cannot
        // replace an existing destination there, so every regeneration failed.
        cert_tmp
            .persist(&cert)
            .map_err(|error| error.error)
            .context("commit CA cert")?;
        key_tmp
            .persist(&key)
            .map_err(|error| error.error)
            .context("commit CA key")?;
        der_tmp
            .persist(&der)
            .map_err(|error| error.error)
            .context("commit CA der")?;
        Ok(())
    }

    /// The PEM certificate, exported DER, and signing key must all describe the
    /// same CA. `Issuer::from_ca_cert_pem` parses them but does not prove the
    /// certificate's public key matches the supplied private key.
    fn material_is_consistent(&self) -> bool {
        let Ok(pem_der) = CertificateDer::from_pem_slice(self.cert_pem.as_bytes()) else {
            return false;
        };
        if pem_der.as_ref() != self.cert_der {
            return false;
        }
        let Ok(key_pair) = KeyPair::from_pem(&self.key_pem) else {
            return false;
        };
        let Ok((remaining, certificate)) = x509_parser::parse_x509_certificate(&self.cert_der)
        else {
            return false;
        };
        remaining.is_empty()
            && certificate.public_key().raw == key_pair.subject_public_key_info()
            && self.to_authority().is_ok()
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

/// Stage one CA artifact beside its destination, fsyncing before commit. The
/// private key is explicitly owner-only on Unix; Windows relies on the per-user
/// app-data ACL (and `NamedTempFile`'s restrictive creation mode).
fn stage_file(
    dir: &Path,
    contents: &[u8],
    private: bool,
) -> std::io::Result<tempfile::NamedTempFile> {
    let mut staged = tempfile::NamedTempFile::new_in(dir)?;
    if private {
        tighten_key_perms(staged.path())?;
    }
    staged.write_all(contents)?;
    staged.as_file().sync_all()?;
    Ok(staged)
}

#[cfg(unix)]
fn tighten_key_perms(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn tighten_key_perms(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Create the CA directory owner-only (`0700`) from the start — closing the
/// window where a default-umask `0755` dir is briefly world-listable — and
/// tighten an already-existing dir too. Only the newly-created leaf gets the
/// mode, so existing parent app-data dirs keep their own permissions.
#[cfg(unix)]
fn create_ca_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
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

    #[test]
    fn save_replaces_an_existing_ca_identity() {
        let dir = std::env::temp_dir().join(format!("germi-ca-replace-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let first = CertAuthority::generate().unwrap();
        first.save(&dir).unwrap();
        let second = CertAuthority::generate().unwrap();
        second
            .save(&dir)
            .expect("an existing CA must be replaceable");

        let loaded = CertAuthority::load_or_generate(&dir).unwrap();
        assert_eq!(loaded.cert_der, second.cert_der);
        assert_eq!(loaded.key_pem, second.key_pem);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_regenerates_a_mismatched_certificate_and_key() {
        let dir =
            std::env::temp_dir().join(format!("germi-ca-mismatched-key-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let certificate = CertAuthority::generate().unwrap();
        certificate.save(&dir).unwrap();
        let other_key = CertAuthority::generate().unwrap();
        fs::write(dir.join("germi-ca.key"), &other_key.key_pem).unwrap();

        let loaded = CertAuthority::load_or_generate(&dir).unwrap();
        assert!(loaded.material_is_consistent());
        assert_ne!(
            loaded.cert_der, certificate.cert_der,
            "the mismatched on-disk identity must not be reused"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_regenerates_a_stale_der_export() {
        let dir = std::env::temp_dir().join(format!("germi-ca-stale-der-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let original = CertAuthority::generate().unwrap();
        original.save(&dir).unwrap();
        fs::write(dir.join("germi-ca.der"), b"not the PEM certificate").unwrap();

        let loaded = CertAuthority::load_or_generate(&dir).unwrap();
        assert!(loaded.material_is_consistent());
        assert_ne!(loaded.cert_der, b"not the PEM certificate");
        let _ = fs::remove_dir_all(&dir);
    }
}
