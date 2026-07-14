//! Platform proxy snapshots and updates.
//!
//! `sysproxy` parses Windows' `ProxyServer` value as a numeric `SocketAddr`.
//! Valid Windows configurations can instead contain a hostname or separate
//! per-protocol endpoints. Keep the raw registry values alongside the portable
//! fields so Germi can recognize its own canonical endpoint while restoring any
//! pre-existing Windows configuration byte-for-byte.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SystemProxyConfig {
    pub(crate) enable: bool,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) bypass: String,
    pub(crate) windows_raw: Option<WindowsProxyConfig>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsProxyConfig {
    pub(crate) enable: Option<u32>,
    pub(crate) server: Option<String>,
    pub(crate) bypass: Option<String>,
}

impl SystemProxyConfig {
    pub(crate) fn germi(port: u16) -> Self {
        Self {
            enable: true,
            host: "127.0.0.1".to_string(),
            port,
            bypass: "localhost,127.0.0.1,::1".to_string(),
            windows_raw: None,
        }
    }

    pub(crate) fn disabled_copy(&self) -> Self {
        let mut disabled = self.clone();
        disabled.enable = false;
        if let Some(raw) = disabled.windows_raw.as_mut() {
            raw.enable = Some(0);
        }
        disabled
    }
}

#[cfg(not(target_os = "windows"))]
impl From<sysproxy::Sysproxy> for SystemProxyConfig {
    fn from(proxy: sysproxy::Sysproxy) -> Self {
        Self {
            enable: proxy.enable,
            host: proxy.host,
            port: proxy.port,
            bypass: proxy.bypass,
            windows_raw: None,
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn portable(proxy: &SystemProxyConfig) -> sysproxy::Sysproxy {
    sysproxy::Sysproxy {
        enable: proxy.enable,
        host: proxy.host.clone(),
        port: proxy.port,
        bypass: proxy.bypass.clone(),
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn get() -> Result<SystemProxyConfig, String> {
    sysproxy::Sysproxy::get_system_proxy()
        .map(SystemProxyConfig::from)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn set(proxy: &SystemProxyConfig) -> Result<(), String> {
    portable(proxy)
        .set_system_proxy()
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_proxy_endpoint(server: &str) -> Option<(String, u16)> {
    let server = server.trim();
    // Germi writes one endpoint. A protocol map is a different configuration,
    // even when one entry happens to point at the same listener.
    if server.is_empty() || server.contains(['=', ';']) || server.contains("://") {
        return None;
    }
    let (host, port) = if let Some(rest) = server.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        (host, port)
    } else {
        let (host, port) = server.rsplit_once(':')?;
        if host.contains(':') {
            return None;
        }
        (host, port)
    };
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse().ok()?))
}

#[cfg(target_os = "windows")]
mod windows {
    use std::io;

    use winapi::shared::ntdef::NULL;
    use winapi::um::wininet::{
        InternetSetOptionA, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    };
    use winreg::types::FromRegValue;
    use winreg::{enums, RegKey};

    use super::{parse_windows_proxy_endpoint, SystemProxyConfig, WindowsProxyConfig};

    const SUB_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    fn optional_value<T: FromRegValue>(key: &RegKey, name: &str) -> io::Result<Option<T>> {
        match key.get_value(name) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn write_u32(key: &RegKey, name: &str, value: Option<u32>) -> io::Result<()> {
        match value {
            Some(value) => key.set_value(name, &value),
            None => delete_if_present(key, name),
        }
    }

    fn write_string(key: &RegKey, name: &str, value: Option<&str>) -> io::Result<()> {
        match value {
            Some(value) => key.set_value(name, &value),
            None => delete_if_present(key, name),
        }
    }

    fn delete_if_present(key: &RegKey, name: &str) -> io::Result<()> {
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn notify_windows() {
        // SAFETY: WinINet accepts null buffers for these two notification-only
        // options; this is the same documented call pattern used by `sysproxy`.
        unsafe {
            InternetSetOptionA(NULL, INTERNET_OPTION_SETTINGS_CHANGED, NULL, 0);
            InternetSetOptionA(NULL, INTERNET_OPTION_REFRESH, NULL, 0);
        }
    }

    pub(super) fn get() -> Result<SystemProxyConfig, String> {
        let hkcu = RegKey::predef(enums::HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey_with_flags(SUB_KEY, enums::KEY_READ)
            .map_err(|error| error.to_string())?;
        let raw = WindowsProxyConfig {
            enable: optional_value(&key, "ProxyEnable").map_err(|error| error.to_string())?,
            server: optional_value(&key, "ProxyServer").map_err(|error| error.to_string())?,
            bypass: optional_value(&key, "ProxyOverride").map_err(|error| error.to_string())?,
        };
        let endpoint = raw.server.as_deref().and_then(parse_windows_proxy_endpoint);
        let (host, port) = endpoint.unwrap_or_default();
        Ok(SystemProxyConfig {
            enable: raw.enable == Some(1),
            host,
            port,
            bypass: raw.bypass.clone().unwrap_or_default(),
            windows_raw: Some(raw),
        })
    }

    pub(super) fn set(proxy: &SystemProxyConfig) -> Result<(), String> {
        let hkcu = RegKey::predef(enums::HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey_with_flags(SUB_KEY, enums::KEY_SET_VALUE)
            .map_err(|error| error.to_string())?;
        if let Some(raw) = proxy.windows_raw.as_ref() {
            write_string(&key, "ProxyServer", raw.server.as_deref())
                .map_err(|error| error.to_string())?;
            write_string(&key, "ProxyOverride", raw.bypass.as_deref())
                .map_err(|error| error.to_string())?;
            write_u32(&key, "ProxyEnable", raw.enable).map_err(|error| error.to_string())?;
        } else {
            let server = format!("{}:{}", proxy.host, proxy.port);
            write_string(&key, "ProxyServer", Some(&server)).map_err(|error| error.to_string())?;
            write_string(&key, "ProxyOverride", Some(&proxy.bypass))
                .map_err(|error| error.to_string())?;
            write_u32(&key, "ProxyEnable", Some(u32::from(proxy.enable)))
                .map_err(|error| error.to_string())?;
        }
        notify_windows();
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn get() -> Result<SystemProxyConfig, String> {
    windows::get()
}

#[cfg(target_os = "windows")]
pub(crate) fn set(proxy: &SystemProxyConfig) -> Result<(), String> {
    windows::set(proxy)
}

#[cfg(test)]
mod tests {
    use super::parse_windows_proxy_endpoint;

    #[test]
    fn windows_proxy_parser_accepts_hostnames_and_bracketed_ipv6() {
        assert_eq!(
            parse_windows_proxy_endpoint("proxy.example:3128"),
            Some(("proxy.example".to_string(), 3128))
        );
        assert_eq!(
            parse_windows_proxy_endpoint("[::1]:8080"),
            Some(("::1".to_string(), 8080))
        );
    }

    #[test]
    fn windows_proxy_parser_does_not_collapse_protocol_maps() {
        assert_eq!(
            parse_windows_proxy_endpoint("http=proxy.example:80;https=secure.example:443"),
            None
        );
        assert_eq!(
            parse_windows_proxy_endpoint("http://proxy.example:3128"),
            None
        );
    }
}
