# Fluffy Pilots 的 debug agent

这个文件夹里是游戏的自动检查。GitHub 会在无头浏览器里真的玩一遍游戏，电脑和手机两种屏幕各一遍。

## 它检查什么

- 首页能打开，画面不是空白，游戏没有报"加载失败"。
- 点"起飞"，选好伙伴，飞机能起飞。
- 用游戏自带的自动驾驶飞 15 秒左右，至少过一根柱子。
- 坠机后出现结算，点"再来"能开始第二局。
- 电脑上按空格能起飞。
- 首页点门能进乐园，乐园跑几秒不出错。
- 上传宠物的页面（submit.html）能打开。

每一项都会同时检查：浏览器里有没有报错，有没有文件下载失败（404 之类）。

测试时不会连到 PostHog 和排行榜，所以不会算进统计数据，也不会写进真实排行榜。

## 什么时候运行

- 每次推送到 main，每个 pull request，每天早上 8 点（纽约时间），或在 Actions 页面手动点 "Run workflow"。
- 如果 main 上的检查失败，Claude 会读错误、找原因、改最小的地方、再跑一遍检查，然后开一个 pull request 等你审。它不会自己合并。
- 如果找不到原因，它会开一个 issue 说明情况，而不是乱改。

## 你需要做的设置（一次）

1. 在仓库 Settings → Secrets and variables → Actions 里，新建一个 secret，名字叫 `ANTHROPIC_API_KEY`，值是你在 console.anthropic.com 生成的 API key。
2. 在仓库 Settings → Actions → General 最下面，勾选 "Allow GitHub Actions to create and approve pull requests"，然后保存。不勾这个，Claude 开不了修复 PR。

如果你更想用 Claude 订阅而不是 API key：在电脑上运行 `claude setup-token`，把得到的 token 存成 secret `CLAUDE_CODE_OAUTH_TOKEN`，再把 `.github/workflows/debug-agent.yml` 里的 `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` 改成 `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`。

## 在自己电脑上运行

```
cd qa
npm ci
npx playwright install chromium
npm test
```

想检查线上网站而不是本地文件：`BASE_URL=https://你的网址 npm test`。

## 要注意的一点

game.js 第一行的 GAME_DATA 和游戏数值是你本地 `tools/build_web.py` 从 `flappybird/main.py` 生成的。Claude 只能看到这个仓库，所以如果它的修复改到了这些地方，PR 里会写明本地源码要做的同样修改。你需要在源码里也改一下，不然下次重新生成网页版会被覆盖。
