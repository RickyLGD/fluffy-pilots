// Fluffy Pilots desktop pet prototype.
// The pet uses the same 20-pose park sheets as the game (exported by export_pets.py), walks
// along the bottom of the screen, naps when you leave, chases a wiggling mouse, comes over to
// watch you type, and can be picked up, tapped and fed.
//
// In the browser the page draws a pretend desktop. Inside the Tauri app the window will be a
// transparent, always-on-top window the size of the screen that lets clicks through everywhere
// except on the pet (setIgnoreCursorEvents), so this same file drives the real desktop pet.
"use strict";

var CELL_W = PET_DATA.cell[0], CELL_H = PET_DATA.cell[1], GROUND = PET_DATA.ground;
var POSES = PET_DATA.poses;
var STEP_MS = 1000 / 60;
var SAVE_KEY = "fluffy_desktop_pet";
var DAY_MS = 24 * 3600 * 1000;

// Tuning, in game frames (60 a second) and CSS pixels at size 1.
var walk_speed = 0.6, run_speed = 2.2;
var idle_to_sleep = 25 * 1000, night_idle_to_sleep = 10 * 1000;
var chase_speed_trigger = 28, chase_reach = 380, chase_cooldown = 4 * 60;
var typing_keys_trigger = 4, typing_window = 1500;
var fullness_lost_per_hour = 12;       // A full pet gets hungry in about 6 hours.
var hungry_below = 30;
var bowl_fullness = 60, treat_fullness = 25, treat_price = 5;
var company_coin_minutes = 15, company_coins_per_day = 10;  // "Keeping you company" pays a little.
var rest_reminder_minutes = 45;
var drop_hurt_height = 220;

// Inside the Tauri app the page sits in a transparent window over the real desktop.
var TAURI = window.__TAURI__ || null;
// Three ways to show the page: the Mac app (real desktop), the website (a pet page that can pop
// out into a small always-on-top window), and ?demo, a pretend desktop for trying things out.
var MODE = TAURI ? "desktop" : /[?&]demo\b/.test(location.search) ? "demo" : "site";
document.body.className = {desktop: "real-desktop", demo: "fake-desktop", site: "site"}[MODE];
// The desk pet is for computer users: on a phone or tablet the website shows a note instead.
var PHONE = MODE === "site" && !!(window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches);
if (PHONE) document.body.classList.add("phone");
// The window the pet lives in: this page, or the pop-out window on the website.
var view = window;

var stage = document.getElementById("stage");
var pen = stage.getContext("2d");
var sheets = {};
var frames = 0;

