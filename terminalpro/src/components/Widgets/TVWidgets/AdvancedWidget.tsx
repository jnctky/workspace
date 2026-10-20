import { memo, useCallback, useMemo, useState } from "react";
import { AdvancedRealTimeChart } from "react-ts-tradingview-widgets";
import { useDebounce } from "use-debounce";
import DraggableCard from "~/components/DraggableCard";
import SetLoadingOnResize from "~/components/DraggableCard/SetLoadingOnResize";
import NewAdvancedSelectAddEdit from "~/components/NewAdvancedSelectAddEdit";
import { useWidgetContext } from "~/components/Widget.context";
import { useShallowThemeStore } from "~/lib/state/theme";

const DEFAULT_SYMBOLS = [
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
