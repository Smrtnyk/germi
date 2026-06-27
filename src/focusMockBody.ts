/**
 * Focus the mock response-body editor (CodeMirror) in the Autoresponder — the
 * F2 shortcut's target.
 *
 * The panel may have just been revealed (tab switch / un-collapse) and the
 * editor is a lazy-loaded chunk, so its `.cm-content` can be a few frames away;
 * even once mounted it can't take focus until its pane is actually visible.
 * Poll a short while until the element exists AND focus lands, then stop. If no
 * respond rule with a textual body is open there is nothing to focus, so give
 * up quietly after the budget. `.cm-body` is unique to this editor.
 */
export function focusMockResponseBody(): void {
  let tries = 0;
  const attempt = () => {
    const el = document.querySelector<HTMLElement>(".cm-body .cm-content");
    if (el) {
      el.focus();
      if (document.activeElement === el) return;
    }
    if (tries++ < 60) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