// ---- Saved state (pet choice, size, fullness, fake coins) ----
var save = loadSave();
// The game's "桌宠" button opens pet.html?pet=<the pet you fly with>.
(function () {
    var asked = /[?&]pet=([^&]+)/.exec(location.search);
    if (asked && getPetInfo(decodeURIComponent(asked[1]))) save.pet = decodeURIComponent(asked[1]);
})();
function loadSave() {
    var saved = {};
    try { saved = JSON.parse(window.localStorage.getItem(SAVE_KEY) || "{}") || {}; } catch (error) {}
    var fresh = {pet: PET_DATA.pets[0].id, size: 2, fullness: 70, coins: 30, bowl_day: "",
                 updated: Date.now(), company_ms: 0, company_day: "", company_today: 0};
    for (var key in fresh) if (saved[key] === undefined) saved[key] = fresh[key];
    if (!getPetInfo(saved.pet)) saved.pet = fresh.pet;
    // Hunger keeps going while the pet is closed.
    var hours = Math.max(0, Date.now() - saved.updated) / 3600000;
    saved.fullness = Math.max(0, saved.fullness - hours * fullness_lost_per_hour);
    return saved;
}
function writeSave() {
    save.updated = Date.now();
    try { window.localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (error) {}
}
function today() { var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function getPetInfo(id) { for (var i = 0; i < PET_DATA.pets.length; i++) if (PET_DATA.pets[i].id === id) return PET_DATA.pets[i]; return null; }

function getSheet(id) {
    if (!sheets[id]) { sheets[id] = new Image(); sheets[id].src = "pets/" + id + ".park.png"; }
    return sheets[id];
}

// ---- The pet ----
var pet = {x: 0, y: 0, vy: 0, left: false, action: "sit", timer: 90, target: 0, on: "floor",
           hop: 0, bubble: null, bubble_timer: 0, drag: null, cooldown: 0, fall_from: 0, jump: null};

// On the website the pet grows with the room picture (it fills the page height, like the
// game's 600-pixel park); in half steps, so its pixels stay even.
function scale() {
    if (MODE !== "site" || view !== window) return save.size;
    return Math.max(save.size, Math.round(save.size * view.innerHeight / 600 * 2) / 2);
}
// On the real desktop the window ends at the top of the Dock / taskbar, so the pet stands on it.
function floorY() {
    if (view !== window) return view.innerHeight - Math.round(view.innerHeight * 0.12);
    // On the website the room picture fills the page height; its wooden floor starts at 75%.
    if (MODE === "site") return Math.round(view.innerHeight * 0.88);
    return view.innerHeight - (MODE === "desktop" ? 2 : 58);
}

function getPose() {
    var a = pet.action, pose;
    if (a === "eat" || a === "sniff") return frames % 28 < 18 ? "eat0" : "eat1";
    if (a === "pounce") return pet.timer > 20 ? "play0" : "play1";
    if (a === "jump") return pet.jump.t < 0 ? "play0" : "play1";
    if (a === "stretch") return "play0";
    pose = {walk: ["walk", 12], run: ["walk", 6], lie: ["lie", 50], play: ["play", 14], happy: ["happy", 8],
            held: ["held", 12], fall: ["held", 6], hurt: ["hurt", 10], watch: ["sit", 24], landed: ["sit", 6],
            bat: ["bat", 7]}[a] || ["sit", 24];
    return pose[0] + Math.floor(frames / pose[1]) % 2;
}

function getPlace() {
    var s = scale(), w = CELL_W * s, h = CELL_H * s;
    var lift = pet.hop > 0 ? Math.sin(Math.PI * (1 - pet.hop / 30)) * 14 * s : 0;
    return {x: pet.x - w / 2, y: pet.y - GROUND * s - lift, w: w, h: h};
}

function hitPet(x, y) {
    var info = getPetInfo(save.pet), box = info.box, place = getPlace(), s = scale();
    var bx = pet.left ? CELL_W - box[0] - box[2] : box[0];
    var left = place.x + bx * s, top = place.y + box[1] * s;
    return x >= left - 4 && x <= left + box[2] * s + 4 && y >= top - 4 && y <= top + box[3] * s + 4;
}

function setAction(action, timer) { pet.action = action; pet.timer = timer || 0; }

function say(icon, frames_shown) { pet.bubble = icon; pet.bubble_timer = frames_shown || 120; }

// ---- Where it can stand: the floor (top of the Dock) and the visible top edges of app windows ----
// desk.windows is [id, x, y, width, height] in page pixels, frontmost first. In the app it comes
// from macOS every 100ms; in the browser preview the pretend window stands in.
var desk = {windows: [], button: false, idle: 0, key_idle: 999};
var surfaces = [];

function readFakeWindows() {
    if (view !== window) return [];  // The pop-out window has no app windows in it.
    var list = [];
    Array.prototype.forEach.call(document.querySelectorAll(".fake-window"), function (element, index) {
        var box = element.getBoundingClientRect();
        if (box.width > 0) list.push([index + 1, box.left, box.top, box.width, box.height]);
    });
    return list;
}

function buildSurfaces() {
    var list = [{id: "floor", y: floorY(), x0: 0, x1: view.innerWidth}];
    var headroom = (GROUND - 6) * scale();  // Room above an edge for the pet to stand in.
    desk.windows.forEach(function (w, i) {
        var y = w[2];
        if (y < 24 || y > floorY() - 40) return;  // A maximized window's edge is right under the menu bar.
        var parts = [[Math.max(0, w[1]), Math.min(view.innerWidth, w[1] + w[3])]];
        // A window in front that covers this edge (or the space just above it) cuts it into pieces.
        for (var j = 0; j < i; j++) {
            var front = desk.windows[j];
            if (front[2] > y || front[2] + front[4] < y - headroom) continue;
            var cut = [front[1], front[1] + front[3]], next = [];
            parts.forEach(function (part) {
                if (cut[1] <= part[0] || cut[0] >= part[1]) { next.push(part); return; }
                if (cut[0] > part[0]) next.push([part[0], cut[0]]);
                if (cut[1] < part[1]) next.push([cut[1], part[1]]);
            });
            parts = next;
        }
        parts.forEach(function (part) {
            if (part[1] - part[0] >= 40 * scale()) list.push({id: w[0], y: y, x0: part[0], x1: part[1]});
        });
    });
    surfaces = list;
}

function surfaceUnder(x) {
    for (var i = 0; i < surfaces.length; i++) {
        var s = surfaces[i];
        if (s.id === pet.on && Math.abs(s.y - pet.y) < 3 && x >= s.x0 - 4 && x <= s.x1 + 4) return s;
    }
    return null;
}

function findWindow(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === id) return list[i];
    return null;
}

function updateDesk(windows) {
    var old = pet.on !== "floor" ? findWindow(desk.windows, pet.on) : null;
    var now = pet.on !== "floor" ? findWindow(windows, pet.on) : null;
    desk.windows = windows;
    // Riding a window that's being dragged: move along with it, or get shaken off.
    if (old && now && pet.action !== "jump" && pet.action !== "held" && pet.action !== "fall") {
        var dx = now[1] - old[1], dy = now[2] - old[2], moved = Math.hypot(dx, dy);
        if (moved > 0) {
            pet.x += dx; pet.y += dy; pet.target += dx;
            if (moved > 90) { buildSurfaces(); startFall(); say("!", 60); return; }
            if (moved > 6 && pet.action !== "lie" && !pet.bubble) say("!", 40);
        }
    }
    buildSurfaces();
    if (pet.on === "floor") pet.y = pet.action === "fall" || pet.action === "held" || pet.action === "jump" ? pet.y : floorY();
    if (["fall", "held", "jump"].indexOf(pet.action) < 0 && !surfaceUnder(pet.x)) startFall();
}

function startFall() { pet.on = null; pet.vy = 0; pet.fall_from = pet.y; pet.jump = null; setAction("fall", 0); }

function startJump(surface, x, then_do) {
    var distance = Math.hypot(x - pet.x, surface.y - pet.y);
    pet.jump = {x0: pet.x, y0: pet.y, x1: x, to: surface, t: -14, then: then_do || null,
                frames: Math.min(70, 26 + distance / 16), height: 30 + Math.max(0, pet.y - surface.y) * 0.35};
    pet.left = x < pet.x; pet.on = null;
    setAction("jump", 0);
}

function stepJump() {
    var j = pet.jump;
    if (++j.t < 0) return;  // Crouched, about to spring.
    var p = Math.min(1, j.t / j.frames);
    pet.x = j.x0 + (j.x1 - j.x0) * p;
    pet.y = j.y0 + (j.to.y - j.y0) * p - j.height * 4 * p * (1 - p);
    if (p < 1) return;
    // Land if the edge is still there; it may have moved or been covered mid-air.
    var landing = null;
    surfaces.forEach(function (s) { if (s.id === j.to.id && pet.x >= s.x0 - 4 && pet.x <= s.x1 + 4) landing = s; });
    pet.jump = null;
    if (!landing) { startFall(); return; }
    pet.on = landing.id; pet.y = landing.y;
    if (j.then === "watch") { pet.left = false; setAction("watch", 300); say("♪", 90); }
    else setAction("landed", 24);
}

function randomSpotOn(s) {
    var margin = Math.min(30 * scale(), (s.x1 - s.x0) / 2);
    return s.x0 + margin + Math.random() * (s.x1 - s.x0 - 2 * margin);
}

// ---- What the person is doing ----
var input = {last: Date.now(), active_since: Date.now(), mouse: {x: -999, y: -999}, speed: 0,
             keys: [], awake_ms: 0};

function noteActivity() {
    var now = Date.now();
    if (now - input.last > 60 * 1000) input.active_since = now;  // A real break resets the rest timer.
    input.last = now;
}

function isNight() { var h = new Date().getHours(); return h >= 23 || h < 6; }

function isTyping() {
    var now = Date.now();
    input.keys = input.keys.filter(function (t) { return now - t < typing_window; });
    return input.keys.length >= (TAURI ? 5 : typing_keys_trigger);
}

// You're typing in the frontmost window: hop onto its top edge, near the left, and keep you company.
function goWatchTyping() {
    var front = desk.windows[0], spot = null, s = scale();
    if (front) surfaces.forEach(function (surface) { if (!spot && surface.id === front[0]) spot = surface; });
    if (spot) {
        var x = Math.max(spot.x0 + 20 * s, Math.min(spot.x1 - 20 * s, front[1] + 40 * s));
        if (pet.on === spot.id) { pet.target = x; pet.going_to_watch = true; setAction("walk", 0); }
        else startJump(spot, x, "watch");
    } else if (pet.on === "floor") {
        pet.target = front ? Math.max(60, front[1] - 40) : pet.x; pet.going_to_watch = true; setAction("walk", 0);
    }
}

// ---- Thinking, once per game frame ----
function think() {
    var s = scale(), now = Date.now();
    var idle = now - input.last;
    if (pet.bubble_timer > 0 && --pet.bubble_timer === 0) pet.bubble = null;
    if (pet.hop > 0) pet.hop--;
    if (pet.cooldown > 0) pet.cooldown--;
    if (pet.action === "held") return;
    if (pet.action === "jump") { stepJump(); return; }
    // Never wander off the sides (the window may also have been tiny when the page opened).
    var min_x = 22 * s, max_x = view.innerWidth - 22 * s;
    if (max_x > min_x) pet.x = Math.max(min_x, Math.min(max_x, pet.x));
    if (pet.on === "floor" && pet.action !== "fall" && floorY() > 0) pet.y = floorY();

    if (pet.action === "fall") {
        pet.vy = Math.min(pet.vy + 0.6, 18);
        var next = pet.y + pet.vy, land = null;
        surfaces.forEach(function (surface) {
            if (surface.y >= pet.y - 1 && surface.y <= next && pet.x >= surface.x0 && pet.x <= surface.x1 &&
                (!land || surface.y < land.y)) land = surface;
        });
        if (!land && next >= floorY()) land = surfaces[0];
        if (!land) { pet.y = next; return; }
        pet.y = land.y; pet.vy = 0; pet.on = land.id;
        if (pet.y - pet.fall_from > drop_hurt_height) { setAction("hurt", 50); say("!", 60); }
        else setAction("landed", 30);
        return;
    }

    // Asleep: breathes slowly and wakes with a stretch once you're back for a moment.
    if (pet.action === "lie") {
        if (pet.timer > 0 && --pet.timer === 0) wake();
        else if (pet.timer === 0 && idle < 200 && now - input.active_since > 1500 && !isNight()) wake();
        return;
    }

    // Leave the computer long enough and it curls up.
    var nap_after = isNight() ? night_idle_to_sleep : idle_to_sleep;
    if (idle > nap_after && ["eat", "sniff"].indexOf(pet.action) < 0) { setAction("lie", 0); pet.bubble = null; return; }

    var mouse = input.mouse, ground = surfaceUnder(pet.x) || surfaces[0];
    var free = ["sit", "walk", "watch", "landed", "run"].indexOf(pet.action) >= 0;

    // Something being dragged nearby (a file, a window, a selection): chase it and swat at it.
    var dragged = desk.button && !pet.drag && input.speed > 1.5;
    var near = Math.abs(mouse.x - pet.x) < chase_reach && mouse.y > pet.y - 420 && mouse.y < pet.y + 30;
    if (dragged && near && (free || pet.action === "bat")) {
        if (Math.abs(mouse.x - pet.x) < 26 * s && mouse.y < pet.y - 10 * s) {
            if (pet.action !== "bat") say("!", 30);
            pet.left = mouse.x < pet.x; setAction("bat", 30);
            return;
        }
        if (pet.action !== "run") setAction("run", 0);
    } else if (pet.cooldown === 0 && input.speed > chase_speed_trigger && near && free && pet.action !== "run") {
        // A quickly wiggling mouse nearby is irresistible too.
        setAction("run", 0); say("!", 40);
    }
    if (pet.action === "bat") { if (--pet.timer <= 0) setAction("sit", 60); return; }
    if (pet.action === "run") {
        var goal = Math.max(ground.x0 + 10, Math.min(ground.x1 - 10, mouse.x)), gap = goal - pet.x;
        pet.left = mouse.x < pet.x;
        if (Math.abs(mouse.x - pet.x) < 18 * s && !desk.button) { setAction("pounce", 36); pet.cooldown = chase_cooldown; }
        else if (Math.abs(gap) > 1) pet.x += Math.sign(gap) * Math.min(Math.abs(gap), run_speed * s);
        if (input.speed < 2 && Math.abs(mouse.x - pet.x) > 200 && !desk.button) { setAction("sit", 60); pet.cooldown = chase_cooldown; }
        return;
    }

    // Typing: come and keep you company on top of the window you're typing in.
    if (isTyping() && ["sit", "walk", "landed"].indexOf(pet.action) >= 0 && !pet.going_to_watch) goWatchTyping();

    if (pet.action === "walk") {
        var hungry = save.fullness < hungry_below;
        var step = walk_speed * s * (hungry ? 0.6 : 1), left = pet.target - pet.x;
        pet.left = left < 0;
        if (Math.abs(left) <= step) {
            pet.x = pet.target;
            if (pet.going_to_watch) { pet.going_to_watch = false; pet.left = false; setAction("watch", 300); say("♪", 90); }
            else setAction("sit", 120 + Math.random() * 240);
        } else pet.x += Math.sign(left) * step;
        if (!surfaceUnder(pet.x)) { pet.going_to_watch = false; startFall(); }
        return;
    }

    if (pet.action === "watch") {
        if (isTyping()) { pet.timer = Math.max(pet.timer, 240); if (frames % 240 === 0) say("♪", 70); }
        if (frames % 90 === 0 && Math.random() < 0.3) pet.hop = 30;
    }

    // Sitting pets look at a nearby mouse.
    if ((pet.action === "sit" || pet.action === "watch") && Math.abs(mouse.x - pet.x) < 260 && Math.abs(mouse.y - pet.y) < 260) {
        pet.left = mouse.x < pet.x;
    }

    if (pet.timer > 0 && --pet.timer > 0) return;
    if (pet.action === "sniff") { finishSniff(); return; }
    if (pet.action === "eat" || pet.action === "happy") { setAction("sit", 90); return; }
    decide();
}

function decide() {
    var info = getPetInfo(save.pet), roll = Math.random(), ground = surfaceUnder(pet.x) || surfaces[0];
    if (save.fullness < hungry_below && Math.random() < 0.5) { say("bowl", 150); setAction("sit", 200); return; }
    var nap = {dog: 0.08, cat: 0.12}[info.kind] || 0.08;
    var climb = {dog: 0.18, cat: 0.3}[info.kind] || 0.2;
    var others = surfaces.filter(function (surface) { return surface !== ground; });
    if (roll < nap) { setAction("lie", 600 + Math.random() * 900); }
    else if (roll < nap + climb && others.length) {
        // Hop onto a window's top edge (or back down to the Dock).
        var to = others[Math.floor(Math.random() * others.length)];
        startJump(to, randomSpotOn(to));
    }
    else if (roll < nap + climb + 0.1) setAction("play", 90);
    else if (roll < 0.8) { pet.target = randomSpotOn(ground); setAction("walk", 0); }
    else setAction("sit", 120 + Math.random() * 300);
}

function wake() { setAction("stretch", 50); pet.bubble = null; input.active_since = Date.now(); }

// ---- Files dropped on the pet: it gives them a good sniff ----
function sniffFiles(paths) {
    if (!paths || !paths.length) return;
    var name = String(paths[0]).split(/[\\/]/).pop(), ext = (name.split(".").length > 1 ? name.split(".").pop() : "").toLowerCase();
    var kind = /^(png|jpe?g|gif|heic|webp|bmp)$/.test(ext) ? "photo" : /^(mp3|m4a|wav|flac|aac)$/.test(ext) ? "music"
             : /^(mp4|mov|m4v|webm)$/.test(ext) ? "video" : ext ? "file" : "folder";
    pet.sniffed = {name: name.length > 16 ? name.slice(0, 15) + "…" : name, kind: kind, more: paths.length - 1};
    pet.bubble = null; setAction("sniff", 70);
}
function finishSniff() {
    var f = pet.sniffed || {kind: "file", name: ""}, words = {
        photo: "是照片！真好看", music: "有音乐！", video: "要一起看吗？", folder: "里面藏了什么？", file: "嗅嗅… " + f.name
    }[f.kind];
    if (f.more > 0) words += "（还有 " + f.more + " 个）";
    say({text: words}, 180);
    if (f.kind === "photo" || f.kind === "music") { setAction("happy", 70); pet.hop = 30; } else setAction("sit", 120);
}

// ---- Hunger, coins, reminders (checked once a second) ----
var last_tick = Date.now();
function tick() {
    var now = Date.now(), ms = now - last_tick;
    last_tick = now;
    save.fullness = Math.max(0, save.fullness - ms / 3600000 * fullness_lost_per_hour);
    // Coins for keeping you company: only while you're actually at the computer.
    if (now - input.last < 60 * 1000 && pet.action !== "lie") {
        if (save.company_day !== today()) { save.company_day = today(); save.company_today = 0; }
        save.company_ms += ms;
        if (save.company_ms >= company_coin_minutes * 60000 && save.company_today < company_coins_per_day) {
            save.company_ms = 0; save.company_today++; save.coins++; say("coin", 120);
        }
    }
    if (now - input.active_since > rest_reminder_minutes * 60000 && pet.action !== "lie") {
        input.active_since = now; say("rest", 400); pet.hop = 30;
    }
    writeSave();
    refreshPanel();
}

function feed(kind) {
    if (kind === "bowl") {
        if (save.bowl_day === today()) return;
        save.bowl_day = today(); save.fullness = Math.min(100, save.fullness + bowl_fullness);
        setAction("eat", 240);
    } else {
        if (save.coins < treat_price) return;
        save.coins -= treat_price; save.fullness = Math.min(100, save.fullness + treat_fullness);
        setAction("eat", 120); pet.after_treat = true;
    }
    pet.food = kind; pet.bubble = null;
    writeSave(); refreshPanel(); hideMenu();
}

// ---- Little effects ----
// A puff of cream dust, when a different pet pops out.
var puffs = [];
function puff() {
    var s = scale();
    for (var i = 0; i < 10; i++) {
        var angle = Math.PI * (i / 9), speed = 1.2 + Math.random() * 1.6;
        puffs.push({x: pet.x, y: pet.y - 22 * s, vx: Math.cos(angle) * speed * 1.6, vy: -Math.sin(angle) * speed,
                    size: (3 + Math.floor(Math.random() * 3)) * s, life: 26 + Math.floor(Math.random() * 10)});
    }
}
function drawPuffs() {
    puffs = puffs.filter(function (p) { return p.life > 0; });
    puffs.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.03; p.life--;
        var size = Math.max(2, Math.round(p.size * Math.min(1, p.life / 20)));
        pen.globalAlpha = Math.min(1, p.life / 12);
        pen.fillStyle = "#342014"; pen.fillRect(Math.round(p.x - size / 2) - 2, Math.round(p.y - size / 2) - 2, size + 4, size + 4);
        pen.fillStyle = "#fff1d0"; pen.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size, size);
    });
    pen.globalAlpha = 1;
}

