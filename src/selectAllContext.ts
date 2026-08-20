export type SelectAllContext = "native" | "region" | "list" | "consume" | "none";

type SelectAllEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "preventDefault" | "target"
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
].join(",");

const REGION_SELECTOR = '[data-select-all="region"]';
const LIST_SELECTOR = '[data-select-all="list"]';

type ElementLike = {
  closest?: (selector: string) => Element | null;
  isContentEditable?: boolean;
  ownerDocument?: Document;
  parentElement?: Element | null;
  tagName?: string;
};

interface SelectAllResolution {
  context: SelectAllContext;
  document: Document | null;
  region: Element | null;
}

function asElement(value: EventTarget | Node | null | undefined): ElementLike | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as ElementLike;
  if (typeof candidate.closest === "function" || candidate.tagName) return candidate;
  return candidate.parentElement ?? null;
}

function eventElements(event: SelectAllEvent): ElementLike[] {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const elements = path
    .map(asElement)
    .filter((element): element is ElementLike => element !== null);
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

function firstClosest(elements: (ElementLike | null)[], selector: string): Element | null {
  for (const element of elements) {
    const match = closest(element, selector);
    if (match) return match;
  }
  return null;
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

function resolveSelectAll(
  event: SelectAllEvent,
  listOwner?: string | Element,
): SelectAllResolution {
  if (
    event.defaultPrevented ||
    event.altKey ||
    !(event.ctrlKey || event.metaKey) ||
    event.key.toLowerCase() !== "a"
  ) {
    return { context: "none", document: null, region: null };
  }

  const path = eventElements(event);
  const doc = ownerDocument(path);
  const active = asElement(doc?.activeElement);
  const selection = doc?.getSelection();
  const selectionElements = [asElement(selection?.anchorNode), asElement(selection?.focusNode)];
  const contextElements = [...path, active, ...selectionElements];

  if (contextElements.some(isNativeContext)) {
    return { context: "native", document: doc, region: null };
  }

  const region = firstClosest(contextElements, REGION_SELECTOR);
  if (region) return { context: "region", document: doc, region };
  if (firstClosest(contextElements, "dialog")) {
    return { context: "consume", document: doc, region: null };
  }

  const ownerElements = [...path, active];
  const ownsList = listOwner
    ? ownerElements.some((element) => isOwner(element, listOwner))
    : firstClosest(ownerElements, LIST_SELECTOR) !== null;
  return { context: ownsList ? "list" : "consume", document: doc, region: null };
}

/**
 * Decide who owns Ctrl/Cmd+A before a list-level handler prevents the browser's
 * default. The composed path covers editor internals (and retargeted webview /
 * shadow-DOM events); activeElement covers window handlers; selection anchors
 * identify clicked read-only text regions without making them fake textboxes.
 */
export function selectAllContext(
  event: SelectAllEvent,
  listOwner?: string | Element,
): SelectAllContext {
  return resolveSelectAll(event, listOwner).context;
}

/** Consume page-level select-all, or constrain it to an explicitly marked text
 * region. Native controls and focused list owners are deliberately left to
 * their own handlers. */
function handleContextualSelectAll(event: SelectAllEvent): boolean {
  const { context, document: doc, region } = resolveSelectAll(event);
  if (context !== "consume" && context !== "region") return false;

  event.preventDefault();
  const selection = doc?.getSelection();
  selection?.removeAllRanges();
  if (context === "region" && doc && selection && region) {
    const range = doc.createRange();
    range.selectNodeContents(region);
    selection.addRange(range);
  }
  return true;
}

/** Install the fallback once per React window root. Returns its cleanup. */
export function installContextualSelectAll(target: Window = window): () => void {
  const handler = (event: KeyboardEvent) => handleContextualSelectAll(event);
  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}
