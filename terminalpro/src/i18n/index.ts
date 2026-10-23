/**
 * Minimal, dependency-free i18n for the Workspace frontend.
 *
 * Design note: the English source string *is* the dictionary key. That single
 * decision lets one set of resources serve two very different callers:
 *
 *   1. our own files, which call `t("Refresh data")` explicitly;
 *   2. upstream OpenBB components, which we do not want to touch — the runtime
 *      dictionary (see ./autoTranslate.ts) reads the rendered English text and
 *      looks up the same table.
 *
 * Adding a language therefore means adding one file under ./locales, no code
 * change anywhere else.
 */
import { useSyncExternalStore } from "react";
import { zh, zhLower, zhPatterns } from "./locales/zh";

export type Locale = "en" | "zh";

export const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
];

const STORAGE_KEY = "openbb:locale";
const listeners = new Set<() => void>();

function readStored(): Locale | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "en" || value === "zh" ? value : null;
  } catch {
    return null;
  }
}

function detectLocale(): Locale {
  const stored = readStored();
  if (stored) return stored;
  const nav = (typeof navigator !== "undefined" && navigator.language) || "en";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let currentLocale: Locale = typeof window === "undefined" ? "en" : detectLocale();

export function getLocale(): Locale {
  return currentLocale;
}

export function isChinese(): boolean {
  return currentLocale === "zh";
}

/**
 * Switching language reloads the page on purpose: the runtime dictionary
 * patches live text nodes, and those patches cannot be undone reliably once
 * React has replaced the surrounding markup. A reload is both simpler and
 * provably correct, and language switching is a rare action.
 */
export function setLocale(locale: Locale, options: { reload?: boolean } = {}): void {
  const { reload = true } = options;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* storage disabled — the in-memory value still applies for this session */
  }
  if (locale === currentLocale) return;
  currentLocale = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }
  listeners.forEach((listener) => listener());
  if (reload && typeof window !== "undefined") {
    window.location.reload();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => "en" as Locale);
}

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

function lookup(text: string): string | undefined {
  if (currentLocale !== "zh") return undefined;
  if (Object.prototype.hasOwnProperty.call(zh, text)) return zh[text];
  return zhLower.get(text.toLowerCase());
}

/**
 * Translate a known key. Falls back to the English key itself, so a missing
 * entry degrades to readable English instead of a raw identifier.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const hit = lookup(key);
  return interpolate(hit ?? key, vars);
}

/** Translate a raw string coming from the DOM. Returns null when unknown. */
export function translateRaw(raw: string): string | null {
  if (currentLocale !== "zh") return null;
  const text = raw.trim();
  // Upper bound only guards against whole-page garbage (e.g. JSON dumps);
  // catalog descriptions legitimately run several hundred characters, and the
  // longest dataset document (Fama-French "US Portfolio returns") is ~4.3k.
  if (!text || text.length > 4500) return null;
  const hit = lookup(text);
  if (hit !== undefined) return hit;
  for (const rule of zhPatterns) {
    const match = text.match(rule.re);
    if (match) return rule.zh(match);
  }
  return null;
}

export function initI18n(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = currentLocale === "zh" ? "zh-CN" : "en";
  }
}
