// Automatic checks for the Fluffy Pilots web build: the game opens, a flight starts, flies,
// crashes and can start again, and the park opens. Any browser error fails the check.
//
// The game has a small testing window, window.flightFriends (end of game.js). These checks use
// it to read the game's state and to find where buttons are, but every tap and key press goes
// through the real mouse, touch screen or keyboard, like a player's would.
const { test, expect } = require("@playwright/test");

// Statistics and the leaderboard live on other websites. The checks never reach them, so a
// test run never shows up in PostHog and never writes to the real leaderboard.
async function keepOffTheInternet(page, baseURL) {
  const home = new URL(baseURL).origin;
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === home) return route.continue();
    if (url.hostname.endsWith(".supabase.co")) {
      // An empty leaderboard and empty likes, as if nobody had played yet.
      const status = route.request().method() === "GET" ? 200 : 201;
      return route.fulfill({ status, contentType: "application/json", body: "[]" });
    }
    return route.abort();
  });
}

// Opens the game and collects every problem the browser reports while the test runs.
async function openGame(page, baseURL, path = "/") {
  const problems = [];
  const home = new URL(baseURL).origin;

  await page.addInitScript(() => {
    // Keep every statistics event the game sends, so tests can check what happened.
    window.__track = [];
    const record = function (event, details) {
      let parsed = {};
      try { parsed = JSON.parse(details || "{}"); } catch (error) {}
      window.__track.push({ event, details: parsed });
    };
    Object.defineProperty(window, "flightFriendsTrack", {
      configurable: true,
      get() { return record; },
      set() {},  // index.html sets its own sender; the test keeps this one.
    });
    try { localStorage.clear(); } catch (error) {}  // Every test starts as a first visit.
  });

  page.on("pageerror", (error) => problems.push(`Page error: ${error.message}\n${error.stack || ""}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Failed downloads are checked below, with their address, so they are not counted twice.
    if (/Failed to load resource/.test(text)) return;
    problems.push(`Console error: ${text}`);
  });
  page.on("response", (response) => {
    if (new URL(response.url()).origin === home && response.status() >= 400) {
      problems.push(`HTTP ${response.status()} for ${response.url()}`);
    }
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === home) {
      problems.push(`Download failed: ${request.url()} (${request.failure() && request.failure().errorText})`);
    }
  });

  await keepOffTheInternet(page, baseURL);
  await page.goto(path);
  return problems;
}

async function trackEvents(page, name) {
  return page.evaluate((wanted) => window.__track.filter((item) => item.event === wanted), name);
}

async function waitUntilReady(page) {
  await page.waitForFunction(
    () => window.__track.some((item) => item.event === "game_ready" || item.event === "load_failed"),
    null,
    { timeout: 45_000 },
  );
  const failed = await trackEvents(page, "load_failed");
  expect(failed, `The game showed its "could not load" message: ${JSON.stringify(failed)}`).toEqual([]);
}

function gameState(page) {
  return page.evaluate(() => window.flightFriends.state());
}

// Taps a point given in game coordinates (800 x 600), with the mouse or the touch screen.
async function tapGamePoint(page, point, isMobile) {
  const [x, y] = await page.evaluate(([gx, gy]) => window.flightFriends.screenPoint(gx, gy), point);
  if (isMobile) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function tapButton(page, name, isMobile) {
  const point = await page.evaluate((button) => {
    const found = window.flightFriends.buttons()[button];
    return found ? [found[0], found[1]] : null;
  }, name);
  expect(point, `The game has no button called ${name}`).not.toBeNull();
  await tapGamePoint(page, point, isMobile);
}

// From the home page: "fly" opens the pick-a-friend page, and its start button takes off.
async function startFlight(page, isMobile) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const state = await gameState(page);
    if (state.started) return state;
    if (!state.home_preview.transition) {
      await tapButton(page, state.home_preview.stage === "pick" ? "flightStart" : "homeFly", isMobile);
    }
    await page.waitForTimeout(700);
  }
  const state = await gameState(page);
  expect(state.started, `The plane never took off. Last state: ${JSON.stringify(state.home_preview)}`).toBe(true);
  return state;
}

function expectNoProblems(problems) {
  expect(problems, `The browser reported problems:\n${problems.join("\n")}`).toEqual([]);
}

test.describe("Fluffy Pilots", () => {
  test("opens and draws the home page", async ({ page, baseURL }) => {
    const problems = await openGame(page, baseURL);
    await waitUntilReady(page);

    // The canvas must show a picture, not a single flat color.
    const colors = await page.evaluate(() => {
      const canvas = document.getElementById("canvas");
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set();
      for (let i = 0; i < data.length && seen.size < 50; i += 4 * 97) {
        seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      return seen.size;
    });
    expect(colors, "The game canvas looks blank").toBeGreaterThan(5);
    expectNoProblems(problems);
  });

  test("a flight starts, scores, crashes and starts again", async ({ page, baseURL, isMobile }) => {
    const problems = await openGame(page, baseURL);
    await waitUntilReady(page);

    await startFlight(page, isMobile);
    expect(await trackEvents(page, "game_start")).toHaveLength(1);

    // Let the game's own autopilot fly for about 15 seconds of game time.
    const flying = await page.evaluate(() => window.flightFriends.steps(900, true));
    expect(flying.score, `The plane passed no pillars on autopilot. State: ${JSON.stringify({
      score: flying.score, game_over: flying.game_over, bird_y: flying.bird_y, pipes: flying.pipes,
    })}`).toBeGreaterThanOrEqual(1);

    // Crash on purpose and wait for the results.
    if (!flying.game_over) await page.evaluate(() => window.flightFriends.crash());
    await expect.poll(async () => (await gameState(page)).game_over, { message: "The crash screen never appeared" }).toBe(true);
    expect((await trackEvents(page, "game_over")).length).toBeGreaterThanOrEqual(1);

    // The results ignore taps for a moment, then "again" starts a second flight.
    await page.waitForTimeout(900);
    await tapButton(page, "crashAgain", isMobile);
    await expect.poll(async () => (await trackEvents(page, "game_start")).length, {
      message: "Tapping again on the crash screen did not start a second flight",
    }).toBe(2);
    expectNoProblems(problems);
  });

  test("space bar flies on a computer", async ({ page, baseURL, isMobile }) => {
    test.skip(isMobile, "Phones have no keyboard");
    const problems = await openGame(page, baseURL);
    await waitUntilReady(page);
    for (let attempt = 0; attempt < 6 && !(await gameState(page)).started; attempt++) {
      await page.keyboard.press("Space");
      await page.waitForTimeout(800);
    }
    expect((await gameState(page)).started, "Space never started a flight").toBe(true);
    expectNoProblems(problems);
  });

  test("the park opens from the home page", async ({ page, baseURL, isMobile }) => {
    const problems = await openGame(page, baseURL);
    await waitUntilReady(page);
    await tapButton(page, "homeDoor", isMobile);
    await expect.poll(async () => (await gameState(page)).park.open, {
      message: "Tapping the door on the home page did not open the park",
      timeout: 8_000,
    }).toBe(true);
    expect((await trackEvents(page, "park_open")).length).toBe(1);
    // Let the park run for a few seconds, so its pets walk, eat and play.
    await page.waitForTimeout(3000);
    expectNoProblems(problems);
  });

  test("the pet upload page opens", async ({ page, baseURL }) => {
    const problems = await openGame(page, baseURL, "/submit.html");
    await expect(page.locator("body")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expectNoProblems(problems);
  });
});
