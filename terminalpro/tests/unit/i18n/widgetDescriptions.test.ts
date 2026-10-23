import { describe, expect, it } from "vitest";
import { zh } from "~/i18n/locales/zh";
import { widgetDescriptions } from "~/i18n/locales/zh/widgetDescriptions";

describe("widgetDescriptions", () => {
  const entries = Object.entries(widgetDescriptions);

  it("covers the whole catalogue snapshot", () => {
    // 868 unique description strings from the live platform /widgets.json.
    expect(entries.length).toBe(868);
  });

  it("has no untranslated entry", () => {
    const identical = entries.filter(([en, cn]) => en === cn).map(([en]) => en.slice(0, 60));
    expect(identical).toEqual([]);
  });

  it("every translation carries Chinese text", () => {
    const cjk = /[\u4e00-\u9fff]/;
    const missing = entries.filter(([, cn]) => !cjk.test(cn)).map(([en]) => en.slice(0, 60));
    expect(missing).toEqual([]);
  });

  it("is merged into the flat dictionary", () => {
    for (const [en, cn] of entries.slice(0, 25)) {
      expect(zh[en]).toBe(cn);
    }
  });

  it("keeps composed EIA tails consistent", () => {
    const petroleum = entries.filter(([en]) => en.endsWith(" EIA petroleum gas survey data"));
    const gas = entries.filter(([en]) => en.endsWith(" EIA natural gas survey data"));
    expect(petroleum.length).toBeGreaterThan(100);
    expect(gas.length).toBeGreaterThan(40);

    for (const [en, cn] of petroleum) {
      expect(cn.endsWith("。EIA 石油与天然气调查数据")).toBe(true);
      // The head of the English description is the widget name: it must not
      // leak through untranslated.
      const head = en.slice(0, en.indexOf(". EIA petroleum gas survey data"));
      expect(cn.startsWith(head)).toBe(false);
    }
    for (const [en, cn] of gas) {
      expect(cn.endsWith("。EIA 天然气调查数据")).toBe(true);
      const head = en.slice(0, en.indexOf(". EIA natural gas survey data"));
      expect(cn.startsWith(head)).toBe(false);
    }
  });

  it("keeps long dataset documents intact and translated", () => {
    const docs = entries.filter(([en]) => en.length > 1000);
    expect(docs.length).toBe(3);
    for (const [en, cn] of docs) {
      expect(en.includes("Metadata for the selected dataset")).toBe(true);
      expect(cn).toContain("`extra['results_metadata']`");
      expect(
        cn.startsWith("美国组合收益。") ||
          cn.startsWith("各国组合收益。") ||
          cn.startsWith("Fama-French 因子。"),
      ).toBe(true);
    }
  });
});
