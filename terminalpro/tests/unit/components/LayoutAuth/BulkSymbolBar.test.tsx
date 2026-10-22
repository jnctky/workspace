import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BulkSymbolBar, {
  buildSymbolGroup,
  chartStorage,
  isMacroNewsWidget,
  mergeSymbols,
  newsSymbols,
  promotedGroup,
  resolveChartSymbol,
  stripSymbolPrefix,
  symbolGroupId,
  withSymbol,
} from "~/components/LayoutAuth/BulkSymbolBar";

const mocks = vi.hoisted(() => ({
  updateWidget: vi.fn(),
  debounceSaveDashboards: vi.fn(),
  triggerCustomEvent: vi.fn(),
  addGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  setWidgetGroupId: vi.fn(
    (_tabId: string, widgetId: string, _group: unknown, remove?: boolean) => {
      const tab = mocks.items.tab1 as {
        data: { widgets: { id: string; paramGroups?: Record<string, string> }[] };
      };
      const target = tab.data.widgets.find((w) => w.id === widgetId);
      if (target && remove) target.paramGroups = {};
    },
  ),
  items: {
    tab1: { data: { widgets: [] as Record<string, unknown>[], groups: [] as unknown[] } },
  } as Record<string, unknown>,
}));

vi.mock("~/lib/state/app", () => ({
  useShallowAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      items: mocks.items,
      updateWidget: mocks.updateWidget,
      debounceSaveDashboards: mocks.debounceSaveDashboards,
      addGroup: mocks.addGroup,
      updateGroup: mocks.updateGroup,
      deleteGroup: mocks.deleteGroup,
      setWidgetGroupId: mocks.setWidgetGroupId,
    }),
  useAppStore: { getState: () => ({ items: mocks.items }) },
}));

