//! Process-launch argument classification and the one-shot capture hand-off.
//!
//! Windows and Linux deliver file-association opens as command-line arguments.
//! Keep the path in Rust until the main webview asks for it: setup can run well
//! before React installs listeners, so emitting a startup event would be lossy.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct LaunchOptions {
    pub viewer: bool,
    pub capture: Option<PathBuf>,
}

/// Classify the OS-provided argument vector without joining or re-splitting it.
/// Quoted Windows paths therefore remain one argument even when they contain
/// spaces. Only the first supported capture is opened; unrelated arguments are
/// left to their owners and flags can never be mistaken for files.
pub fn options_from_args(args: impl IntoIterator<Item = OsString>) -> LaunchOptions {
    let mut options = LaunchOptions::default();
    for arg in args.into_iter().skip(1) {
        if arg == OsStr::new("--viewer") {
            options.viewer = true;
            continue;
        }
        if arg.to_string_lossy().starts_with('-') || options.capture.is_some() {
            continue;
        }
        let path = PathBuf::from(arg);
        if is_capture_path(&path) {
            options.capture = Some(path);
        }
    }
    options
}

fn is_capture_path(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("har") || ext.eq_ignore_ascii_case("saz"))
}

/// A launch path lives here until the frontend has installed its flow stream
/// and completed its initial snapshot. `take` makes webview reloads and React
/// Strict Mode harmless: the OS request is handled at most once.
#[derive(Debug, Default)]
pub struct PendingCapture(Mutex<Option<PathBuf>>);

impl PendingCapture {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self(Mutex::new(path))
    }

    pub fn take(&self) -> Result<Option<PathBuf>, String> {
        self.0
            .lock()
            .map(|mut path| path.take())
            .map_err(|_| "launch capture mailbox is unavailable".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn viewer_and_capture_with_spaces_are_classified() {
        let options = options_from_args(args(&[
            r"C:\Program Files\Germi\germi.exe",
            "--viewer",
            r"C:\Users\Milan\HTTP captures\checkout flow.HAR",
        ]));

        assert!(options.viewer);
        assert_eq!(
            options.capture,
            Some(PathBuf::from(
                r"C:\Users\Milan\HTTP captures\checkout flow.HAR"
            ))
        );
    }

    #[test]
    fn viewer_flag_is_preserved_without_a_capture() {
        let options = options_from_args(args(&["germi", "--viewer", "notes.txt"]));

        assert!(options.viewer);
        assert_eq!(options.capture, None);
    }

    #[test]
    fn executable_flags_and_unrelated_extensions_are_ignored() {
        let options = options_from_args(args(&[
            r"C:\fake.har",
            "--trace.har",
            r"C:\captures\notes.txt",
            r"C:\captures\session.sAz",
        ]));

        assert!(!options.viewer);
        assert_eq!(
            options.capture,
            Some(PathBuf::from(r"C:\captures\session.sAz"))
        );
    }

    #[test]
    fn first_supported_capture_wins() {
        let options = options_from_args(args(&[
            "germi",
            "/captures/first.har",
            "/captures/second.saz",
        ]));

        assert_eq!(options.capture, Some(PathBuf::from("/captures/first.har")));
    }

    #[test]
    fn pending_capture_is_consumed_once() {
        let expected = PathBuf::from("/captures/launch.har");
        let pending = PendingCapture::new(Some(expected.clone()));

        assert_eq!(pending.take().expect("first take"), Some(expected));
        assert_eq!(pending.take().expect("second take"), None);
    }
}
