//! Single-instance guard. A second non-viewer Germi must never touch the
//! shared app-data stores (`autoresponder.sqlite3`, `settings.json`,
//! `scripts.json`), so the primary instance holds an exclusive OS advisory
//! lock on `instance.lock` in the app-data dir. The OS releases advisory
//! locks when the owning process dies, so a crash can never leave a stale
//! lock behind (the reason to prefer this over a PID file).

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

const LOCK_FILE_NAME: &str = "instance.lock";

/// Keep this alive for the whole process lifetime; dropping it releases the
/// lock.
pub struct InstanceLock {
    _file: File,
}

pub enum GuardOutcome {
    /// This process is the primary instance.
    Held(InstanceLock),
    /// Viewer instances deliberately share the app-data dir (read-only rule
    /// store), so they bypass the guard.
    Skipped,
    /// Another non-viewer Germi already holds the lock.
    AlreadyRunning,
    /// The lock could not be set up. A writable instance must fail closed:
    /// proceeding would make the single-writer guarantee unknowable and could
    /// let two processes overwrite the shared settings/scripts/rules stores.
    Unavailable(io::Error),
}

pub fn guard(viewer: bool, app_data_dir: &Path) -> GuardOutcome {
    if viewer {
        return GuardOutcome::Skipped;
    }
    if let Err(e) = std::fs::create_dir_all(app_data_dir) {
        return GuardOutcome::Unavailable(e);
    }
    let file = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(app_data_dir.join(LOCK_FILE_NAME))
    {
        Ok(file) => file,
        Err(e) => return GuardOutcome::Unavailable(e),
    };
    match file.try_lock() {
        Ok(()) => GuardOutcome::Held(InstanceLock { _file: file }),
        Err(TryLockError::WouldBlock) => GuardOutcome::AlreadyRunning,
        Err(TryLockError::Error(e)) => GuardOutcome::Unavailable(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("germi-instance-{name}-{nonce}"))
    }

    #[test]
    fn first_acquire_succeeds_and_creates_lock_file() {
        let dir = test_dir("first");
        let outcome = guard(false, &dir);
        assert!(matches!(outcome, GuardOutcome::Held(_)));
        assert!(dir.join(LOCK_FILE_NAME).exists());
        drop(outcome);
        std::fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    // Each `guard` call opens a fresh file description, and flock (Linux) /
    // LockFileEx (Windows) scope conflicts to the open file description —
    // not the process — so this in-process double-acquire exercises the same
    // OS-level conflict a second Germi process would hit. It cannot prove
    // release-on-crash; that is the OS contract for advisory locks.
    #[test]
    fn second_acquire_while_held_is_already_running() {
        let dir = test_dir("held");
        let first = guard(false, &dir);
        assert!(matches!(first, GuardOutcome::Held(_)));
        let second = guard(false, &dir);
        assert!(matches!(second, GuardOutcome::AlreadyRunning));
        drop(first);
        std::fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn dropping_the_lock_allows_reacquire() {
        let dir = test_dir("drop");
        let first = guard(false, &dir);
        assert!(matches!(first, GuardOutcome::Held(_)));
        drop(first);
        let second = guard(false, &dir);
        assert!(matches!(second, GuardOutcome::Held(_)));
        drop(second);
        std::fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn viewer_mode_skips_guard_even_while_lock_is_held() {
        let dir = test_dir("viewer");
        let held = guard(false, &dir);
        assert!(matches!(held, GuardOutcome::Held(_)));
        assert!(matches!(guard(true, &dir), GuardOutcome::Skipped));
        drop(held);
        std::fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn viewer_mode_never_creates_the_lock_file() {
        let dir = test_dir("viewer-noio");
        assert!(matches!(guard(true, &dir), GuardOutcome::Skipped));
        assert!(!dir.exists());
    }
}
