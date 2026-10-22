import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ds/atoms/Button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ds/atoms/DropdownMenu";
import Icon from "~/components/Icon";
import type { Group } from "~/components/types";
import {
  DEFAULT_SYMBOLS,
  OPENBB_PLATFORM_URL,
} from "~/components/Widgets/TVWidgets/AdvancedWidget";
import { useTabContext } from "~/lib/contexts/TabContext";
import { useAppStore, useShallowAppStore, type Widget } from "~/lib/state/app";
import { COLORS, cn, triggerCustomEvent, uuidv4 } from "~/lib/utils";

/**
 * Dashboard-wide ticker switcher.
 *
 * The workspace has no built-in "one ticker for every widget" control: each
 * widget instance keeps its own `symbol` value in `storage.params`, so changing
 * an instrument means opening every parameter panel in turn. This bar rewrites
 * that value on all selected instances and lets the existing dashboard diff
 * sync push the change to the server.
 */

const LAST_TICKER_KEY = "openbb:bulk-symbol:last-ticker";

type Mode = "replace" | "append";

type Row = {
  widget: Widget;
  label: string;
  symbol: string;
  multiple: boolean;
  isNews: boolean;
  /** The global-news instance: its basket is off limits for bulk retargeting. */
  isMacroNews: boolean;
  /** TradingView chart: no `symbol` param, follows every Apply through storage. */
  isChart: boolean;
  /** Widgets without a `symbol` param (other than the chart) can't be retargeted. */
  selectable: boolean;
};

function paramList(widget: Widget): Record<string, any>[] {
  return Array.isArray(widget.params) ? (widget.params as Record<string, any>[]) : [];
}

function readSymbol(widget: Widget): string {
  const stored = (widget.storage as { params?: Record<string, unknown> } | undefined)
    ?.params?.symbol;
  if (typeof stored === "string" && stored.trim()) return stored.trim();
  const param = paramList(widget).find((p) => p?.paramName === "symbol");
  return typeof param?.value === "string" ? param.value.trim() : "";
}

/** comma-joined tickers, original order first, duplicates dropped. */
export function mergeSymbols(current: string, add: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of `${current},${add}`.split(",")) {
    const sym = raw.trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out.join(",");
}

/** The global-news widget owns this basket; bulk retargeting must never touch it. */
const MACRO_BASKET = ["SPY", "QQQ", "DIA", "TLT", "GLD", "USO", "UUP"];
/** A company-news feed stays readable with a handful of names. */
const NEWS_SYMBOL_LIMIT = 4;

/**
 * Venues for the ETFs that have no profile row on the local platform. Without
 * these the TradingView embed would receive NASDAQ:SPY and render nothing.
 */
const ETF_EXCHANGES: Record<string, string> = {
  SPY: "AMEX",
  DIA: "AMEX",
  GLD: "AMEX",
  USO: "AMEX",
  UUP: "AMEX",
  IWM: "AMEX",
  XLF: "AMEX",
  XLE: "AMEX",
  QQQ: "NASDAQ",
  TLT: "NASDAQ",
};

type TvSymbol = { label: string; value: string };

/**
 * True for the macro-news instance. It is recognised either by name (the two
 * instances share one widgetId) or by a symbol list that is mostly the basket.
 */
export function isMacroNewsWidget(name: string, symbol: string): boolean {
  const lower = (name ?? "").toLowerCase();
  if (lower.includes("宏观") || lower.includes("global") || lower.includes("macro")) return true;
  const symbols = (symbol ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length < 3) return false;
  return symbols.filter((s) => MACRO_BASKET.includes(s)).length >= 3;
}

/**
 * News feeds are multi-symbol on purpose: a replace puts the new ticker first
 * and keeps the watch list behind it, instead of collapsing to a single name.
 */
export function newsSymbols(current: string, ticker: string, mode: Mode): string {
  const merged = mode === "append" ? mergeSymbols(current, ticker) : mergeSymbols(ticker, current);
  return merged.split(",").slice(0, NEWS_SYMBOL_LIMIT).join(",");
}

/**
 * TradingView symbols carry the venue ("NASDAQ:SNDK"). Resolve it from the
 * list the chart already knows, then a small ETF table (the platform has no
 * profile rows for ETFs), then the platform's own exchange field.
 */
