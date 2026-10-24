import { useEffect, useMemo, useRef, useState } from "react";

// Local OpenBB Platform serving data for TV-widget Copilot bridges.
export const OPENBB_PLATFORM_URL = "http://127.0.0.1:6900";

/**
 * Generic TradingView-widget → Copilot data bridge.
 *
 * TradingView embed widgets (`tv_*`) render inside a cross-origin iframe and
 * expose no data API, so the Copilot cannot read what is on screen. Widgets
 * using this hook mirror an equivalent dataset from the local OpenBB Platform
 * into the Copilot data store instead.
 *
 * Usage (inside the widget component, which must render a <DraggableCard>):
 *
 *   const { aiData, lastUpdated } = useTvCopilotBridge({
 *     fetchRows: async () => { ... return rows; },
 *     note: "What this data is, and that on-screen TV values may differ.",
 *   });
 *   <DraggableCard aiEnabled aiData={aiData} lastUpdated={lastUpdated} ...>
 *
 * The hook refetches on mount and then every `refreshMs` (default 60 s) while
 * mounted; on fetch failure it keeps the last good snapshot. A disclosure row
 * is prepended to the data so the Copilot knows the snapshot time and that
 * TradingView's on-screen values may differ slightly.
 */
export function useTvCopilotBridge({
  fetchRows,
  note,
  refreshMs = 60_000,
  aiEnabled = true,
}: {
  fetchRows: () => Promise<Record<string, any>[] | null>;
  note?: string;
  refreshMs?: number;
  aiEnabled?: boolean;
}) {
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [lastUpdated, setLastUpdated] = useState(0);
  const fetcherRef = useRef(fetchRows);
  fetcherRef.current = fetchRows;

  useEffect(() => {
    if (!aiEnabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetcherRef.current();
        if (cancelled) return;
        if (result && result.length > 0) {
          setRows(result);
          setLastUpdated(Date.now());
        }
      } catch {
        /* keep the last good snapshot */
      }
    };
    void load();
    if (!refreshMs || refreshMs <= 0) {
      return () => {
        cancelled = true;
      };
    }
    const interval = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [aiEnabled, refreshMs]);

  const aiData = useMemo(() => {
    if (!rows.length) return rows;
    if (!note) return rows;
    const asOf = new Date(lastUpdated).toLocaleString("en-US", { hour12: false });
    return [{ Note: `${note} (snapshot fetched ${asOf})` }, ...rows];
  }, [rows, lastUpdated, note]);

  return { aiData, lastUpdated };
}