vi.mock("~/lib/contexts/TabContext", () => ({
  useTabContext: () => ({
    currentTab: "",
    tabId: "tab1",
    layouts: [{ i: "w1" }, { i: "w2" }, { i: "w3" }, { i: "w4" }, { i: "w5" }],
    isShared: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("~/components/Icon", () => ({ default: () => <span /> }));

// The chart component pulls in the TradingView embed and the widget shell; the
// bar only needs its default symbol list and the platform base URL.
vi.mock("~/components/Widgets/TVWidgets/AdvancedWidget", () => ({
  DEFAULT_SYMBOLS: [
    { label: "AAPL", value: "NASDAQ:AAPL" },
    { label: "SPY", value: "AMEX:SPY" },
  ],
  OPENBB_PLATFORM_URL: "http://127.0.0.1:6900",
}));

vi.mock("~/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
  triggerCustomEvent: mocks.triggerCustomEvent,
  COLORS: ["#111111", "#222222"],
  uuidv4: () => "group-new",
}));

function widget(overrides: Record<string, unknown>) {
  return {
    id: "w",
    name: "widget",
    type: "table",
    widgetId: "some_widget",
    storage: { params: {} },
    params: [],
    ...overrides,
  };
}

const WIDGETS = [
  widget({
    id: "w1",
    name: "日线 K 线",
    widgetId: "equity_price_historical_nasdaq_obb",
    storage: { params: { symbol: "AAPL" } },
    params: [{ paramName: "symbol", value: "AAPL", multiple: true }],
  }),
  widget({
    id: "w2",
    name: "财务比率",
    widgetId: "equity_fundamental_ratios_nasdaq_obb",
    storage: { params: { symbol: "AAPL" } },
    params: [{ paramName: "symbol", value: "AAPL", multiple: false }],
  }),
  widget({
    id: "w3",
    name: "新闻",
    widgetId: "news_company_nasdaq_obb",
    storage: { params: { symbol: "AAPL,SNDK" } },
    params: [{ paramName: "symbol", value: "AAPL", multiple: true }],
  }),
  widget({
    id: "w4",
    name: "tv chart",
    widgetId: "tv_charting",
    storage: { params: {}, selectedSymbol: "NASDAQ:AAPL" },
    params: [],
  }),
  widget({
    id: "w5",
    name: "全球宏观新闻",
    widgetId: "news_company_nasdaq_obb",
    storage: { params: { symbol: "SPY,QQQ,DIA,TLT,GLD,USO,UUP" } },
    params: [{ paramName: "symbol", value: "SPY", multiple: true }],
  }),
];

describe("mergeSymbols", () => {
  it("appends while keeping order and dropping duplicates", () => {
    expect(mergeSymbols("AAPL,SNDK", "NVDA")).toBe("AAPL,SNDK,NVDA");
    expect(mergeSymbols("AAPL,SNDK", "aapl")).toBe("AAPL,SNDK");
    expect(mergeSymbols("", "NVDA")).toBe("NVDA");
    expect(mergeSymbols("AAPL", " NVDA , SPY ")).toBe("AAPL,NVDA,SPY");
  });
});

describe("stripSymbolPrefix", () => {
  it("drops a leading ticker from a title", () => {
    expect(stripSymbolPrefix("AAPL 日线 K 线")).toBe("日线 K 线");
    expect(stripSymbolPrefix("GOOGL 财务比率")).toBe("财务比率");
    expect(stripSymbolPrefix("AAPL 新闻")).toBe("新闻");
    expect(stripSymbolPrefix("^GSPC 指数")).toBe("指数");
  });

  it("leaves labels that are not ticker-prefixed alone", () => {
    expect(stripSymbolPrefix("公司概况")).toBe("公司概况");
    expect(stripSymbolPrefix("全球宏观新闻")).toBe("全球宏观新闻");
    expect(stripSymbolPrefix("tv_Advanced Real-time Chart Widget")).toBe(
      "tv_Advanced Real-time Chart Widget",
    );
    // words that look like tickers stay in the title
    expect(stripSymbolPrefix("US 就业数据")).toBe("US 就业数据");
    expect(stripSymbolPrefix("ETF 资金流")).toBe("ETF 资金流");
  });
});

describe("isMacroNewsWidget", () => {
  it("recognises the basket by name or by composition", () => {
    expect(isMacroNewsWidget("全球宏观新闻", "AAPL")).toBe(true);
    expect(isMacroNewsWidget("Global News", "AAPL")).toBe(true);
    expect(isMacroNewsWidget("新闻", "SPY,QQQ,DIA,TLT")).toBe(true);
    expect(isMacroNewsWidget("新闻", "AAPL,SNDK")).toBe(false);
    expect(isMacroNewsWidget("新闻", "SPY,QQQ")).toBe(false);
  });
});

describe("newsSymbols", () => {
  it("puts the new ticker first and keeps the watch list", () => {
    expect(newsSymbols("AAPL,SNDK", "NVDA", "replace")).toBe("NVDA,AAPL,SNDK");
    expect(newsSymbols("AAPL,SNDK", "NVDA", "append")).toBe("AAPL,SNDK,NVDA");
    // already covered: no duplicate, no growth
    expect(newsSymbols("AAPL,SNDK", "SNDK", "replace")).toBe("SNDK,AAPL");
    // capped so a feed never turns into a twenty-symbol query
    expect(newsSymbols("A,B,C,D", "E", "append")).toBe("A,B,C,D");
  });
});

describe("resolveChartSymbol", () => {
  it("prefers the chart's own list, then the ETF table, then the platform", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));

    expect(
      await resolveChartSymbol("AAPL", [{ label: "AAPL", value: "NASDAQ:AAPL" }]),
    ).toBe("NASDAQ:AAPL");
    // ETFs have no profile row on the platform
    expect(await resolveChartSymbol("SPY")).toBe("AMEX:SPY");
    // offline fallback still yields a renderable symbol
    expect(await resolveChartSymbol("SNDK")).toBe("NASDAQ:SNDK");

    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [{ exchange: "NYSE-GM" }] }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveChartSymbol("JPM")).toBe("NYSE:JPM");
    vi.unstubAllGlobals();
  });
});