// The pet's name on a little sign while the pointer rests on it.
function drawNameTag(place) {
    var m = input.mouse;
    if (pet.drag || pet.bubble || ["fall", "jump", "held"].indexOf(pet.action) >= 0 || !hitPet(m.x, m.y)) return;
    var info = getPetInfo(save.pet), s = scale();
    var big = s >= 2.5 ? 2 : 1;  // The pixel font is crisp at 12 or 24 pixels.
    pen.font = 12 * big + "px FlightFriendsPixel, -apple-system, 'PingFang SC', sans-serif";
    var text = info.name, w = Math.round(pen.measureText(text).width) + 14 * big, h = 22 * big;
    var x = Math.round(Math.max(4, Math.min(view.innerWidth - w - 4, pet.x - w / 2)));
    var y = Math.round(place.y + getPetInfo(save.pet).box[1] * s - h - 8);
    pen.fillStyle = "#342014"; pen.fillRect(x - 3, y - 3, w + 6, h + 7);
    pen.fillStyle = "#488a42"; pen.fillRect(x, y, w, h);
    pen.fillStyle = "#265c30"; pen.fillRect(x, y + h - 3, w, 3);
    pen.fillStyle = "#fff1d0"; pen.textBaseline = "middle"; pen.textAlign = "center";
    pen.fillText(text, x + w / 2, y + h / 2);
    pen.textAlign = "start";
}

