import { describe, expect, it } from "vitest";
import { setLocale, t } from "~/i18n";
import { catalogCategories, catalogLabels } from "~/i18n/locales/zh/catalog";
import { widgetNames } from "~/i18n/locales/zh/widgetNames";

describe("i18n catalog (P1: widget names, categories, parameter labels)", () => {
  it("translates widget default names", () => {
    setLocale("zh");
    expect(t("BLS CPI Seasonal Factors")).toBe("BLS CPI 季节性因子");
    expect(t("Deribit Volatility Smile")).toBe("Deribit 波动率微笑");
    expect(t("Company Overview")).toBe("公司概览");
    setLocale("en");
    expect(t("Company Overview")).toBe("Company Overview");
  });

  it("translates categories and parameter labels", () => {
    setLocale("zh");
    expect(t("Commodity")).toBe("大宗商品");
    expect(t("Market Cap Min")).toBe("市值下限");
    expect(t("Open Interest Max")).toBe("未平仓量上限");
    setLocale("en");
  });

  it("lets parameter labels win over same-named categories", () => {
    // "Currency" exists both as a category and a common parameter label;
    // whole-string matching cannot tell contexts apart, so both entries use
    // one translation that reads fine in either (货币).
    expect(zhLabel("Currency")).toBe("货币");
  });

  it("keeps every catalog entry non-empty and translated", () => {
    for (const source of [catalogCategories, catalogLabels, widgetNames]) {
      for (const [en, zhText] of Object.entries(source)) {
        expect(en.length).toBeGreaterThan(0);
        expect(zhText.trim().length).toBeGreaterThan(0);
        // Identity is only acceptable for bare acronyms (ETF, SOFR, ...)
        // that need no translation.
        if (zhText === en) {
          expect(en).toMatch(/^[A-Z0-9 .\-&/]+$/);
        }
      }
    }
  });

  it("keeps escaped backslash keys aligned with widgets.json", () => {
    // widgets.json name is "Exports\Imports Quantity\Price" (single backslash);
    // the TS source escapes it, the evaluated key must match the JSON value.
    expect(widgetNames["Exports\\Imports Quantity\\Price"]).toBeDefined();
  });
});

function zhLabel(key: string): string {
  setLocale("zh");
  const value = t(key);
  setLocale("en");
  return value;
}
