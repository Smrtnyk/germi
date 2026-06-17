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
            return Ok(Self {
                cert_pem: fs::read_to_string(&cert_path).context("read CA cert")?,
                key_pem: fs::read_to_string(&key_path).context("read CA key")?,
                cert_der: fs::read(&der_path).context("read CA der")?,
            });
        }

        fs::create_dir_all(dir).context("create CA dir")?;
        let ca = Self::generate()?;
        fs::write(&cert_path, &ca.cert_pem).context("write CA cert")?;
        fs::write(&key_path, &ca.key_pem).context("write CA key")?;
        fs::write(&der_path, &ca.cert_der).context("write CA der")?;
        Ok(ca)
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

#[cfg(test)]
mod tests {
    use super::*;

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
