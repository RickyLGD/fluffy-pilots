// Analytics agent: last 7 days of the game in PostHog, compared with the 7 days before.
//
// Step 1 (no AI, free): this script asks PostHog for a handful of numbers and keeps only those.
// Step 2 (Claude Haiku, cheap): Claude gets just those numbers, a few hundred tokens, and writes a
// short report in Chinese. Claude never sees raw events, so each run costs a fraction of a cent.
//
// Writes out/analytics.json (the numbers) and out/analytics.md (the report).
import Anthropic from "@anthropic-ai/sdk";
import { query } from "./lib/posthog.mjs";
import { write } from "./lib/files.mjs";

const MODEL = process.env.ANALYTICS_MODEL || "claude-haiku-5-5";
const cohort = Number(process.env.POSTHOG_TEST_COHORT_ID || 0);
// People in this cohort are the owner's own test devices; they are left out of every number.
const notTest = cohort ? `AND person_id NOT IN COHORT ${cohort}` : "";
const thisWeek = "timestamp >= now() - INTERVAL 7 DAY";

const totals = await query(`
  SELECT if(${thisWeek}, 'this_week', 'last_week') AS week,
    uniqIf(person_id, event = 'page_open') AS visitors,
    uniqIf(person_id, event = 'game_start') AS players,
    countIf(event = 'game_start') AS rounds,
    quantileIf(0.5)(toFloat(properties.score), event = 'game_over') AS median_score,
    maxIf(toFloat(properties.score), event = 'game_over') AS best_score,
    uniqIf(person_id, event = 'park_open') AS park_visitors,
    uniqIf(person_id, event = 'share_open') AS sharers,
    uniqIf(person_id, event = 'upload_click') AS pet_uploaders,
    countIf(event = 'js_error') AS js_errors,
    countIf(event = 'load_failed') AS load_failed,
    round(uniqIf(person_id, event = 'page_open' AND properties.is_mobile = true)
      / greatest(uniqIf(person_id, event = 'page_open'), 1), 2) AS phone_share
  FROM events
  WHERE timestamp >= now() - INTERVAL 14 DAY ${notTest}
  GROUP BY week`);

const daily = await query(`
  SELECT toDate(timestamp) AS day,
    uniqIf(person_id, event = 'page_open') AS visitors,
    uniqIf(person_id, event = 'game_start') AS players
  FROM events
  WHERE ${thisWeek} ${notTest}
  GROUP BY day ORDER BY day`);

const events = await query(`
  SELECT event,
    countIf(${thisWeek}) AS this_week,
    countIf(NOT (${thisWeek})) AS last_week,
    uniqIf(person_id, ${thisWeek}) AS people_this_week
  FROM events
  WHERE timestamp >= now() - INTERVAL 14 DAY ${notTest} AND NOT startsWith(event, '$')
  GROUP BY event ORDER BY this_week DESC LIMIT 40`);

const errors = await query(`
  SELECT toString(properties.message) AS message, toString(properties.file) AS file,
    count() AS times, uniq(person_id) AS people
  FROM events
  WHERE event IN ('js_error', 'load_failed') AND ${thisWeek} ${notTest}
  GROUP BY message, file ORDER BY times DESC LIMIT 8`);

const countries = await query(`
  SELECT toString(properties.$geoip_country_name) AS country, uniq(person_id) AS visitors
  FROM events
  WHERE event = 'page_open' AND ${thisWeek} ${notTest}
  GROUP BY country ORDER BY visitors DESC LIMIT 5`);

const byWeek = Object.fromEntries(totals.map((row) => [row.week, row]));
const numbers = {
  period: "最近 7 天，对比再往前 7 天（UTC）",
  this_week: byWeek.this_week || {},
  last_week: byWeek.last_week || {},
  daily_this_week: daily,
  // Events that showed up this week but not last week usually mean a new feature went live.
  new_this_week: events.filter((row) => row.this_week > 0 && row.last_week === 0).map((row) => row.event),
  events,
  errors,
  top_countries: countries,
};
write("analytics.json", JSON.stringify(numbers, null, 2));

const client = new Anthropic();
const response = await client.messages.create({
  model: MODEL,
  max_tokens: 3000,
  output_config: { effort: "low" },
  system: `你在给一个独立游戏开发者写每周数据小结。游戏叫"飞行搭档"（Fluffy Pilots），是一个网页小游戏：玩家开着飞机带上宠物穿过柱子，还有宠物乐园、喂食、机库、桌面宠物、分享等功能。

规则：
- 只用给你的数字，不要编造或推测没有给出的数据。
- events 里 this_week 和 last_week 是次数，people_this_week 才是人数。写“几个人”时只能用人数，次数要写成“几次”。
- 中文，简短，手机上一屏能看完，总共不超过 250 字。
- 格式：
  第一行一句话结论（这周比上周好还是差，最重要的一个数字）。
  然后 "**关键数字**"：4 到 6 行 "- 名称：这周 X，上周 Y"。
  然后 "**值得注意**"：最多 3 行，比如新功能有没有人用、报错、玩家流失在哪一步。
  最后 "**下周可以试**"：1 到 2 条具体建议。
- 事件名的意思：page_open 打开页面，game_start 开始一局，game_over 一局结束，left_unplayed 打开了但没玩就走了，park_open 进乐园，feed_bowl/feed_treat 喂食，hangar_open/hangar_buy 机库，share_open 分享，upload_click 上传宠物，js_error 网页报错，load_failed 加载失败。`,
  messages: [{ role: "user", content: `这周的数据（JSON）：\n${JSON.stringify(numbers)}` }],
});

if (response.stop_reason === "refusal") throw new Error("Claude declined to write the report");
const report = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
write("analytics.md", report);
console.log(report);
console.log(`\n[tokens] in ${response.usage.input_tokens}, out ${response.usage.output_tokens} (${MODEL})`);
