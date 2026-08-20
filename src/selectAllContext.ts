export type SelectAllContext = "native" | "list" | "none";

type SelectAllEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "target"
> & {
  composedPath?: () => EventTarget[];
};

const NATIVE_SELECT_ALL_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
  ".cm-editor",
  '[data-select-all="native"]',
  "dialog",
].join(",");

type ElementLike = {
  closest?: (selector: string) => Element | null;
  isContentEditable?: boolean;
  ownerDocument?: Document;
  parentElement?: Element | null;
  tagName?: string;
};

function asElement(value: EventTarget | Node | null | undefined): ElementLike | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as ElementLike;
  if (typeof candidate.closest === "function" || candidate.tagName) return candidate;
  return candidate.parentElement ?? null;
}

function eventElements(event: SelectAllEvent): ElementLike[] {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const elements = path.map(asElement).filter((el): el is ElementLike => el !== null);
  const target = asElement(event.target);
  if (target && !elements.includes(target)) elements.push(target);
  return elements;
}

function ownerDocument(elements: ElementLike[]): Document | null {
  for (const element of elements) {
    if (element.ownerDocument) return element.ownerDocument;
  }
  return typeof document === "undefined" ? null : document;
}

function closest(element: ElementLike | null, selector: string): Element | null {
  return element?.closest?.(selector) ?? null;
}

function isNativeContext(element: ElementLike | null): boolean {
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  ) {
    return true;
  }
  return closest(element, NATIVE_SELECT_ALL_SELECTOR) !== null;
}

function isOwner(element: ElementLike | null, owner: string | Element): boolean {
  if (!element) return false;
  if (typeof owner === "string") return closest(element, owner) !== null;
  return element === owner || owner.contains(element as Node);
}

/**
 * Decide who owns Ctrl/Cmd+A before a list-level handler prevents the browser's
 * default. The composed path covers editor internals (and retargeted webview /
 * shadow-DOM events); activeElement covers window handlers; the selection
 * anchors cover read-only body viewers, which deliberately remain plain text.
 */
export function selectAllContext(
  event: SelectAllEvent,
  listOwner: string | Element,
): SelectAllContext {
  if (
    event.defaultPrevented ||
    event.altKey ||
    !(event.ctrlKey || event.metaKey) ||
    event.key.toLowerCase() !== "a"
  ) {
    return "none";
  }

  const path = eventElements(event);
  const doc = ownerDocument(path);
  const active = asElement(doc?.activeElement);
  const selection = doc?.getSelection();
  const selectionElements = [asElement(selection?.anchorNode), asElement(selection?.focusNode)];

  if ([...path, active, ...selectionElements].some(isNativeContext)) return "native";
  if ([...path, active].some((element) => isOwner(element, listOwner))) return "list";
  return "none";
}
