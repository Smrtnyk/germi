import { expect, it, vi } from "vitest";

const RESOLVED_KEY = "germi.theme-cache";
const PREFERENCE_KEY = "germi.theme-preference-cache";

function restoreStorage(key: string, value: string | null) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

it("resolves cached System against the current OS before app startup", async () => {
  const priorResolved = localStorage.getItem(RESOLVED_KEY);
  const priorPreference = localStorage.getItem(PREFERENCE_KEY);
  const root = document.documentElement;
  const priorTheme = root.dataset.theme;
  const existingMeta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  const meta = existingMeta ?? document.createElement("meta");
  const priorMetaContent = meta.content;
  if (!existingMeta) {
    meta.name = "color-scheme";
    document.head.append(meta);
  }

  localStorage.setItem(RESOLVED_KEY, "dark");
  localStorage.setItem(PREFERENCE_KEY, "system");
  root.dataset.theme = "dark";
  meta.content = "dark";

  const originalMatchMedia = window.matchMedia.bind(window);
  const matchMedia = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) =>
      query === "(prefers-color-scheme: dark)"
        ? ({ matches: false } as MediaQueryList)
        : originalMatchMedia(query),
    );
  const script = document.createElement("script");

  try {
    await new Promise<void>((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("theme-init.js failed to load"));
      script.src = `/theme-init.js?test=${Date.now()}`;
      document.head.append(script);
    });

    expect(root.dataset.theme).toBe("light");
    expect(meta.content).toBe("light");
  } finally {
    script.remove();
    matchMedia.mockRestore();
    restoreStorage(RESOLVED_KEY, priorResolved);
    restoreStorage(PREFERENCE_KEY, priorPreference);
    if (priorTheme === undefined) delete root.dataset.theme;
    else root.dataset.theme = priorTheme;
    if (existingMeta) meta.content = priorMetaContent;
    else meta.remove();
  }
});
