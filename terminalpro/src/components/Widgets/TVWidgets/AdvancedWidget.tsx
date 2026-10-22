import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AdvancedRealTimeChart } from "react-ts-tradingview-widgets";
import { useDebounce } from "use-debounce";
import DraggableCard from "~/components/DraggableCard";
import SetLoadingOnResize from "~/components/DraggableCard/SetLoadingOnResize";
import NewAdvancedSelectAddEdit from "~/components/NewAdvancedSelectAddEdit";
import useCopilotDataWidget from "~/components/Widgets/Helpers/useCopilotDataWidget";
import { useWidgetContext } from "~/components/Widget.context";
import { useShallowThemeStore } from "~/lib/state/theme";

// Local OpenBB Platform serving OHLCV bars for the Copilot. The TradingView
// embed widget exposes no data API, so the Copilot reads the same symbol's
// daily bars from the local platform instead.
export const OPENBB_PLATFORM_URL = "http://127.0.0.1:6900";
const AI_BARS_WINDOW_DAYS = 100;
const AI_BARS_MAX_ROWS = 30;

export const DEFAULT_SYMBOLS = [
  { label: "AAPL", value: "NASDAQ:AAPL" },
  { label: "GOOGL", value: "NASDAQ:GOOGL" },
  { label: "NVDA", value: "NASDAQ:NVDA" },
  { label: "TSLA", value: "NASDAQ:TSLA" },
  { label: "MSFT", value: "NASDAQ:MSFT" },
  { label: "SPY", value: "AMEX:SPY" },
  { label: "QQQ", value: "NASDAQ:QQQ" },
  { label: "BTCUSD", value: "BITSTAMP:BTCUSD" },
];

const TradingViewWidget = memo(function TradingViewWidget() {
  const theme = useShallowThemeStore((state) => state.theme);
  const { widget, updateWidget } = useWidgetContext();

  const availableSymbols = useMemo(
    () => widget.storage?.availableSymbols || DEFAULT_SYMBOLS,
    [widget.storage?.availableSymbols],
  );

  const [selectedSymbol, setSelectedSymbol] = useState(
    widget.storage?.selectedSymbol || availableSymbols[0]?.value || "NASDAQ:AAPL",
  );
  const [debouncedSymbol] = useDebounce(selectedSymbol, 500);

  // Feed the Copilot with the charted symbol's recent OHLCV bars. The
  // TradingView embed cannot export its data, so mirror it from the local
  // OpenBB platform (same symbol, daily bars).
  const [aiData, setAiData] = useState<Record<string, any>[]>([]);
  const [aiDataUpdated, setAiDataUpdated] = useState(0);

  useEffect(() => {
    const plainSymbol = debouncedSymbol.split(":").pop() || debouncedSymbol;
    const startDate = new Date(Date.now() - AI_BARS_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const ctrl = new AbortController();
    fetch(
      `${OPENBB_PLATFORM_URL}/api/v1/equity/price/historical?symbol=${encodeURIComponent(plainSymbol)}&provider=nasdaq&start_date=${startDate}`,
      { signal: ctrl.signal },
    )
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((json) => {
        const results = Array.isArray(json?.results) ? json.results : [];
        const rows = results.slice(-AI_BARS_MAX_ROWS).map((row) => ({
          Date: row.date,
          Open: row.open,
          High: row.high,
          Low: row.low,
          Close: row.close,
          Volume: row.volume,
        }));
        setAiData(rows);
        setAiDataUpdated(Date.now());
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [debouncedSymbol]);

  useCopilotDataWidget({ aiData, lastUpdated: aiDataUpdated, aiEnabled: true });

  const handleSelect = useCallback(
    (val: string | string[]) => {
      const value = Array.isArray(val) ? val[0] : val;
      if (!value) return;
      setSelectedSymbol(value);
      updateWidget((prevWidget) => ({
        ...prevWidget,
        storage: { ...prevWidget.storage, selectedSymbol: value },
      }));
    },
    [updateWidget],
  );

  const handleRemove = useCallback(
    (val: string) => {
      const updatedSymbols = availableSymbols.filter((item) => item.value !== val);
      if (selectedSymbol === val) {
        const next = updatedSymbols[0]?.value || "NASDAQ:AAPL";
        setSelectedSymbol(next);
        updateWidget((prevWidget) => ({
          ...prevWidget,
          storage: {
            ...prevWidget.storage,
            availableSymbols: updatedSymbols,
            selectedSymbol: next,
          },
        }));
      } else {
        updateWidget((prevWidget) => ({
          ...prevWidget,
          storage: { ...prevWidget.storage, availableSymbols: updatedSymbols },
        }));
      }
    },
    [selectedSymbol, availableSymbols, updateWidget],
  );

  const handleAdd = useCallback(
    (newSymbol: { label: string; value: string }) => {
      const updatedSymbols = [...availableSymbols, newSymbol];
      setSelectedSymbol(newSymbol.value);
      updateWidget((prevWidget) => ({
        ...prevWidget,
        storage: {
          ...prevWidget.storage,
          availableSymbols: updatedSymbols,
          selectedSymbol: newSymbol.value,
        },
      }));
    },
    [availableSymbols, updateWidget],
  );

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
      settings={dropdownSettings}
      elementNextToTitle={
        <NewAdvancedSelectAddEdit
          selected={selectedSymbol}
          label={
            availableSymbols.find((s) => s.value === selectedSymbol)?.label || selectedSymbol
          }
          onSelect={handleSelect}
          onRemove={handleRemove}
          onAdd={handleAdd}
          values={availableSymbols}
        />
      }
    >
      <SetLoadingOnResize>
        <AdvancedRealTimeChart
          theme={theme as "light" | "dark"}
          autosize={true}
          symbol={debouncedSymbol}
          interval="D"
          timezone="Etc/UTC"
          style="1"
          locale="en"
          withdateranges={true}
          hide_side_toolbar={false}
          allow_symbol_change={true}
        />
      </SetLoadingOnResize>
    </DraggableCard>
  );
});

export default TradingViewWidget;