// ---- Drawing ----
var ICONS = {
    heart: [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."],
    "!": ["XX", "XX", "XX", "XX", "..", "XX"],
    z: ["XXXX", "..X.", ".X..", "XXXX"],
    "♪": ["..XXX", "..X.X", "..X..", "XXX..", "XXX.."],
    bowl: ["..ooo..", ".ooooo.", "XXXXXXX", ".XXXXX.", "..XXX.."],
    treat: ["......X", "....XX.", "..XXX..", ".XXX...", "XX....."],
    coin: [".XXX.", "XXoXX", "XXoXX", "XXoXX", ".XXX."],
    heart_empty: [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."],
    fish: ["..X....", ".XXX..X", "XXoXXXX", ".XXX..X", "..X...."],
    moon: ["..XXX", ".XX..", "XX...", "XX...", ".XX..", "..XXX"],
    sun: ["X..X..X", ".X.X.X.", "..XXX..", "XXXXXXX", "..XXX..", ".X.X.X.", "X..X..X"],
    paw: [".X.X.", "X...X", ".....", ".XXX.", "XXXXX", ".XXX."],
    window: ["XXXXXXX", "XoooooX", "XoXXXXX", "XoX...X", "XXX...X", "..XXXXX"],
    x: ["X...X", ".X.X.", "..X..", ".X.X.", "X...X"]
};
var ICON_COLORS = {heart: "#e23434", "!": "#e23434", z: "#5a6fb0", "♪": "#342014", bowl: "#4f86c6", coin: "#ffc83e", treat: "#a8432c",
    heart_empty: "#e3c28f", fish: "#5f8fbf", moon: "#5a6fb0", sun: "#f0a020", paw: "#8a5a34", window: "#342014", x: "#8a5a34"};
var ICON_INNER = {coin: "#c98a1c", bowl: "#9a5a26", fish: "#fff1d0", window: "#bfe3f5"};

function drawIcon(name, x, y, block) {
    var rows = ICONS[name];
    for (var r = 0; r < rows.length; r++) for (var c = 0; c < rows[r].length; c++) {
        var ch = rows[r][c];
        if (ch === ".") continue;
        pen.fillStyle = ch === "o" ? (ICON_INNER[name] || "#f7d69e") : ICON_COLORS[name];
        pen.fillRect(Math.round(x + c * block), Math.round(y + r * block), block, block);
    }
}

function drawBubble(place) {
    if (!pet.bubble) return;
    var s = scale(), block = Math.max(2, Math.round(s * 1.5));
    var headX = pet.x + (pet.left ? -12 : 12) * s, top = place.y + 2 * s;
    var text = pet.bubble === "rest" ? "陪你好久啦，休息一下？" : pet.bubble.text || null;
    var w = text ? 0 : 7 * block + 12, h = 7 * block + 8;
    if (text) { pen.font = "12px FlightFriendsPixel, -apple-system, 'PingFang SC', sans-serif"; w = pen.measureText(text).width + 18; h = 28; }
    var bx = Math.round(Math.min(view.innerWidth - w - 4, Math.max(4, headX - w / 2))), by = Math.round(top - h - 10);
    // Pixel speech bubble: cream with an ink outline and a little tail.
    pen.fillStyle = "#342014"; pen.fillRect(bx - 2, by - 2, w + 4, h + 4);
    pen.fillStyle = "#fff1d0"; pen.fillRect(bx, by, w, h);
    pen.fillStyle = "#342014"; pen.fillRect(Math.round(headX) - 3, by + h + 2, 6, 4); pen.fillRect(Math.round(headX) - 1, by + h + 6, 3, 3);
    if (text) { pen.fillStyle = "#342014"; pen.textBaseline = "middle"; pen.fillText(text, bx + 9, by + h / 2 + 1); return; }
    var rows = ICONS[pet.bubble], iw = rows[0].length * block, ih = rows.length * block;
    drawIcon(pet.bubble, bx + (w - iw) / 2, by + (h - ih) / 2, block);
}

// Like the park in the game: little cream z's with an ink outline float up from a napping pet,
// the second one bigger, fading as they rise. No speech bubble.
var Z_GLYPH = ["XXXX", "..X.", ".X..", "XXXX"];
function drawSleepZs(place) {
    var info = getPetInfo(save.pet), box = info.box, s = scale();
    var head_x = pet.left ? place.x + (CELL_W - box[0] - box[2]) * s + 4 * s : place.x + (box[0] + box[2]) * s - 4 * s;
    var top = place.y + box[1] * s;
    for (var number = 0; number < 2; number++) {
        var rise = (frames + number * 40) % 80, block = Math.max(1, Math.round(s * (2 + number) / 2));
        var x = Math.round(head_x + (pet.left ? -1 : 1) * (rise / 8) * s - (pet.left ? 4 * block : 0));
        var y = Math.round(top + 16 * s - rise / 2 * s - 4 * block);  // A lying head sits lower than the sheet's tallest pose.
        pen.globalAlpha = rise < 55 ? 1 : (80 - rise) / 25;
        for (var pass = 0; pass < 2; pass++) {
            pen.fillStyle = pass ? "#fff1d0" : "#342014";
            for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) {
                if (Z_GLYPH[r][c] !== "X") continue;
                if (pass) pen.fillRect(x + c * block, y + r * block, block, block);
                else pen.fillRect(x + c * block - block, y + r * block - block, block * 3, block * 3);
            }
        }
        pen.globalAlpha = 1;
    }
}

// The shadow falls on whatever the pet is standing on, or the first edge below it in the air.
function shadowY() {
    if (pet.on) return pet.y;
    var best = floorY();
    surfaces.forEach(function (s) { if (s.y >= pet.y - 1 && s.y < best && pet.x >= s.x0 && pet.x <= s.x1) best = s.y; });
    return best;
}

function draw() {
    var ratio = view.devicePixelRatio || 1, width = view.innerWidth, height = view.innerHeight;
    if (stage.width !== Math.round(width * ratio) || stage.height !== Math.round(height * ratio)) {
        stage.width = Math.round(width * ratio); stage.height = Math.round(height * ratio);
    }
    pen.setTransform(ratio, 0, 0, ratio, 0, 0);
    pen.imageSmoothingEnabled = false;
    pen.clearRect(0, 0, width, height);
    var sheet = getSheet(save.pet), place = getPlace(), s = scale();
    if (!sheet.complete || !sheet.naturalWidth) return;

    // Soft shadow on the floor, smaller while in the air.
    var below = shadowY();
    var air = Math.max(0, below - pet.y) + (pet.hop ? 14 * s * Math.sin(Math.PI * (1 - pet.hop / 30)) : 0);
    var shadow = Math.max(0.35, 1 - air / 300);
    pen.fillStyle = "rgba(52,32,20,0.18)";
    pen.fillRect(Math.round(pet.x - 18 * s * shadow), Math.round(below - 1 * s), Math.round(36 * s * shadow), Math.round(3 * s));

    var column = POSES.indexOf(getPose());
    if (pet.left) {
        pen.save(); pen.translate(Math.round(place.x + place.w), Math.round(place.y)); pen.scale(-1, 1);
        pen.drawImage(sheet, column * CELL_W, 0, CELL_W, CELL_H, 0, 0, place.w, place.h);
        pen.restore();
    } else {
        pen.drawImage(sheet, column * CELL_W, 0, CELL_W, CELL_H, Math.round(place.x), Math.round(place.y), place.w, place.h);
    }

    if (pet.action === "eat") {
        // The bowl (or treat) sits right under the mouth.
        var mouth = getPetInfo(save.pet).mouth || [41, 48];
        var mx = pet.left ? CELL_W - mouth[0] : mouth[0];
        var block = Math.max(3, s * 2), food = pet.food === "bowl" ? "bowl" : "treat";
        drawIcon(food, place.x + mx * s - 3.5 * block, pet.y - ICONS[food].length * block, block);
    }
    if (pet.action === "lie") drawSleepZs(place);
    drawPuffs();
    drawBubble(place);
    drawNameTag(place);
}

// ---- Main loop ----
var then = performance.now(), spare = 0;
function loop(now) {
    spare = Math.min(spare + now - then, 200); then = now;
    while (spare >= STEP_MS) {
        spare -= STEP_MS; frames++;
        input.speed *= 0.85;
        think();
        if (pet.action === "landed" && pet.timer === 0) setAction("sit", 60);
        if (pet.action === "eat" && pet.timer === 1 && pet.after_treat) { pet.after_treat = false; setAction("happy", 60); say("heart", 90); }
    }
    draw();
    schedule();
}
// Frames come from the window the pet is in, so the pop-out keeps moving while this tab is hidden.
function schedule() {
    var from = view;
    from.requestAnimationFrame(function (now) { if (from === view) loop(now); });
}

// ---- Pointer: tap, drag, right-click ----
function listen(win) {
win.addEventListener("pointermove", function (event) {
    if (win !== view) return;
    var m = input.mouse;
    if (m.x > -999) input.speed = Math.max(input.speed, Math.hypot(event.clientX - m.x, event.clientY - m.y));
    m.x = event.clientX; m.y = event.clientY;
    noteActivity();
    var drag = pet.drag;
    if (drag) {
        if (!drag.moved && Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) > 6) {
            drag.moved = true; setAction("held", 0); pet.bubble = null; pet.on = null; pet.jump = null;
        }
        if (drag.moved) { pet.x = event.clientX + drag.dx; pet.y = Math.min(floorY(), event.clientY + drag.dy); }
    }
    if (drag && drag.moved) clearTimeout(drag.press);
    win.document.body.style.cursor = drag && drag.moved ? "grabbing" : hitPet(event.clientX, event.clientY) ? "grab" : "";
}, true);

win.addEventListener("pointerdown", function (event) {
    if (win !== view) return;
    noteActivity();
    if (!TAURI && event.button === 0) desk.button = true;
    if (event.button !== 0 || event.target.closest(".panel")) return;
    hideMenu();
    if (!hitPet(event.clientX, event.clientY)) return;
    event.preventDefault();
    pet.drag = {x0: event.clientX, y0: event.clientY, dx: pet.x - event.clientX, dy: pet.y - event.clientY, moved: false};
    // On a phone there's no right-click: press and hold the pet for the menu.
    if (event.pointerType !== "mouse") {
        var x = event.clientX, y = event.clientY;
        pet.drag.press = setTimeout(function () { if (pet.drag && !pet.drag.moved) { pet.drag = null; showMenu(x, y); } }, 500);
    }
}, true);

win.addEventListener("pointerup", function () {
    if (win !== view) return;
    if (!TAURI) desk.button = false;
    var drag = pet.drag;
    if (!drag) return;
    pet.drag = null;
    clearTimeout(drag.press);
    if (drag.moved) { startFall(); pet.fall_from = pet.y; return; }
    // A tap: wake it gently if it's asleep, otherwise a happy little hop.
    if (pet.action === "lie") { wake(); say("!", 50); return; }
    setAction("happy", 60); pet.hop = 30; say("heart", 80);
}, true);

win.addEventListener("contextmenu", function (event) {
    if (win !== view) return;
    if (!hitPet(event.clientX, event.clientY)) return;
    event.preventDefault();
    showMenu(event.clientX, event.clientY);
});

win.addEventListener("keydown", function () { input.keys.push(Date.now()); noteActivity(); }, true);
}
listen(window);