describe("chartStorage", () => {
  it("switches the symbol and keeps it selectable in the chart menu", () => {
    const storage = chartStorage(
      widget({ storage: { params: {} } }) as never,
      "AMEX:SPY",
      "SPY",
    ) as { selectedSymbol: string; availableSymbols: { label: string; value: string }[] };
    expect(storage.selectedSymbol).toBe("AMEX:SPY");
    expect(storage.availableSymbols.map((s) => s.value)).toEqual(["NASDAQ:AAPL", "AMEX:SPY"]);

    // an already-listed symbol does not grow the list
    const again = chartStorage(
      widget({ storage: { availableSymbols: [{ label: "AAPL", value: "NASDAQ:AAPL" }] } }) as never,
      "NASDAQ:AAPL",
      "AAPL",
    ) as { availableSymbols: unknown[] };
    expect(again.availableSymbols).toHaveLength(1);
  });
});

describe("withSymbol", () => {
  it("rewrites the stored and declared symbol only", () => {
    const source = widget({
      storage: { params: { symbol: "AAPL", limit: 250 } },
      params: [
        { paramName: "symbol", value: "AAPL" },
        { paramName: "limit", value: 250 },
      ],
    });
    const next = withSymbol(source as never, "SNDK") as unknown as {
      storage: { params: Record<string, unknown> };
      params: { paramName: string; value: unknown }[];
    };

    expect(next.storage.params).toEqual({ symbol: "SNDK", limit: 250 });
    expect(next.params.find((p) => p.paramName === "symbol")?.value).toBe("SNDK");
    expect(next.params.find((p) => p.paramName === "limit")?.value).toBe(250);
    // the source stays untouched
    expect(source.storage.params.symbol).toBe("AAPL");
  });
});

