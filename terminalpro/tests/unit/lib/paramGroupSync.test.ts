import { describe, expect, it } from "vitest";
import {
  addToWidgetParamGroups,
  needsGroupValueUpdate,
  updateWidgetGroupValues,
} from "~/lib/utils/app";

/**
 * Guards the contract the bulk-symbol bar relies on when it links widgets
 * through a dashboard group: the group's `groupById` is copied verbatim from
 * the instance param def, which is `undefined` for widgets whose definition
 * omits it. Normalising that value (undefined → null) makes every lookup below
 * fail silently, so the whole linkage would look wired up but never sync.
 */
function widget(paramOverrides: Record<string, unknown> = {}) {
  return {
    id: "w1",
    widgetId: "equity_fundamental_ratios_nasdaq_obb",
    name: "GOOGL 财务比率",
    storage: { params: { symbol: "GOOGL" } },
    params: [{ paramName: "symbol", type: "endpoint", value: "GOOGL", ...paramOverrides }],
    data: {},
  } as never;
}

function group(groupById: unknown) {
  return {
    id: "g1",
    name: "Group 1",
    color: "#111111",
    type: "endpointParam",
    groupById,
    value: "SNDK",
  } as never;
}

describe("endpointParam group → widget params", () => {
  it("writes the group value when the param def has no groupById", () => {
    const source = widget();
    expect(needsGroupValueUpdate(source, group(undefined))).toBe(true);

    const next = updateWidgetGroupValues(source, [group(undefined)]) as unknown as {
      storage: { params: Record<string, unknown> };
    };
    expect(next.storage.params.symbol).toBe("SNDK");
    // the source widget is not mutated
    expect((source as unknown as { storage: { params: Record<string, unknown> } }).storage.params.symbol).toBe(
      "GOOGL",
    );
  });

  it("also works when the def carries an explicit groupById", () => {
    const source = widget({ groupById: "symbol_choices" });
    expect(needsGroupValueUpdate(source, group("symbol_choices"))).toBe(true);
    const next = updateWidgetGroupValues(source, [group("symbol_choices")]) as unknown as {
      storage: { params: Record<string, unknown> };
    };
    expect(next.storage.params.symbol).toBe("SNDK");
  });

  it("keys paramGroups by the group's groupById so the group can be found again", () => {
    expect(addToWidgetParamGroups({}, group(undefined) as never)).toEqual({
      undefined: "g1",
    });
    expect(addToWidgetParamGroups({}, group("symbol_choices") as never)).toEqual({
      symbol_choices: "g1",
    });
  });
});
