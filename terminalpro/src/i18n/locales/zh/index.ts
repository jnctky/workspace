import { bulk } from "./bulk";
import { core } from "./core";
import { pages } from "./pages";
import { patterns } from "./patterns";
import { toasts } from "./toasts";
import { widgets } from "./widgets";

/**
 * Flat dictionary keyed by the English source string.
 * Later spreads intentionally do not override earlier ones for shared keys —
 * keep one canonical translation per English string across all files.
 */
export const zh: Record<string, string> = {
  ...core,
  ...pages,
  ...toasts,
  ...bulk,
  ...widgets,
};

/**
 * Case-insensitive fallback index: upstream components are inconsistent
 * ("Refresh data" vs "Refresh Data"), and both should resolve.
 */
export const zhLower: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const [english, chinese] of Object.entries(zh)) {
    const key = english.toLowerCase();
    if (!index.has(key)) index.set(key, chinese);
  }
  return index;
})();

export const zhPatterns = patterns;