describe("BulkSymbolBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.items = {
      tab1: { data: { widgets: structuredClone(WIDGETS), groups: [] } },
    };
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  });

  const stored = () =>
    mocks.updateWidget.mock.calls.map(([, w]) => w as Record<string, any>);

  it("selects every retargetable widget except the macro news basket", () => {
    render(<BulkSymbolBar />);
    // w1/w2/w3/w5 carry a symbol param; the macro instance is left out
    expect(screen.getByText("Widgets 3/4")).toBeInTheDocument();
  });

  it("replaces the ticker, strips titles and switches the chart", async () => {
    render(<BulkSymbolBar />);
    fireEvent.change(screen.getByPlaceholderText("e.g. SNDK"), {
      target: { value: "sndk" },
    });
    fireEvent.click(screen.getByText("Apply"));
    // the chart symbol is resolved asynchronously before the last write
    await waitFor(() => expect(stored()).toHaveLength(4));

    const calls = stored();
    expect(calls.map((w) => w.id)).toEqual(["w1", "w2", "w3", "w4"]);
    expect(calls.map((w) => w.storage.params.symbol)).toEqual([
      "SNDK",
      "SNDK",
      "SNDK,AAPL",
      undefined,
    ]);
    // titles lose the instrument instead of following it
    expect(calls.map((w) => w.name)).toEqual([
      "日线 K 线",
      "财务比率",
      "新闻",
      "tv chart",
    ]);
    // the chart has no params: its storage carries the TradingView symbol
    expect(calls[3].storage.selectedSymbol).toBe("NASDAQ:SNDK");
    expect(calls[3].storage.availableSymbols).toContainEqual({
      label: "SNDK",
      value: "NASDAQ:SNDK",
    });

    expect(mocks.debounceSaveDashboards).toHaveBeenCalled();
    expect(mocks.triggerCustomEvent).toHaveBeenCalledWith(
      "bulkSymbolApplied",
      expect.anything(),
    );
  });

  it("appends only on multi-symbol widgets, replaces on single-symbol ones", async () => {
    render(<BulkSymbolBar />);
    fireEvent.click(screen.getByText("Append"));
    fireEvent.change(screen.getByPlaceholderText("e.g. SNDK"), {
      target: { value: "NVDA" },
    });
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(stored()).toHaveLength(4));

    const calls = stored();
    expect(calls.map((w) => w.storage.params.symbol)).toEqual([
      "AAPL,NVDA",
      "NVDA",
      "AAPL,SNDK,NVDA",
      undefined,
    ]);
  });

  it("notifies mounted widgets so the live copy leaves the old ticker", async () => {
    render(<BulkSymbolBar />);
    fireEvent.change(screen.getByPlaceholderText("e.g. SNDK"), {
      target: { value: "SNDK" },
    });
    fireEvent.click(screen.getByText("Apply"));

    const events = () =>
      mocks.triggerCustomEvent.mock.calls
        .map(([key]) => key as string)
        .filter((key) => key.startsWith("updateWidget-"));
    await waitFor(() => expect(events()).toHaveLength(4));
    expect(events()).toEqual([
      "updateWidget-w1",
      "updateWidget-w2",
      "updateWidget-w3",
      "updateWidget-w4",
    ]);

    // running the dispatched updater against the stale live widget must retarget it
    const updater = mocks.triggerCustomEvent.mock.calls[0][1] as (
      w: Record<string, unknown>,
    ) => { storage: { params: Record<string, string> } };
    expect(updater(WIDGETS[0]).storage.params.symbol).toBe("SNDK");
    expect(mocks.triggerCustomEvent).toHaveBeenCalledWith(
      "updateQueryParams-w1",
      expect.objectContaining({ symbol: "SNDK" }),
    );
  });

  it("cleans an outdated title as soon as the page loads", async () => {
    mocks.items = {
      tab1: {
        data: {
          widgets: [
            widget({
              id: "w1",
              name: "AAPL 日线 K 线",
              widgetId: "equity_price_historical_nasdaq_obb",
              storage: { params: { symbol: "SNDK" } },
              params: [{ paramName: "symbol", value: "SNDK", multiple: true }],
            }),
          ],
        },
      },
    };
    render(<BulkSymbolBar />);

    // no Apply needed: labels drop the instrument on mount
    await waitFor(() => expect(mocks.updateWidget).toHaveBeenCalled());
    const written = mocks.updateWidget.mock.calls.map(([, w]) => w.name);
    expect(written).toContain("日线 K 线");
    expect(written).not.toContain("AAPL 日线 K 线");
  });

  it("remembers the last ticker in localStorage", () => {
    localStorage.setItem("openbb:bulk-symbol:last-ticker", "MSFT");
    render(<BulkSymbolBar />);
    expect(screen.getByPlaceholderText("e.g. SNDK")).toHaveValue("MSFT");
  });

  it("links the selected widgets through a single dashboard group", () => {
    render(<BulkSymbolBar />);
    fireEvent.change(screen.getByPlaceholderText("e.g. SNDK"), {
      target: { value: "googl" },
    });
    fireEvent.click(screen.getByText("Link symbols"));

    expect(mocks.addGroup).toHaveBeenCalledTimes(1);
    const [, group] = mocks.addGroup.mock.calls[0];
    expect(group).toMatchObject({
      id: "group-new",
      name: "Group 1",
      type: "endpointParam",
      value: "GOOGL",
      // falls back to the param name so `paramGroups` gets a real key
      groupById: "symbol",
    });
    expect(mocks.setWidgetGroupId).toHaveBeenCalledTimes(3);
    expect(mocks.setWidgetGroupId.mock.calls.map(([, id]) => id)).toEqual([
      "w1",
      "w2",
      "w3",
    ]);
    expect(mocks.setWidgetGroupId.mock.calls[0][2]).toBe(group);
    expect(mocks.debounceSaveDashboards).toHaveBeenCalled();
  });

  it("offers Unlink once every selected widget shares a group", () => {
    mocks.items = {
      tab1: {
        data: {
          groups: [
            {
              id: "g1",
              name: "Group 1",
              color: "#111111",
              type: "endpointParam",
              groupById: "symbol",
              value: "AAPL",
            },
          ],
          widgets: structuredClone(WIDGETS.slice(0, 2)).map((w) => ({
            ...w,
            paramGroups: { symbol: "g1" },
          })),
        },
      },
    };
    render(<BulkSymbolBar />);

    fireEvent.click(screen.getByText("Unlink Group 1"));

    expect(mocks.addGroup).not.toHaveBeenCalled();
    expect(mocks.setWidgetGroupId.mock.calls.map(([, id, , remove]) => [id, remove])).toEqual([
      ["w1", true],
      ["w2", true],
    ]);
    // the group is dropped together with its last member
    expect(mocks.deleteGroup).toHaveBeenCalledWith("tab1", "g1");
  });

  it("keeps a bound group's value in step with Apply", () => {
    mocks.items = {
      tab1: {
        data: {
          groups: [
            {
              id: "g1",
              name: "Group 1",
              color: "#111111",
              type: "endpointParam",
              groupById: "symbol",
              value: "AAPL",
            },
          ],
          widgets: structuredClone(WIDGETS.slice(0, 2)).map((w) => ({
            ...w,
            paramGroups: { symbol: "g1" },
          })),
        },
      },
    };
    render(<BulkSymbolBar />);
    fireEvent.change(screen.getByPlaceholderText("e.g. SNDK"), {
      target: { value: "SNDK" },
    });
    fireEvent.click(screen.getByText("Apply"));

    expect(mocks.updateGroup).toHaveBeenCalledWith(
      "tab1",
      "g1",
      expect.objectContaining({ value: "SNDK" }),
    );
  });

  it("migrates a legacy group keyed by \"undefined\"", () => {
    mocks.items = {
      tab1: {
        data: {
          groups: [
            {
              id: "g1",
              name: "Group 1",
              color: "#111111",
              type: "endpointParam",
              value: "AAPL",
            },
          ],
          widgets: structuredClone(WIDGETS.slice(0, 2)).map((w) => ({
            ...w,
            paramGroups: { undefined: "g1" },
          })),
        },
      },
    };
    render(<BulkSymbolBar />);

    // the group gains a real groupById and every member is rebound under it
    expect(mocks.updateGroup).toHaveBeenCalledWith(
      "tab1",
      "g1",
      expect.objectContaining({ groupById: "symbol" }),
      false,
    );
    const rebinds = mocks.setWidgetGroupId.mock.calls.filter(([, , , remove]) => !remove);
    expect(rebinds.map(([, id, group]) => [id, group.groupById])).toEqual([
      ["w1", "symbol"],
      ["w2", "symbol"],
    ]);
  });
});

