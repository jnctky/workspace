/**
 * Copy for the bulk symbol bar (our own component, so every string here is an
 * explicit t() call rather than a runtime patch).
 */
export const bulk: Record<string, string> = {
  "Overwrite each widget's symbol with the ticker above":
    "用上方标的覆盖每个组件的 symbol",
  "Append the ticker to each widget's existing symbols (multi-symbol widgets only)":
    "把标的追加到各组件现有的 symbol 之后（仅支持多标的的组件）",
  "Replace": "替换",
  "Append": "追加",
  "All": "全部",
  "None": "无",
  "macro basket": "宏观篮子",
  "news": "资讯",
  "follows every Apply": "跟随每次应用",
  "no symbol param": "无 symbol 参数",
  "Link symbols": "联动标的",
  "Unlink {group}": "解除 {group}",
  "Symbols are synced through {group} · change one, all follow":
    "通过 {group} 联动 · 改一个全部跟随",
  "Overwrites the symbol · chart follows · news keeps its watch list":
    "覆盖标的 · 图表跟随 · 资讯保留观察列表",
  "Appends the ticker after existing symbols · chart follows":
    "在现有标的之后追加 · 图表跟随",
  "Stop syncing the selected widgets through {group} (each keeps its current symbol)":
    "停止通过 {group} 同步所选组件（各自保留当前标的）",
  "Create a dashboard group and bind the selected widgets' Symbol to it — OpenBB's native grouping then keeps them in sync":
    "创建看板分组并把所选组件的 Symbol 绑定进去 — 之后由 OpenBB 原生分组保持同步",
  "Unlinked {count} widgets from {group}":
    "已将 {count} 个组件从 {group} 解除",
  "Updated 1 widget → {symbol}": "已更新 1 个组件 → {symbol}",
  "Updated {count} widgets → {symbol}": "已更新 {count} 个组件 → {symbol}",
  "{count} news feeds kept watch list": "{count} 个资讯源保留观察列表",
  "chart switched": "图表已切换",
  "skipped {count} macro news": "跳过 {count} 个宏观资讯",
  "{count} single-symbol widgets replaced instead":
    "{count} 个单标的组件改为替换",
};