// ---- Panels ----
var menu = document.getElementById("menu");
function showMenu(x, y) {
    refreshPanel();
    menu.style.display = "block";
    var w = menu.offsetWidth, h = menu.offsetHeight, width = view.innerWidth, height = view.innerHeight;
    var left, top;
    if (y - h - 12 >= 8) { left = x - w / 2; top = y - h - 12; }  // Above the pointer, centred.
    else {
        // Not enough room above (a short screen): open beside the pet, on the roomier side.
        left = x + 48 + w < width ? x + 48 : x - 48 - w;
        top = Math.min(height - h - 10, Math.max(8, y - h / 2));
    }
    menu.style.left = Math.round(Math.max(6, Math.min(left, width - w - 10))) + "px";
    menu.style.top = Math.round(Math.max(6, top)) + "px";
}
function hideMenu() { menu.style.display = "none"; }

// A pixel icon as a picture for the page's buttons, drawn from the same tiny grids.
var icon_cache = {};
function iconURL(name, block) {
    var key = name + block;
    if (!icon_cache[key]) {
        var rows = ICONS[name], paper = document.createElement("canvas");
        paper.width = rows[0].length * block; paper.height = rows.length * block;
        var g = paper.getContext("2d");
        rows.forEach(function (row, r) {
            for (var c = 0; c < row.length; c++) {
                if (row[c] === ".") continue;
                g.fillStyle = row[c] === "o" ? (ICON_INNER[name] || "#f7d69e") : ICON_COLORS[name];
                g.fillRect(c * block, r * block, block, block);
            }
        });
        icon_cache[key] = paper.toDataURL();
    }
    return icon_cache[key];
}
function setIcon(img, name, block) { img.src = iconURL(name, block || 3); img.dataset.icon = name; }
Array.prototype.forEach.call(document.querySelectorAll("img[data-icon]"), function (img) { setIcon(img, img.dataset.icon); });

