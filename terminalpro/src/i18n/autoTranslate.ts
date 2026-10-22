/**
 * Runtime dictionary layer.
 *
 * Upstream OpenBB components render English literals directly in JSX. Rather
 * than rewriting ~700 files (and fighting the upstream merge on every release),
 * we patch the rendered DOM: text nodes whose *entire* trimmed content matches
 * a dictionary key get replaced, plus a few user-visible attributes.
 *
 * Safety rules, in order of importance:
 *   1. whole-node exact match only — never substring replacement, so a company
 *      name or a headline never gets rewritten mid-sentence;
 *   2. data surfaces are hard-skipped (table cells, headers, code editors,
 *      SVG text), because column names are part of the API contract;
 *   3. unknown text is left untouched, so a missing entry degrades to English.
 */
import { isChinese, translateRaw } from "./index";

const SKIP_TAGS = new Set([
  "TD",
  "TH",
  "PRE",
  "CODE",
  "SCRIPT",
  "STYLE",
  "SVG",
  "TEXTAREA",
  "INPUT",
  "CANVAS",
  "KBD",
  "SAMP",
]);

/** Data surfaces and third-party editors must never be rewritten. */
const SKIP_SELECTOR = [
  "td",
  "th",
  ".ag-cell",
  ".ag-header-cell-text",
  ".ag-row",
  ".monaco-editor",
  "[role='gridcell']",
  "[role='columnheader']",
  "[data-no-i18n]",
  ".no-i18n",
  "[contenteditable='true']",
].join(",");

const ATTRS = ["placeholder", "title", "aria-label"] as const;

const skipCache = new WeakMap<Element, boolean>();

function shouldSkip(element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName)) return true;
  const cached = skipCache.get(element);
  if (cached !== undefined) return cached;
  const skip = Boolean(element.closest(SKIP_SELECTOR));
  skipCache.set(element, skip);
  return skip;
}

function translateTextNode(node: Text): void {
  const parent = node.parentElement;
  if (!parent || shouldSkip(parent)) return;
  const raw = node.nodeValue;
  if (!raw) return;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 120) return;
  const translated = translateRaw(trimmed);
  if (translated === null || translated === trimmed) return;
  const start = raw.indexOf(trimmed);
  node.nodeValue = raw.slice(0, start) + translated + raw.slice(start + trimmed.length);
}

function translateAttributes(element: Element): void {
  if (shouldSkip(element)) return;
  for (const attr of ATTRS) {
    const value = element.getAttribute(attr);
    if (!value) continue;
    const translated = translateRaw(value);
    if (translated !== null && translated !== value) {
      element.setAttribute(attr, translated);
    }
  }
}

/**
 * Walks one subtree with an explicit stack (TreeWalker has no subtree bound, so
 * it would run to the end of the document) and prunes data surfaces early.
 */
function translateSubtree(root: Element): void {
  const stack: Node[] = [root];
  let budget = 4000;
  while (stack.length && budget-- > 0) {
    const node = stack.pop() as Node;
    if (node.nodeType === Node.TEXT_NODE) {
      translateTextNode(node as Text);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (shouldSkip(node as Element)) continue;
    const children = (node as Element).childNodes;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i]);
    }
  }
}

const pending = new Set<Node>();
let scheduled = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    const batch = Array.from(pending);
    pending.clear();
    for (const node of batch) {
      if (!node.isConnected) continue;
      if (node.nodeType === Node.TEXT_NODE) {
        translateTextNode(node as Text);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        translateAttributes(element);
        translateSubtree(element);
      }
    }
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    setTimeout(run, 16);
  }
}

function enqueue(node: Node): void {
  pending.add(node);
  if (pending.size > 400) {
    // A large subtree arrived at once (route change, big table). Rescanning
    // node by node would be slower than one pass over the container.
    pending.clear();
    const container = document.body;
    if (container) pending.add(container);
  }
  schedule();
}

let observer: MutationObserver | null = null;

export function startAutoTranslate(): void {
  if (typeof window === "undefined" || !document.body) return;
  if (!isChinese() || observer) return;

  const root = document.body;
  translateAttributes(root);
  translateSubtree(root);

  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        enqueue(record.target);
      } else if (record.type === "characterData") {
        if (record.target.nodeType === Node.TEXT_NODE) enqueue(record.target);
      } else {
        for (const node of Array.from(record.addedNodes)) {
          if (
            node.nodeType === Node.TEXT_NODE ||
            node.nodeType === Node.ELEMENT_NODE
          ) {
            enqueue(node);
          }
        }
      }
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["placeholder", "title", "aria-label"],
  });
}

export function stopAutoTranslate(): void {
  observer?.disconnect();
  observer = null;
}
