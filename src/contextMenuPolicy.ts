const TEXT_INPUT_TYPES = new Set(["email", "number", "password", "search", "tel", "text", "url"]);

function asElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function isTextEditSurface(element: Element): boolean {
  const input = element.closest("input");
  if (input) return TEXT_INPUT_TYPES.has(input.type);
  if (element.closest("textarea, [role='textbox'], .cm-editor")) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

function hasTextEditSurface(event: Event): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) path.push(event.target);
  return path.some((target) => {
    const element = asElement(target);
    return element ? isTextEditSurface(element) : false;
  });
}

/**
 * Suppress the embedded browser's page menu on app chrome. Target-level
 * handlers get first refusal in the bubble phase, while genuine text editors
 * retain their native cut/copy/paste menu.
 */
export function installDefaultContextMenuBlocker(target: Window = window): () => void {
  const handler = (event: PointerEvent) => {
    if (event.defaultPrevented || hasTextEditSurface(event)) return;
    event.preventDefault();
  };
  target.addEventListener("contextmenu", handler);
  return () => target.removeEventListener("contextmenu", handler);
}