describe("symbolGroupId", () => {
  it("only reports endpointParam groups", () => {
    const tickerGroups = [{ id: "g1", name: "T", color: "#000", type: "ticker" }];
    expect(
      symbolGroupId(widget({ paramGroups: { ticker: "g1" } }) as never, tickerGroups as never),
    ).toBeNull();
    // a dangling reference is not a link either
    expect(
      symbolGroupId(widget({ paramGroups: { symbol: "gone" } }) as never, tickerGroups as never),
    ).toBeNull();

    const symbolGroups = [
      { id: "g2", name: "G", color: "#000", type: "endpointParam", groupById: "symbol" },
    ];
    expect(
      symbolGroupId(widget({ paramGroups: { symbol: "g2" } }) as never, symbolGroups as never),
    ).toBe("g2");
  });
});

describe("buildSymbolGroup", () => {
  it("keeps an explicit groupById and picks a free colour", () => {
    const group = buildSymbolGroup(
      widget({
        params: [{ paramName: "symbol", groupById: "symbol_choices" }],
      }) as never,
      [
        {
          id: "a",
          name: "Group 1",
          color: "#111111",
          type: "endpointParam",
          groupById: "symbol_choices",
        },
      ] as never,
      "SNDK",
    );
    expect(group).toMatchObject({
      type: "endpointParam",
      groupById: "symbol_choices",
      value: "SNDK",
      name: "Group 2",
      color: "#222222",
    });
    // widgets without a symbol param cannot be grouped this way
    expect(buildSymbolGroup(widget({ params: [] }) as never, [], "SNDK")).toBeNull();
  });
});

describe("promotedGroup", () => {
  it("gives a legacy group a concrete key", () => {
    const legacy = {
      id: "g1",
      name: "Group 1",
      color: "#000",
      type: "endpointParam",
      value: "AAPL",
    } as never;
    expect(promotedGroup(legacy, WIDGETS[0] as never)).toMatchObject({ groupById: "symbol" });
    // already promoted: untouched
    const done = { ...legacy, groupById: "symbol_choices" } as never;
    expect(promotedGroup(done, WIDGETS[0] as never)).toBe(done);
  });
});