export async function resolveChartSymbol(
  ticker: string,
  available?: TvSymbol[],
): Promise<string> {
  const upper = ticker.trim().toUpperCase();
  if (!upper) return "";
  const known = available?.find((s) => (s.label ?? "").toUpperCase() === upper);
  if (known?.value?.includes(":")) return known.value;
  const etf = ETF_EXCHANGES[upper];
  if (etf) return `${etf}:${upper}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 900);
  try {
    const res = await fetch(
      `${OPENBB_PLATFORM_URL}/api/v1/equity/profile?symbol=${encodeURIComponent(upper)}&provider=nasdaq`,
      { signal: ctrl.signal },
    );
    if (res.ok) {
      const json = await res.json();
      const exchange = String(json?.results?.[0]?.exchange ?? "").toUpperCase();
      if (exchange.startsWith("NASDAQ")) return `NASDAQ:${upper}`;
      if (exchange.includes("AMERICAN") || exchange.startsWith("AMEX")) return `AMEX:${upper}`;
      if (exchange.startsWith("NYSE")) return `NYSE:${upper}`;
    }
  } catch {
    // platform offline or slow: fall through to the default venue
  } finally {
    clearTimeout(timer);
  }
  return `NASDAQ:${upper}`;
}

/** Chart storage with the new symbol, keeping it selectable in the chart menu. */
export function chartStorage(widget: Widget, tvValue: string, label: string) {
  const stored = (widget.storage as { availableSymbols?: TvSymbol[] } | undefined)
    ?.availableSymbols;
  const base = Array.isArray(stored) && stored.length ? stored : DEFAULT_SYMBOLS;
  const list = base.some((s) => s.value === tvValue)
    ? base
    : [...base, { label, value: tvValue }].slice(-16);
  return { ...(widget.storage ?? {}), selectedSymbol: tvValue, availableSymbols: list };
}

/** Ticker-shaped tokens that are really words, kept in titles. */
const NOT_TICKERS = new Set([
  "US",
  "EU",
  "UK",
  "AI",
  "IPO",
  "GDP",
  "CPI",
  "PPI",
  "FED",
  "ETF",
  "EPS",
  "PE",
  "ROE",
  "ROI",
  "YOY",
  "QOQ",
  "TTM",
  "CEO",
  "CFO",
  "SEC",
  "ESG",
  "FCF",
  "DCF",
]);

/**
 * Drops the instrument from a widget title ("GOOGL 财务比率" → "财务比率").
 * Titles are user-facing labels, not data: keeping the ticker in them means the
 * label drifts out of date on every retarget, so it is simply removed.
 */
export function stripSymbolPrefix(name: string): string {
  const match = name.match(/^([A-Z0-9^][A-Z0-9.^]{0,5})\s+(\S.*)$/);
  if (!match) return name;
  const [, token, rest] = match;
  if (NOT_TICKERS.has(token)) return name;
  return rest.trim() || name;
}

/** Copy of the widget with `symbol` rewritten in both stored and declared params. */
export function withSymbol(widget: Widget, value: string): Widget {
  const storage = {
    ...(widget.storage ?? {}),
    params: {
      ...((widget.storage as { params?: Record<string, unknown> } | undefined)?.params ?? {}),
      symbol: value,
    },
  };
  const currentMainTicker = (widget.data as { mainTicker?: Record<string, unknown> } | undefined)
    ?.mainTicker;
  return {
    ...widget,
    storage,
    params: paramList(widget).map((p) =>
      p?.paramName === "symbol" ? { ...p, value } : p,
    ),
    // mainTicker feeds the ticker chip and the query key; a stale one keeps the
    // widget bound to the previous symbol even after params change.
    ...(currentMainTicker
      ? { data: { ...widget.data, mainTicker: { ...currentMainTicker, symbol: value } } }
      : {}),
    // Same nudge the parameter panel uses so tables refetch immediately
    // instead of serving rows from the previous ticker until staleTime expires.
    refreshQuery: Date.now(),
  } as Widget;
}

/**
 * Dashboard group that drives this widget's `symbol` param, if any.
 *
 * Only `endpointParam` groups are created by this bar, and they are always
 * symbol groups, so the type check is enough — no need to resolve groupById
 * back to a param name (which differs between widget instances).
 */
export function symbolGroupId(widget: Widget, groups: Group[]): string | null {
  const ids = Object.values(
    (widget.paramGroups ?? {}) as Record<string, string | null | undefined>,
  );
  for (const id of ids) {
    const group = groups.find((g) => g.id === id);
    if (group?.type === "endpointParam") return group.id ?? null;
  }
  return null;
}

function nextGroupName(groups: Group[]): string {
  let index = groups.length + 1;
  while (groups.some((g) => g.name === `Group ${index}`)) index += 1;
  return `Group ${index}`;
}

function nextGroupColor(groups: Group[]): string {
  const used = new Set(groups.map((g) => g.color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[groups.length % COLORS.length];
}

/**
 * New dashboard-level group driving the `symbol` endpoint param.
 *
 * `groupById` falls back to the param name: these instances ship the symbol
 * param without a `groupById`, and the grouping code keys `paramGroups` by this
 * id. Leaving it undefined writes the literal key "undefined", which the badge
 * logic (which looks up by paramName) then never finds. The resolver matches on
 * `groupById === id || paramName === id`, so the param name works everywhere.
 */
export function buildSymbolGroup(
  widget: Widget,
  groups: Group[],
  value: string,
): Group | null {
  const symbolParam = paramList(widget).find((p) => p?.paramName === "symbol");
  if (!symbolParam) return null;
  return {
    id: uuidv4(),
    name: nextGroupName(groups),
    color: nextGroupColor(groups),
    type: "endpointParam",
    groupById: symbolParam.groupById ?? symbolParam.paramName ?? "symbol",
    value,
  } as unknown as Group;
}

/**
 * Gives a symbol group a concrete `groupById`. Groups created before this
 * existed carry `undefined`, which `addToWidgetParamGroups` turns into the
 * literal key "undefined"; the param name resolves just as well and keeps the
 * badge lookup working.
 */
export function promotedGroup(group: Group, widget?: Widget): Group {
  if (group.type !== "endpointParam" || group.groupById) return group;
  const paramName = widget
    ? paramList(widget).find((p) => p?.paramName === "symbol")?.paramName
    : undefined;
  return { ...group, groupById: paramName ?? "symbol" } as Group;
}

export default function BulkSymbolBar() {
  const { currentTab, tabId, layouts, isShared } = useTabContext();

  const widgets = useShallowAppStore(
    (state) => state.items?.[tabId]?.data?.widgets as Widget[] | undefined,
  );
  const updateWidget = useShallowAppStore((state) => state.updateWidget);
  const debounceSaveDashboards = useShallowAppStore(
    (state) => state.debounceSaveDashboards,
  );
  // Store slices can be missing while a dashboard is still loading, so the
  // group list is normalised instead of assumed to be an array.
  const storedGroups = useShallowAppStore(
    (state) => state.items?.[tabId]?.data?.groups as Group[] | undefined,
  );
  const groups = useMemo(
    () => (Array.isArray(storedGroups) ? storedGroups : []),
    [storedGroups],
  );
  const addGroup = useShallowAppStore((state) => state.addGroup);
  const updateGroup = useShallowAppStore((state) => state.updateGroup);
  const setWidgetGroupId = useShallowAppStore((state) => state.setWidgetGroupId);
  const deleteGroup = useShallowAppStore((state) => state.deleteGroup);

  const rows = useMemo<Row[]>(() => {
    const list = Array.isArray(widgets) ? widgets : [];
    const onGrid = new Set((layouts ?? []).map((l) => l.i));
    // The grid only holds the instances of the tab being displayed, so it is the
    // most precise scope available. Fall back to the inner-tab marker when the
    // layout has not loaded yet (deep links, empty dashboards).
    const scoped = onGrid.size
      ? list.filter((w) => onGrid.has(w.id))
      : list.filter((w) => !w.innerTab || w.innerTab === currentTab);
    return scoped.map((w) => {
      const symbolParam = paramList(w).find((p) => p?.paramName === "symbol");
      const symbol = readSymbol(w);
      const isNews = (w.widgetId ?? "").startsWith("news_");
      return {
        widget: w,
        label: w.name || w.widgetId || w.id,
        symbol,
        multiple: symbolParam?.multiple === true,
        isNews,
        isMacroNews: isNews && isMacroNewsWidget(w.name ?? "", symbol),
        isChart: (w.widgetId ?? "") === "tv_charting",
        selectable: !!symbolParam,
      };
    });
  }, [widgets, layouts, currentTab]);

  const rowsKey = useMemo(() => rows.map((r) => r.widget.id).join("|"), [rows]);

  const [ticker, setTicker] = useState(
    () => globalThis.localStorage?.getItem(LAST_TICKER_KEY) ?? "",
  );
  const [mode, setMode] = useState<Mode>("replace");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initializedFor, setInitializedFor] = useState("");

  // Default selection follows the dashboard: everything retargetable, minus the
  // macro-news basket (a built-in list of index/rates ETFs that must stay put).
  useEffect(() => {
    if (initializedFor === rowsKey) return;
    setSelected(
      new Set(rows.filter((r) => r.selectable && !r.isMacroNews).map((r) => r.widget.id)),
    );
    setInitializedFor(rowsKey);
  }, [rowsKey, initializedFor, rows]);

  // Titles are labels, not data: strip a leading ticker from every widget on the
  // page once, so dashboards created before this change lose the prefix without
  // needing another Apply.
  const cleanedTitlesFor = useRef("");
  useEffect(() => {
    if (!rows.length || cleanedTitlesFor.current === rowsKey) return;
    cleanedTitlesFor.current = rowsKey;
    let cleaned = 0;
    for (const row of rows) {
      const stripped = stripSymbolPrefix(row.widget.name ?? "");
      if (stripped === row.widget.name) continue;
      const next = { ...row.widget, name: stripped } as Widget;
      updateWidget(tabId, next);
      triggerCustomEvent(`updateWidget-${row.widget.id}`, (prev?: Widget) => ({
        ...(prev ?? row.widget),
        name: stripped,
      }) as Widget);
      cleaned += 1;
    }
    if (cleaned) debounceSaveDashboards();
  }, [rowsKey, rows, tabId, updateWidget, debounceSaveDashboards]);

  // Groups created by an earlier build carry no groupById, so `paramGroups` got
  // the literal key "undefined". Promote the group to the param name and rebind
  // its members once; the badge lookup and future unlinks then line up.
  const migratedFor = useRef("");
  useEffect(() => {
    const staleGroups = groups.filter(
      (g) =>
        g.type === "endpointParam" &&
        !g.groupById &&
        rows.some((r) => Object.values(r.widget.paramGroups ?? {}).includes(g.id)),
    );
    if (!staleGroups.length) return;
    const key = `${tabId}:${staleGroups.map((g) => g.id).join(",")}`;
    if (migratedFor.current === key) return;
    migratedFor.current = key;
    for (const group of staleGroups) {
      const members = rows.filter((r) =>
        Object.values(r.widget.paramGroups ?? {}).includes(group.id),
      );
      const promoted = promotedGroup(group, members[0]?.widget);
      // No dependent-group cascade here: only the group's key changes, the
      // symbol value stays the same.
      updateGroup(tabId, group.id, { ...promoted, value: group.value }, false);
      for (const member of members) {
        // Drop every key pointing at the group, then re-add it under the param
        // name — `setWidgetGroupId` removes by value, so stale keys go with it.
        setWidgetGroupId(tabId, member.widget.id, promoted, true);
        setWidgetGroupId(tabId, member.widget.id, promoted);
      }
    }
    debounceSaveDashboards();
    triggerCustomEvent("bulkSymbolApplied", { migratedGroups: true });
  }, [groups, rows, tabId, updateGroup, setWidgetGroupId, debounceSaveDashboards]);

  const selectableCount = rows.filter((r) => r.selectable).length;
  const selectedCount = rows.filter((r) => selected.has(r.widget.id)).length;

  const selectedRows = rows.filter((r) => selected.has(r.widget.id));
  const selectedGroupIds = Array.from(
    new Set(
      selectedRows
        .map((r) => symbolGroupId(r.widget, groups))
        .filter((id): id is string => !!id),
    ),
  );
  // A group only counts as "the" group of the selection when every selected
  // widget points at the same one — a partial selection must not offer Unlink.
  const linkedGroupId =
    selectedRows.length > 0 &&
    selectedGroupIds.length === 1 &&
    selectedRows.every((r) => symbolGroupId(r.widget, groups) === selectedGroupIds[0])
      ? selectedGroupIds[0]
      : null;
  const linkedGroup = linkedGroupId
    ? groups.find((g) => g.id === linkedGroupId)
    : undefined;

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /**
   * Binds the selected widgets to one dashboard-level group so the native
   * grouping engine drives their `symbol` from then on (change any member and
   * the rest follow), or unbinds them again.
   */
  function toggleLink() {
    const targets = selectedRows;
    if (!targets.length) {
      toast.error("No widget selected");
      return;
    }

    if (linkedGroup) {
      for (const row of targets) {
        setWidgetGroupId(tabId, row.widget.id, linkedGroup, true);
      }
      const stillLinked = (
        useAppStore.getState().items?.[tabId]?.data?.widgets ?? []
      ).filter((w) => Object.values(w.paramGroups ?? {}).includes(linkedGroup.id));
      // An empty group would keep showing up in the grouping menu forever.
      if (!stillLinked.length) deleteGroup(tabId, linkedGroup.id);
      debounceSaveDashboards();
      triggerCustomEvent("bulkSymbolApplied", { unlinked: true });
      toast.success(`Unlinked ${targets.length} widgets from ${linkedGroup.name}`);
      return;
    }

    const value =
      ticker.trim().replace(/\s+/g, "").toUpperCase() ||
      targets[0].symbol ||
      "";
    if (!value) {
      toast.error("Enter a ticker first");
      return;
    }

    // Reuse a symbol group that already exists on the dashboard instead of
    // piling up one group per click.
    const knownGroupId = targets
      .map((r) => symbolGroupId(r.widget, groups))
      .find((id): id is string => !!id);
    let group =
      groups.find((g) => g.type === "endpointParam" && g.id === knownGroupId) ??
      groups.find((g) => g.type === "endpointParam");

    if (!group) {
      const created = buildSymbolGroup(targets[0].widget, groups, value);
      if (!created) {
        toast.error("Selected widgets have no symbol param");
        return;
      }
      addGroup(tabId, created);
      group = created;
    } else {
      const promoted = promotedGroup(group, targets[0].widget);
      if (promoted.groupById !== group.groupById || group.value !== value) {
        updateGroup(tabId, group.id, { ...promoted, value });
        group = { ...promoted, value } as Group;
      }
    }

    for (const row of targets) {
      setWidgetGroupId(tabId, row.widget.id, group);
    }
    debounceSaveDashboards();
    // Binding rewrites each widget's params from the group value, so the header
    // pills must be rebuilt from the store (they cache their own display state).
    triggerCustomEvent("bulkSymbolApplied", { linked: true });
    toast.success(
      `Linked ${targets.length} widget${targets.length > 1 ? "s" : ""} to ${group.name} → ${value} — changing one now updates all`,
    );
  }

  async function apply() {
    const value = ticker.trim().replace(/\s+/g, "").toUpperCase();
    if (!value) {
      toast.error("Enter a ticker first");
      return;
    }
    const targets = rows.filter((r) => selected.has(r.widget.id));
    if (!targets.length) {
      toast.error("No widget selected");
      return;
    }

    let changed = 0;
    const singleOnly: string[] = [];
    const skippedMacro: string[] = [];
    let newsChanged = 0;

    // Two writers are needed, exactly like the Copilot widget-update path:
    // the store write covers unmounted widgets (and drives the dashboard
    // diff), while the DOM event reaches the mounted instance — each widget
    // keeps a live copy of its params and never re-reads the store on its own.
    const write = (widget: Widget, retarget: (w: Widget) => Widget) => {
      updateWidget(tabId, retarget(widget));
      triggerCustomEvent(`updateWidget-${widget.id}`, (prev?: Widget) => {
        const updated = retarget(prev ?? widget);
        triggerCustomEvent(
          `updateQueryParams-${widget.id}`,
          (updated.storage as { params?: Record<string, unknown> } | undefined)?.params ?? {},
        );
        return updated;
      });
    };

    // Retargeting also drops the instrument from the title: a label like
    // "GOOGL 财务比率" would otherwise need rewriting on every switch.
    const unlabel = (widget: Widget, nextSymbol: string): Widget => {
      const updated = withSymbol(widget, nextSymbol);
      const stripped = stripSymbolPrefix(widget.name ?? "");
      return stripped === widget.name ? updated : ({ ...updated, name: stripped } as Widget);
    };

    for (const row of targets) {
      if (row.isChart) continue; // handled below, it has no symbol param
      if (row.isMacroNews) {
        skippedMacro.push(row.label);
        continue;
      }

      // Company news keeps its watch list: the new ticker goes first (replace)
      // or lands behind the existing names (append), never collapsing to one.
      if (row.isNews) {
        const next = newsSymbols(row.symbol, value, mode);
        const retargeted = unlabel(row.widget, next);
        if (next === row.symbol && retargeted.name === row.widget.name) continue;
        write(row.widget, (w) => unlabel(w, next));
        if (next !== row.symbol) newsChanged += 1;
        changed += 1;
        continue;
      }

      // Appending to a single-symbol endpoint would request e.g. "AAPL,NVDA"
      // where the endpoint only accepts one — fall back to replacing instead.
      const canAppend = mode === "append" && row.multiple;
      if (mode === "append" && !row.multiple) singleOnly.push(row.label);
      const next = canAppend ? mergeSymbols(row.symbol, value) : value;

      const retargeted = unlabel(row.widget, next);
      const symbolChanged = next !== row.symbol;
      // A stale title still needs cleaning even when the ticker already matches,
      // otherwise dashboards set up before this change keep the prefix forever.
      const renamed = retargeted.name !== row.widget.name;
      if (!symbolChanged && !renamed) continue;

      write(row.widget, (w) => unlabel(w, next));
      changed += 1;
    }

    // The TradingView embed has no params and sits outside the grouping engine:
    // its symbol lives in storage, in TV's own "VENUE:TICKER" form. Follow the
    // ticker on every Apply so "one ticker for the page" stays true.
    let chartUpdated = false;
    const chartRow = rows.find((r) => r.isChart);
    if (chartRow) {
      const current = (chartRow.widget.storage as { selectedSymbol?: string } | undefined)
        ?.selectedSymbol;
      const tvValue = await resolveChartSymbol(
        value,
        (chartRow.widget.storage as { availableSymbols?: TvSymbol[] } | undefined)
          ?.availableSymbols,
      );
      if (tvValue && tvValue !== current) {
        const storage = chartStorage(chartRow.widget, tvValue, value);
        write(chartRow.widget, (w) => ({ ...w, storage } as Widget));
        chartUpdated = true;
      }
    }

    // A linked widget reads its symbol from the group, so a stale group value
    // would snap it back on the next group change. Keep the group in step.
    if (mode === "replace") {
      const boundGroupIds = new Set(
        targets
          .filter((r) => !r.isNews && !r.isChart)
          .map((r) => symbolGroupId(r.widget, groups))
          .filter((id): id is string => !!id),
      );
      for (const id of boundGroupIds) {
        const group = groups.find((g) => g.id === id);
        if (group && group.value !== value) {
          updateGroup(tabId, group.id, { ...group, value });
        }
      }
    }

    globalThis.localStorage?.setItem(LAST_TICKER_KEY, value);
    debounceSaveDashboards();
    // Header widgets cache their own display state, so remount them from the
    // freshly written store values instead of waiting for a page reload.
    if (changed || chartUpdated) triggerCustomEvent("bulkSymbolApplied", { ticker: value });

    if (!changed && !chartUpdated) {
      toast.info("Nothing to update — selected widgets already use this ticker");
      return;
    }
    const notes: string[] = [];
    if (newsChanged) notes.push(`${newsChanged} news feed${newsChanged > 1 ? "s" : ""} kept watch list`);
    if (chartUpdated) notes.push("chart switched");
    if (skippedMacro.length) notes.push(`skipped ${skippedMacro.length} macro news`);
    if (singleOnly.length) {
      notes.push(
        `${singleOnly.length} single-symbol widget${singleOnly.length > 1 ? "s" : ""} replaced instead`,
      );
    }
    const note = notes.length ? ` (${notes.join(", ")})` : "";
    toast.success(`Updated ${changed} widget${changed > 1 ? "s" : ""} → ${value}${note}`);
  }

  if (isShared) return null;

  return (
    <div className="sticky top-0 z-20 mb-1 flex h-11 items-center gap-2 border-b border-general-border-primary bg-general-bg-primary/95 px-3 backdrop-blur">
      <span className="body-xs-medium shrink-0 text-ds-text-caption">Ticker</span>
      <input
        value={ticker}
        onChange={(e) => setTicker(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
        }}
        placeholder="e.g. SNDK"
        spellCheck={false}
        autoComplete="off"
        className="body-xs-regular h-8 w-[150px] shrink-0 rounded-sm border border-general-border-primary bg-input-field-bg px-2 font-mono text-general-label-hover uppercase transition placeholder:font-sans placeholder:text-ds-text-caption hover:border-general-border-primary focus:border-alert-informative focus:outline-hidden"
      />

      <div className="flex shrink-0 items-center overflow-hidden rounded-sm border border-general-border-primary">
        {(["replace", "append"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            title={
              m === "replace"
                ? "Overwrite each widget's symbol with the ticker above"
                : "Append the ticker to each widget's existing symbols (multi-symbol widgets only)"
            }
            className={cn(
              "body-xs-medium h-8 px-2.5 capitalize transition",
              mode === m
                ? "bg-main-100 text-btn-primary-label"
                : "bg-transparent text-general-label hover:bg-btn-ghost-bg-hover",
            )}
          >
            {m}
          </button>
        ))}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" className="shrink-0 gap-1">
            Widgets {selectedCount}/{selectableCount}
            <Icon id="chevron-down" className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60vh] w-[320px] overflow-y-auto">
          <DropdownMenuLabel className="flex items-center justify-between gap-2">
            <span>Apply to</span>
            <span className="flex gap-2">
              <button
                type="button"
                className="body-xs-medium text-alert-informative hover:underline"
                onClick={() =>
                  setSelected(new Set(rows.filter((r) => r.selectable).map((r) => r.widget.id)))
                }
              >
                All
              </button>
              <button
                type="button"
                className="body-xs-medium text-alert-informative hover:underline"
                onClick={() => setSelected(new Set())}
              >
                None
              </button>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {rows.map((row) => (
            <DropdownMenuCheckboxItem
              key={row.widget.id}
              checked={selected.has(row.widget.id)}
              disabled={!row.selectable}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => toggle(row.widget.id, !!on)}
              className="gap-2"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate body-xs-regular text-general-label">
                  {row.label}
                </span>
                <span className="truncate font-mono text-[10px] text-ds-text-caption">
                  {row.selectable
                    ? `${row.symbol || "—"}${
                        row.isMacroNews ? "  · macro basket" : row.isNews ? "  · news" : ""
                      }`
                    : row.isChart
                      ? "follows every Apply"
                      : "no symbol param"}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="primary" size="sm" className="shrink-0" onClick={apply}>
        Apply
      </Button>

      <div className="h-5 w-px shrink-0 bg-general-border-primary" />

      <Button
        variant={linkedGroup ? "outlined" : "secondary"}
        size="sm"
        className="shrink-0 gap-1"
        onClick={toggleLink}
        title={
          linkedGroup
            ? `Stop syncing the selected widgets through ${linkedGroup.name} (each keeps its current symbol)`
            : "Create a dashboard group and bind the selected widgets' Symbol to it — OpenBB's native grouping then keeps them in sync"
        }
      >
        <Icon id="group-icon" className="size-3" />
        {linkedGroup ? `Unlink ${linkedGroup.name}` : "Link symbols"}
      </Button>

      <span className="body-xs-regular truncate text-ds-text-caption">
        {linkedGroup
          ? `Symbols are synced through ${linkedGroup.name} · change one, all follow`
          : mode === "replace"
            ? "Overwrites the symbol · chart follows · news keeps its watch list"
            : "Appends the ticker after existing symbols · chart follows"}
      </span>
    </div>
  );
}