function drawPetThumb(canvas, id) {
    var sheet = getSheet(id), paint = function () {
        var g = canvas.getContext("2d");
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.drawImage(sheet, POSES.indexOf("sit0") * CELL_W, 0, CELL_W, CELL_H, 0, 0, canvas.width, canvas.height);
    };
    if (sheet.complete && sheet.naturalWidth) paint(); else sheet.addEventListener("load", paint);
}

function refreshPanel() {
    var info = getPetInfo(save.pet), full = Math.round(save.fullness);
    // Five hearts, like the game's hearts: each one is 20% full.
    var hearts = document.getElementById("hearts"), shown = Math.round(full / 20);
    if (hearts.dataset.shown !== String(shown)) {
        hearts.dataset.shown = shown; hearts.innerHTML = "";
        for (var i = 0; i < 5; i++) {
            var heart = document.createElement("img");
            heart.className = "ico"; setIcon(heart, i < shown ? "heart" : "heart_empty", 3);
            hearts.appendChild(heart);
        }
    }
    hearts.title = "饱腹 " + full + "%";
    document.getElementById("coins").textContent = save.coins;
    var name = document.getElementById("current-name");
    if (name.dataset.pet !== info.id) {
        name.dataset.pet = info.id; name.textContent = info.name;
        document.getElementById("current-breed").textContent = info.breed;
        drawPetThumb(document.getElementById("current-thumb"), info.id);
    }
    menu.querySelector("#menu-title").textContent = info.name;
    menu.querySelector("#menu-full").textContent = "饱腹 " + full + "%";
    var bowl = menu.querySelector("#feed-bowl");
    bowl.disabled = save.bowl_day === today();
    bowl.querySelector("span").textContent = bowl.disabled ? "今天的一碗吃过了" : "今天的免费一碗";
    var treat = menu.querySelector("#feed-treat");
    setIcon(treat.querySelector("img"), info.kind === "cat" ? "fish" : "treat");
    treat.querySelector("span").textContent = (info.kind === "cat" ? "小鱼干" : "肉干") + " · " + treat_price + " 币";
    treat.disabled = save.coins < treat_price;
}

