/** Flush the sole in-memory scripts editor before destroying its OS window. A
 * failed flush is a cancelled close, never permission to lose edits. */
export async function closeScriptsEditorWindow(
  flush: () => Promise<void>,
  destroy: () => Promise<void>,
): Promise<boolean> {
  try {
    await flush();
  } catch {
    return false;
  }
  try {
    await destroy();
  } catch {
    return false;
  }
  return true;
}

/** Complete every editor save before allowing destruction of the main window.
 * Detached scripts first and docked scripts last minimizes the interval in
 * which another scripts edit could arrive after its flush acknowledgement. */
export async function closeMainWindowWithEditors(
  flushDetachedScripts: () => Promise<void>,
  flushDetachedRules: () => Promise<void>,
  flushInlineRule: () => Promise<void>,
  flushSettings: () => Promise<void>,
  flushDockedScripts: () => Promise<void>,
  destroy: () => Promise<void>,
): Promise<void> {
  await flushDetachedScripts();
  await flushDetachedRules();
  await flushInlineRule();
  await flushSettings();
  await flushDockedScripts();
  await destroy();
}
