// Preserve old progress before binding it to an email account. All writes use a revision
// and a durable operation id, so stale devices and lost replies cannot overwrite a newer save.
(function () {
"use strict";
var OWNER = "flight_friends_save_owner", PREFIX = "flight_friends_cloud_";
var sets = ["unlocked", "owned", "welcomed", "furniture", "hoodie", "liked", "likes_unsent", "skins", "trails"];
var flags = ["garden", "starter_gift", "starter_furniture", "park_visited", "played"];
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function canonical(value, field) {
    if (Array.isArray(value)) {
        var parts = value.map(function (item) { return canonical(item); });
        if (sets.indexOf(field) >= 0) parts.sort(); // Collected items are sets; the game orders them by its pet list.
        return "[" + parts.join(",") + "]";
    }
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ":" + canonical(value[key], key); }).join(",") + "}";
    return JSON.stringify(value);
}
function same(a, b) { return canonical(a) === canonical(b); }
function safeKey(key) { return key !== "__proto__" && key !== "constructor" && key !== "prototype"; }
function valid(snapshot) {
    return !!(snapshot && snapshot.format === 1 && snapshot.progress && typeof snapshot.progress === "object" && !Array.isArray(snapshot.progress) &&
        typeof snapshot.best_score === "number" && isFinite(snapshot.best_score) && snapshot.best_score >= 0 && snapshot.best_score % 1 === 0);
}
function merge(base, local, remote) {
    if (!valid(local) || !valid(remote) || (base && !valid(base))) throw new Error("Invalid saved progress");
    var out = clone(remote), a = local.progress, b = remote.progress, before = base && base.progress;
    Object.keys(a).filter(safeKey).forEach(function (key) {
        // A preference changed here wins; unchanged preferences follow the other device.
        if (!before || !same(a[key], before[key])) out.progress[key] = clone(a[key]);
    });
    sets.forEach(function (key) {
        var union = [];
        [a[key], b[key]].forEach(function (list) {
            if (!Array.isArray(list)) return;
            list.forEach(function (id) { if (typeof id === "string" && union.indexOf(id) < 0) union.push(id); });
        });
        if (Array.isArray(a[key]) || Array.isArray(b[key])) out.progress[key] = union.sort();
    });
    flags.forEach(function (key) { if (a[key] === true || b[key] === true) out.progress[key] = true; });
    var coins = function (p) { return typeof p.coins === "number" && isFinite(p.coins) && p.coins >= 0 ? Math.floor(p.coins) : 0; };
    // First binding preserves the larger balance. Later sync applies only this device's
    // change since its acknowledged baseline, rather than crediting the same coins twice.
    out.progress.coins = before ? Math.max(0, coins(b) + coins(a) - coins(before)) : Math.max(coins(a), coins(b));
    var fed = Object.create(null);
    [b.fed_day, a.fed_day].forEach(function (days) {
        if (!days || typeof days !== "object" || Array.isArray(days)) return;
        Object.keys(days).filter(safeKey).forEach(function (id) {
            if (typeof days[id] === "string" && (!fed[id] || days[id] > fed[id])) fed[id] = days[id];
        });
    });
    if (a.fed_day || b.fed_day) out.progress.fed_day = fed;
    out.best_score = Math.max(local.best_score, remote.best_score);
    if (local.nickname && (!base || local.nickname !== base.nickname)) out.nickname = local.nickname;
    return out;
}
function create(kit) {
    var user = null, epoch = 0, running = null, timer = null, state = "local", consent = false, reload = false;
    function read(key) { var text = localStorage.getItem(key); return text ? JSON.parse(text) : null; }
    function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
    function report(next) { state = next; kit.notify(next); }
    function key(kind, id) { return PREFIX + kind + "_" + id; }
    function usable() { return user && kit.ready() && !reload; }
    function attach(id) {
        if (user === id) return;
        user = id; epoch += 1; consent = false;
        if (!id) { report("local"); return; }
        report("checking");
        if (kit.ready()) flush();
    }
    function request(path, method, body, token) {
        var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 12000);
        var options = {method: method, signal: controller.signal, keepalive: method === "POST",
            headers: {apikey: kit.settings.LEADERBOARD_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json"}};
        if (body !== undefined) {
            options.body = JSON.stringify(body);
            if (options.body.length > 15000) options.keepalive = false; // Stay below browsers' 64 KB keepalive quota.
        }
        return fetch(kit.settings.LEADERBOARD_URL + "/rest/v1/" + path, options).then(function (reply) {
            clearTimeout(timeout);
            if (!reply.ok) throw new Error("Cloud unavailable");
            return reply.json();
        }, function (error) { clearTimeout(timeout); throw error; });
    }
    function acknowledge(id, result, before, activeEpoch) {
        if (activeEpoch !== epoch || user !== id) return;
        if (!valid(result.snapshot) || !(result.revision > 0)) throw new Error("Invalid cloud reply");
        var now = kit.snapshot(), combined = same(before, now) ? clone(result.snapshot) : merge(before, now, result.snapshot);
        // Keep a recovery copy for this account before applying any downloaded progress.
        write(key("recovery", id), now);
        var oldBase = localStorage.getItem(key("base", id)), oldOwner = localStorage.getItem(OWNER);
        try {
            write(key("base", id), {revision: result.revision, snapshot: result.snapshot});
            localStorage.setItem(OWNER, id);
            if (!same(combined, now)) kit.apply(combined);
        } catch (error) {
            if (oldBase === null) localStorage.removeItem(key("base", id)); else localStorage.setItem(key("base", id), oldBase);
            if (oldOwner === null) localStorage.removeItem(OWNER); else localStorage.setItem(OWNER, oldOwner);
            throw error;
        }
        if (!same(combined, now)) { reload = true; report("reload"); }
        else report("saved");
    }
    function work(id, activeEpoch) {
        // Shared storage is protected across tabs; without a lock, leave the save local.
        if (!navigator.locks || !navigator.locks.request) throw new Error("Cloud lock unavailable");
        return navigator.locks.request("flight-friends-save-" + id, function () {
            if (activeEpoch !== epoch || !usable()) return;
            var owner = localStorage.getItem(OWNER);
            if (owner && owner !== id && !consent) { report("choose"); return; }
            var local = kit.snapshot();
            if (!valid(local)) throw new Error("Local progress unavailable");
            // No remote operation starts until a durable local recovery copy exists.
            write(key("recovery", id), local);
            var source = owner === id ? null : kit.original();
            return kit.session().then(function (session) {
                if (activeEpoch !== epoch || !session || session.user.id !== id) return;
                var token = session.access_token, pending = read(key("pending", id));
                function post(operation, attempt) {
                    if (activeEpoch !== epoch) return;
                    return request("rpc/sync_player_save", "POST", {
                        p_operation_id: operation.id, p_expected_revision: operation.revision,
                        p_snapshot: operation.snapshot, p_source_snapshot: operation.source
                    }, token).then(function (result) {
                        if (activeEpoch !== epoch) return;
                        if (result.saved) {
                            acknowledge(id, result, operation.before, activeEpoch);
                            // Do not remove a pending write before its baseline is stored locally.
                            localStorage.removeItem(key("pending", id));
                            if (!reload && !same(kit.snapshot(), result.snapshot)) schedule();
                            return;
                        }
                        if (attempt >= 2) throw new Error("Cloud changed repeatedly");
                        return prepare(result, attempt + 1);
                    });
                }
                function prepare(remote, attempt) {
                    if (activeEpoch !== epoch) return;
                    var now = kit.snapshot(), baseline = owner === id ? read(key("base", id)) : null;
                    var snapshot = now;
                    if (remote && remote.snapshot) {
                        if (!valid(remote.snapshot)) throw new Error("Invalid cloud save");
                        if (!owner && !kit.hadProgress()) snapshot = remote.snapshot; // Fresh devices do not add another starter gift.
                        else snapshot = merge(baseline && baseline.snapshot, now, remote.snapshot);
                        if (owner === id && same(snapshot, remote.snapshot) && !source) {
                            acknowledge(id, {snapshot: remote.snapshot, revision: remote.revision}, now, activeEpoch);
                            return;
                        }
                    }
                    var operation = {id: crypto.randomUUID(), revision: remote ? remote.revision : 0,
                        snapshot: snapshot, before: now, source: source};
                    write(key("pending", id), operation); // A lost HTTP reply can be replayed with the same id.
                    return post(operation, attempt);
                }
                if (pending) return post(pending, 0);
                return request("player_saves?select=revision,snapshot&user_id=eq." + encodeURIComponent(id), "GET", undefined, token).then(function (rows) {
                    if (!Array.isArray(rows) || rows.length > 1) throw new Error("Invalid cloud rows");
                    return prepare(rows[0] || null, 0);
                });
            });
        });
    }
    function flush() {
        if (running) return running;
        if (!usable()) return Promise.resolve();
        clearTimeout(timer); timer = null;
        var id = user, activeEpoch = epoch;
        report("syncing");
        running = Promise.resolve().then(function () { return work(id, activeEpoch); }).catch(function () {
            if (activeEpoch === epoch) report("pending"); // Keep local progress and the exact pending request for retry.
        }).then(function () { running = null; if (activeEpoch !== epoch && usable()) schedule(); });
        return running;
    }
    function schedule() {
        if (!usable() || timer || state === "choose") return;
        if (!running) report("queued");
        timer = setTimeout(function () { timer = null; flush(); }, 10000);
    }
    window.addEventListener("flight-progress-saved", schedule);
    window.addEventListener("online", function () { if (usable()) flush(); });
    window.addEventListener("flight-game-ready", function () { if (user) flush(); });
    document.addEventListener("visibilitychange", function () { if (document.hidden && usable()) flush(); });
    return {attach: attach, flush: flush, state: function () { return state; },
        reloadRequired: function () { return reload; },
        bindLocal: function () { consent = true; return flush(); }};
}
window.flightFriendsCloud = {create: create, merge: merge, same: same, valid: valid};
})();
