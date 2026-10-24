import { memo, useCallback } from "react";
import { StockHeatmap } from "react-ts-tradingview-widgets";
import DraggableCard from "~/components/DraggableCard";
import SetLoadingOnResize from "~/components/DraggableCard/SetLoadingOnResize";
import { useShallowThemeStore } from "~/lib/state/theme";
import { OPENBB_PLATFORM_URL, useTvCopilotBridge } from "../Helpers/useTvCopilotBridge";

// The TradingView stock heatmap embed exposes no data API, so mirror its
// scope (S&P 500 sector performance) from the local OpenBB platform using
// the 11 SPDR sector ETFs' daily bars.
const SECTOR_ETFS: { symbol: string; sector: string }[] = [
  { symbol: "XLK", sector: "Technology" },
  { symbol: "XLF", sector: "Financials" },
  { symbol: "XLE", sector: "Energy" },
  { symbol: "XLV", sector: "Health Care" },
  { symbol: "XLI", sector: "Industrials" },
  { symbol: "XLY", sector: "Consumer Discretionary" },
  { symbol: "XLP", sector: "Consumer Staples" },
  { symbol: "XLU", sector: "Utilities" },
  { symbol: "XLB", sector: "Materials" },
  { symbol: "XLRE", sector: "Real Estate" },
  { symbol: "XLC", sector: "Communication Services" },
];

const HEATMAP_NOTE =
  "S&P 500 sector performance mirrored from the local OpenBB Platform " +
  "(SPDR sector ETF daily closes, cboe provider). The TradingView heatmap " +
  "on screen shows near-realtime values and may differ slightly.";

const TradingViewWidget = memo(function TradingViewWidget() {
  const theme = useShallowThemeStore((state) => state.theme);

  const fetchRows = useCallback(async () => {
    const startDate = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const results = await Promise.all(
      SECTOR_ETFS.map(async ({ symbol, sector }) => {
        const res = await fetch(
          `${OPENBB_PLATFORM_URL}/api/v1/equity/price/historical?symbol=${symbol}&provider=cboe&start_date=${startDate}`,
        );
        if (!res.ok) return null;
        const json = await res.json();
        const bars: { date: string; close: number }[] = Array.isArray(json?.results)
          ? json.results
          : [];
        if (bars.length < 2) return null;
        const last = bars[bars.length - 1];
        const prev = bars[bars.length - 2];
        const changePct = prev.close
          ? Number((((last.close - prev.close) / prev.close) * 100).toFixed(2))
          : null;
        return {
          Sector: sector,
          ETF: symbol,
          Date: last.date,
          Close: last.close,
          "Change %": changePct,
        };
      }),
    );
    return results.filter(Boolean) as Record<string, any>[];
  }, []);

  const { aiData, lastUpdated } = useTvCopilotBridge({
    fetchRows,
    note: HEATMAP_NOTE,
    refreshMs: 60_000,
    aiEnabled: true,
  });

  const dropdownSettings = {
    showSettings: false,
    showFunctions: false,
    showShare: false,
    showDuplicate: false,
    showExport: false,
    showMaximize: false,
    showMove: true,
  };

  return (
    <DraggableCard
      aiEnabled={true}
      aiData={aiData}
      lastUpdated={lastUpdated}
      settings={dropdownSettings}
    >
      <SetLoadingOnResize>
        <StockHeatmap
          autoSize={true}
          colorTheme={theme === "dark" ? "dark" : "light"}
          height={400}
          width="100%"
          copyrightStyles={{
            parent: {
              display: "none",
            },
          }}
        />
      </SetLoadingOnResize>
    </DraggableCard>
  );
});

export default TradingViewWidget;