document.getElementById("feed-bowl").onclick = function () { feed("bowl"); };
document.getElementById("feed-treat").onclick = function () { feed("treat"); };
document.getElementById("pet-sleep").onclick = function () { setAction("lie", 900); pet.bubble = null; hideMenu(); };
document.getElementById("pet-wake").onclick = function () { if (pet.action === "lie") wake(); hideMenu(); };
document.getElementById("pet-settings").onclick = function () {
    hideMenu();
    if (TAURI) document.body.classList.add("show-settings");
    if (view !== window) callBack();
    setPanelSmall(false);
};
document.getElementById("pet-quit").onclick = function () { if (TAURI) TAURI.core.invoke("quit"); };

var kind_filter = "all";
function choosePet(id) {
    if (id === save.pet) return;
    save.pet = id; writeSave(); buildPicker(); refreshPanel();
    puff();
    // A little hop and a heart, so you can see who just came out.
    if (pet.action === "lie" || pet.action === "fall" || pet.action === "jump") return;
    setAction("happy", 60); pet.hop = 30; say("heart", 80);
}
function buildPicker() {
    var picker = document.getElementById("picker");
    picker.innerHTML = "";
    PET_DATA.pets.forEach(function (info) {
        if (kind_filter !== "all" && info.kind !== kind_filter) return;
        var card = document.createElement("button"), thumb = document.createElement("canvas"), label = document.createElement("span");
        card.className = "pet-card" + (info.id === save.pet ? " on" : "");
        card.title = info.name + " · " + info.breed;
        thumb.width = CELL_W; thumb.height = CELL_H;
        drawPetThumb(thumb, info.id);
        label.textContent = info.name;
        card.appendChild(thumb); card.appendChild(label);
        card.onclick = function () { choosePet(info.id); };
        picker.appendChild(card);
    });
}
document.querySelectorAll("#kinds button").forEach(function (button) {
    button.onclick = function () {
        kind_filter = button.dataset.kind;
        document.querySelectorAll("#kinds button").forEach(function (b) { b.classList.toggle("on", b === button); });
        buildPicker();
    };
});
document.querySelectorAll("[data-size]").forEach(function (button) {
    button.classList.toggle("on", Number(button.dataset.size) === save.size);
    button.onclick = function () {
        save.size = Number(button.dataset.size); writeSave();
        document.querySelectorAll("[data-size]").forEach(function (b) { b.classList.toggle("on", b === button); });
        pet.y = floorY(); pet.hop = 30;
    };
});
function setPanelSmall(small) {
    var panel = document.getElementById("settings");
    panel.classList.toggle("small", small);
    document.getElementById("collapse").textContent = small ? "换宠物" : "收起";
    try { window.localStorage.setItem(SAVE_KEY + "_small", small ? "1" : ""); } catch (error) {}
}
document.getElementById("collapse").onclick = function () {
    if (TAURI) { document.body.classList.remove("show-settings"); return; }
    setPanelSmall(!document.getElementById("settings").classList.contains("small"));
};
(function () {
    var small = null;
    try { small = window.localStorage.getItem(SAVE_KEY + "_small"); } catch (error) {}
    // A phone screen starts with the card folded up, so the pet has room.
    setPanelSmall(small === null ? innerWidth < 600 || innerHeight < 500 : small === "1");
})();

