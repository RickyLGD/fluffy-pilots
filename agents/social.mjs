// Social media agent: drafts next week's Instagram Reels and TikTok posts with ChatGPT.
// It only writes drafts into the weekly report. It never posts anything anywhere.
//
// Reads agents/game-brief.md, agents/news.md and this week's analytics (if the analytics
// agent ran), and writes out/social.md.
import path from "node:path";
import OpenAI from "openai";
import { agentsDir, readIfExists, readOut, write } from "./lib/files.mjs";

const MODEL = process.env.SOCIAL_MODEL || "gpt-6.1-terra";
const LANGUAGE = process.env.CAPTION_LANGUAGE || "中文和英文各一版";

const brief = readIfExists(path.join(agentsDir, "game-brief.md")) || "";
const news = (readIfExists(path.join(agentsDir, "news.md")) || "").trim();
const analytics = readOut("analytics.md") || "（这周没有数据小结）";
const numbers = JSON.parse(readOut("analytics.json") || "{}");
const newFeatures = (numbers.new_this_week || []).join(", ") || "（没有）";

const client = new OpenAI();
const response = await client.responses.create({
  model: MODEL,
  max_output_tokens: 8000,
  instructions: `你是一个独立小游戏的社交媒体文案助手，帮开发者写下周要发的短视频草稿。
开发者自己拍、自己发，你只写草稿。

要求：
- 写 3 条短视频草稿，第 1、2 条适合 Instagram Reels，第 3 条适合 TikTok。
- 每条包括：
  **标题**（给开发者看的，一句话）
  **开头 2 秒**：画面 + 屏幕上的字（要让人停下来）
  **拍什么**：3 到 5 个镜头，每个一行，用手机录屏或拍宠物就能做到
  **文案**：${LANGUAGE}，口语化，不超过 3 句
  **标签**：5 个以内
- 优先写"这周的新东西"里开发者写的内容，其次写这周新上线的功能。
- 只写游戏里真有的东西，不编数字、不夸大、不写"爆火""百万玩家"这类话。
- 最后加一行 **建议**：根据数据小结，说一句这周发帖最该达到什么目的（比如拉新玩家，还是让老玩家回来）。
- 全部用中文写说明，只有文案按上面的语言要求。`,
  input: `## 游戏介绍\n${brief}\n\n## 这周的新东西（开发者自己写的）\n${news}\n\n## 这周新上线、开始有人用的功能（事件名）\n${newFeatures}\n\n## 这周的数据小结\n${analytics}`,
});

const drafts = (response.output_text || "").trim();
if (!drafts) throw new Error(`ChatGPT returned no text (status: ${response.status})`);
write("social.md", drafts);
console.log(drafts);
console.log(`\n[tokens] in ${response.usage?.input_tokens}, out ${response.usage?.output_tokens} (${MODEL})`);
// Token use for this step, so the weekly report and the dashboard can show it.
write("social.usage.json", JSON.stringify({
  model: MODEL, input_tokens: response.usage?.input_tokens || 0, output_tokens: response.usage?.output_tokens || 0,
}));
