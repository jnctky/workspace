import { beforeEach, describe, expect, it } from "vitest";
import {
  getLocale,
  isChinese,
  setLocale,
  t,
  translateRaw,
} from "~/i18n";

describe("i18n", () => {
  beforeEach(() => {
    setLocale("en", { reload: false });
  });

  it("returns the English source string in en", () => {
    expect(getLocale()).toBe("en");
    expect(t("Cancel")).toBe("Cancel");
    expect(translateRaw("Cancel")).toBeNull();
  });

  it("translates exact keys in zh", () => {
    setLocale("zh", { reload: false });
    expect(isChinese()).toBe(true);
    expect(t("Cancel")).toBe("取消");
    expect(t("Settings")).toBe("设置");
  });

  it("interpolates named placeholders", () => {
    setLocale("zh", { reload: false });
    expect(t("Updated {count} widgets → {symbol}", { count: 3, symbol: "NVDA" })).toBe(
      "已更新 3 个组件 → NVDA",
    );
    expect(t("Unlink {group}", { group: "Group 1" })).toBe("解除 Group 1");
  });

  it("keeps unknown keys readable and still interpolates them", () => {
    setLocale("zh", { reload: false });
    expect(t("Totally unknown string")).toBe("Totally unknown string");
    expect(t("Unknown {n}", { n: 2 })).toBe("Unknown 2");
  });

  it("falls back to a case-insensitive match", () => {
    setLocale("zh", { reload: false });
    expect(translateRaw("refresh DATA")).toBe("刷新数据");
  });

  it("only translates whole trimmed text, never substrings", () => {
    setLocale("zh", { reload: false });
    expect(translateRaw("  Cancel  ")).toBe("取消");
    expect(translateRaw("Cancel all orders")).toBeNull();
    expect(translateRaw(`a${"x".repeat(200)}`)).toBeNull();
  });

  it("applies numeric patterns", () => {
    setLocale("zh", { reload: false });
    expect(translateRaw("3 widgets")).toBe("3 个组件");
    expect(translateRaw("Updated 5")).toBe("已更新 5 个组件");
  });

  it("persists the chosen locale", () => {
    setLocale("zh", { reload: false });
    expect(window.localStorage.getItem("openbb:locale")).toBe("zh");
  });

  it("leaves data-ish strings alone", () => {
    setLocale("zh", { reload: false });
    expect(translateRaw("NVDA")).toBeNull();
    expect(translateRaw("-$1.23")).toBeNull();
    expect(translateRaw("")).toBeNull();
  });
});