// One tip at a time; tap it for the next.
var TIPS = {
    site: ["点它，它会开心地蹦一下", "按住拖起来，松手它会掉下来", "右键（手机长按）它，打开喂食菜单",
           "一会儿不理它，它就睡着了", "快速晃鼠标，它会追过来扑", "把照片拖到它身上，它会闻一闻",
           "点右上角“带出来”，它进小窗一直陪你（电脑 Chrome / Edge）", "每天有一碗免费的粮，零食要花金币"],
    demo: ["打字试试，它会跳上窗口陪你", "拖动窗口，它会跟着走；拖太快会掉下来", "按住拖它，扔到窗口顶上"],
    desktop: ["右键它打开菜单", "拖文件到它身上，它会闻一闻"]
}[MODE];
var tip_index = Math.floor(Math.random() * TIPS.length);
function showTip(step) {
    tip_index = (tip_index + (step || 0)) % TIPS.length;
    document.getElementById("tip").textContent = "小提示：" + TIPS[tip_index];
}
document.getElementById("tip").onclick = function () { showTip(1); };
showTip(0);
setInterval(function () { showTip(1); }, 9000);

// ---- Real desktop: the cursor anywhere on screen, and letting clicks through ----
var window_wants_clicks = false;
function isOverPanel(x, y) {
    return ["settings", "menu"].some(function (id) {
        var panel = document.getElementById(id);
        if (getComputedStyle(panel).display === "none") return false;
        var box = panel.getBoundingClientRect();
        return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    });
}
function updateClickThrough() {
    var m = input.mouse;
    // Clicks elsewhere go to other apps, so the menu closes once the cursor wanders well away.
    if (menu.style.display === "block") {
        var box = menu.getBoundingClientRect();
        if (m.x < box.left - 150 || m.x > box.right + 150 || m.y < box.top - 150 || m.y > box.bottom + 250) hideMenu();
    }
    var wants = !!pet.drag || hitPet(m.x, m.y) || isOverPanel(m.x, m.y);
    if (wants !== window_wants_clicks) {
        window_wants_clicks = wants;
        TAURI.core.invoke("set_hit", {over: wants});
    }
}
if (TAURI) {
    TAURI.event.listen("cursor", function (event) {
        var x = event.payload[0], y = event.payload[1], m = input.mouse;
        if (x === m.x && y === m.y) return;
        if (m.x > -999) input.speed = Math.max(input.speed, Math.hypot(x - m.x, y - m.y) / 2);
        m.x = x; m.y = y;
        noteActivity();
        // While dragging, the page's own pointer events move the pet.
    });
    // Input idle times, mouse button and app windows, from macOS every 100ms.
    TAURI.event.listen("desk", function (event) {
        var p = event.payload;
        desk.idle = p[0]; desk.key_idle = p[1]; desk.button = p[2];
        if (desk.idle < 0.6) noteActivity();
        if (desk.key_idle < 0.3) input.keys.push(Date.now());
        updateDesk(p[3]);
    });
    // Files dragged onto the pet.
    TAURI.event.listen("tauri://drag-enter", function () { if (pet.action !== "lie") { say("!", 50); setAction("sit", 120); } });
    TAURI.event.listen("tauri://drag-drop", function (event) { sniffFiles(event.payload && event.payload.paths); });
    setInterval(updateClickThrough, 50);
}

// ---- Start ----
window.addEventListener("resize", function () { pet.x = Math.min(pet.x, view.innerWidth - 40); updateDesk(TAURI ? desk.windows : readFakeWindows()); });
pet.x = view.innerWidth * (MODE === "site" ? 0.6 : 0.3); pet.y = floorY();

// ---- Website: pop the pet out into a small window that stays on top of everything ----
// Document Picture-in-Picture works in Chrome and Edge on computers; elsewhere the button hides.
var pop_button = document.getElementById("pop-out"), pop_note = document.getElementById("popped");
function popOut() {
    window.documentPictureInPicture.requestWindow({width: 360, height: 240}).then(function (pip) {
        Array.prototype.forEach.call(document.styleSheets, function (sheet) {
            var style = pip.document.createElement("style");
            style.textContent = Array.prototype.map.call(sheet.cssRules, function (rule) { return rule.cssText; }).join("\n");
            pip.document.head.appendChild(style);
        });
        pip.document.title = "飞行搭档 · 桌宠";
        pip.document.body.className = "pip";
        pip.document.body.append(stage, menu);
        hideMenu();
        view = pip; listen(pip);
        pet.x = pip.innerWidth / 2; pet.on = "floor"; pet.jump = null; pet.drag = null;
        updateDesk([]); pet.y = floorY(); setAction("happy", 60); pet.hop = 30; say("heart", 80);
        document.body.classList.add("popped");
        pip.addEventListener("resize", function () { if (view === pip) updateDesk([]); });
        pip.addEventListener("pagehide", function () {
            document.body.append(stage, menu);
            view = window; document.body.classList.remove("popped");
            pet.x = Math.min(pet.x, innerWidth - 40); pet.on = "floor"; pet.jump = null; pet.drag = null;
            updateDesk(readFakeWindows()); pet.y = floorY(); setAction("landed", 30);
            schedule();
        });
        schedule();
    }).catch(function () {});
}
function callBack() { if (view !== window) view.close(); }
if (pop_button) {
    if (MODE === "site" && "documentPictureInPicture" in window) pop_button.onclick = popOut;
    else pop_button.style.display = "none";
}
if (pop_note) pop_note.querySelector("button").onclick = callBack;
if (!TAURI) {
    // Browser preview: the pretend window is the only app window; dropping a file on the pet works too.
    setInterval(function () { updateDesk(readFakeWindows()); }, 100);
    window.addEventListener("dragover", function (event) { event.preventDefault(); });
    window.addEventListener("drop", function (event) {
        event.preventDefault();
        if (!hitPet(event.clientX, event.clientY)) return;
        sniffFiles(Array.prototype.map.call(event.dataTransfer.files, function (file) { return file.name; }));
    });
}
buildSurfaces();
buildPicker(); refreshPanel();
setInterval(tick, 1000);
schedule();
