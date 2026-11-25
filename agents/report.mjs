// Coordinator: plain rules, no AI. Puts the analytics report and the post drafts into one
// weekly report (out/report.md), and decides whether the debug agent should check the game.
import fs from "node:fs";
import { readOut, write } from "./lib/files.mjs";

const status = {
  analytics: process.env.ANALYTICS_STATUS || "skipped",
  social: process.env.SOCIAL_STATUS || "skipped",
};
const numbers = JSON.parse(readOut("analytics.json") || "{}");
const now = numbers.this_week || {};
const before = numbers.last_week || {};

// Rule 1: players reported errors this week, so ask the debug agent to play the game now.
const errors = (now.js_errors || 0) + (now.load_failed || 0);
const needsDebug = errors > 0;

// Rule 2: flag a big drop, so it is the first thing read.
const warnings = [];
if ((before.players || 0) >= 10 && (now.players || 0) <= before.players / 2) {
  warnings.push(`玩家比上周少了一半以上（这周 ${now.players || 0}，上周 ${before.players}）。`);
}
if (needsDebug) {
  warnings.push(`玩家这周遇到 ${errors} 次报错，已经让 debug agent 去检查游戏，有问题它会开 PR。`);
}

const fixKey = (key) => `运行出错：\`${key}\` 填得不对，没被接受。到仓库 Settings → Secrets and variables → Actions 里重新填这个 key，然后在 Actions 页面再跑一次。`;

// Says which key was refused, from the error the agent left. Never copies the error itself into
// the issue, because the repository is public.
function failureReason(name) {
  const error = readOut(`${name}.err`) || "";
  if (/PostHog answered (401|403)/.test(error)) return fixKey("POSTHOG_PERSONAL_API_KEY");
  if (/authentication_error|invalid_api_key|invalid x-api-key|Incorrect API key|\b401\b/i.test(error)) {
    return fixKey(name === "social" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  }
  if (/insufficient_quota|credit balance|billing/i.test(error)) {
    return `运行出错：${name === "social" ? "OpenAI" : "Anthropic"} 账户余额不够，充值后再跑一次。`;
  }
  return "运行出错：点下面的运行记录看原因";
}

const why = { skipped: "没运行：还没加需要的 key（见 agents/README.md）" };
const section = (title, name, file) => {
  if (status[name] === "success") return `## ${title}\n\n${(readOut(file) || "").trim() || "（没有内容）"}`;
  return `## ${title}\n\n${status[name] === "failure" ? failureReason(name) : why[status[name]] || status[name]}`;
};

// Rule 3: show how many tokens each AI step used. The hidden line is for the dashboard.
const usage = {};
for (const name of ["analytics", "social"]) {
  if (status[name] !== "success") continue;
  try { usage[name] = JSON.parse(readOut(`${name}.usage.json`) || "null"); } catch { /* no usage file */ }
  if (!usage[name]) delete usage[name];
}
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const usageLines = Object.entries(usage).map(([name, u]) =>
  `- ${name === "analytics" ? "数据 agent" : "文案 agent"}（${u.model}）：读 ${fmt(u.input_tokens)}，写 ${fmt(u.output_tokens)} tokens`);
const usageSection = usageLines.length
  ? `## 这次用了多少 token\n\n${usageLines.join("\n")}\n\n<!-- agent-usage ${JSON.stringify(usage)} -->`
  : null;

const run = process.env.GITHUB_RUN_URL ? `\n\n[这次运行的记录](${process.env.GITHUB_RUN_URL})` : "";
const body = [
  warnings.length ? `> ⚠️ ${warnings.join("\n> ⚠️ ")}` : null,
  section("数据小结（Claude）", "analytics", "analytics.md"),
  section("下周发帖草稿（ChatGPT，只是草稿，不会自动发）", "social", "social.md"),
  usageSection,
  `---\n每周一自动生成。想改文案方向：改 agents/game-brief.md 或在 agents/news.md 写这周的新东西。所有 agent 的状态：[指挥台](https://rickylgd.github.io/fluffy-pilots/agents/dashboard/)${run}`,
].filter(Boolean).join("\n\n");

write("report.md", body);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `needs_debug=${needsDebug}\nattention=${warnings.length > 0}\n`);
}
console.log(body);
