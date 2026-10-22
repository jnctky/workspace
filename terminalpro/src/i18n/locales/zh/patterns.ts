/**
 * Dynamic strings that carry numbers or names and therefore cannot be exact
 * dictionary hits. Kept deliberately small and specific: every rule here runs
 * on text that the exact lookup already missed, so a loose pattern would
 * silently rewrite data.
 */
export type PatternRule = {
  re: RegExp;
  zh: (match: RegExpMatchArray) => string;
};

export const patterns: PatternRule[] = [
  {
    re: /^(\d+)\s+widgets?$/i,
    zh: (m) => `${m[1]} 个组件`,
  },
  {
    re: /^(\d+)\s+apps?$/i,
    zh: (m) => `${m[1]} 个应用`,
  },
  {
    re: /^(\d+)\s+items?$/i,
    zh: (m) => `${m[1]} 项`,
  },
  {
    re: /^(\d+)\s+results?$/i,
    zh: (m) => `${m[1]} 条结果`,
  },
  {
    re: /^Updated\s+(\d+)$/i,
    zh: (m) => `已更新 ${m[1]} 个组件`,
  },
  {
    re: /^Saved\s+(\d+)\s+widgets?$/i,
    zh: (m) => `已保存 ${m[1]} 个组件`,
  },
  {
    re: /^Deleted\s+(\d+)\s+widgets?$/i,
    zh: (m) => `已删除 ${m[1]} 个组件`,
  },
  {
    re: /^Last update:\s*(.+)$/i,
    zh: (m) => `最后更新：${m[1]}`,
  },
  {
    re: /^Updated\s+(.+)\s+ago$/i,
    zh: (m) => `${m[1]}前更新`,
  },
  {
    re: /^Sign in with (.+)$/,
    zh: (m) => `使用 ${m[1]} 登录`,
  },
  {
    re: /^(\d+)\s+of\s+(\d+)$/i,
    zh: (m) => `${m[1]} / ${m[2]}`,
  },
];
