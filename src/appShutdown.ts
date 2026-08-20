interface AppShutdownOperations {
  closeSettings: () => Promise<void>;
  closeScripts: () => Promise<void>;
  closeRules: () => Promise<void>;
  flushRuleEditor: () => Promise<void>;
  flushRuleMutations: () => Promise<void>;
  flushHistory: () => Promise<void>;
  flushSettings: () => Promise<void>;
  flushScripts: () => Promise<void>;
  destroyMain: () => Promise<void>;
}

/** Settings gets first refusal so a dirty detached draft can keep the app alive. */
export async function runAppShutdown(operations: AppShutdownOperations): Promise<void> {
  await operations.closeSettings();
  await operations.closeScripts();
  await operations.closeRules();
  await operations.flushRuleEditor();
  await operations.flushRuleMutations();
  await operations.flushHistory();
  await operations.flushSettings();
  await operations.flushScripts();
  await operations.destroyMain();
}
