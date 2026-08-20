{
  // settings.json remains authoritative. These caches exist only so the root
  // color-scheme is correct before the Tauri bridge and React bundle start.
  try {
    const requested = new URLSearchParams(location.search).get("theme");
    const resolved = localStorage.getItem("germi.theme-cache");
    const preference = localStorage.getItem("germi.theme-preference-cache");
    const system = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const theme =
      requested === "light" || requested === "dark"
        ? requested
        : preference === "system"
          ? system()
          : preference === "light" || preference === "dark"
            ? preference
            : resolved === "light" || resolved === "dark"
              ? resolved
              : system();
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="color-scheme"]').content = theme;
  } catch {
    // Storage can be unavailable in hardened webviews; the durable sync fixes
    // the theme before React renders, with the static dark canvas as a fallback.
  }
}
