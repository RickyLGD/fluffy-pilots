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

const why = {
  skipped: "没运行：还没加需要的 key（见 agents/README.md）",
  failure: "运行出错：点上面的运行记录看原因",
};
const section = (title, name, file) =>
  `## ${title}\n\n${status[name] === "success" ? (readOut(file) || "").trim() || "（没有内容）" : why[status[name]] || status[name]}`;

const run = process.env.GITHUB_RUN_URL ? `\n\n[这次运行的记录](${process.env.GITHUB_RUN_URL})` : "";
const body = [
  warnings.length ? `> ⚠️ ${warnings.join("\n> ⚠️ ")}` : null,
  section("数据小结（Claude）", "analytics", "analytics.md"),
  section("下周发帖草稿（ChatGPT，只是草稿，不会自动发）", "social", "social.md"),
  `---\n每周一自动生成。想改文案方向：改 agents/game-brief.md 或在 agents/news.md 写这周的新东西。${run}`,
].filter(Boolean).join("\n\n");

write("report.md", body);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `needs_debug=${needsDebug}\nattention=${warnings.length > 0}\n`);
}
console.log(body);
