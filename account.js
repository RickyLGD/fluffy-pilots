// Email accounts for the browser game. Supabase's pinned SDK handles session storage,
// token refresh and cross-tab sign-out; it downloads only when an account is needed.
(function () {
"use strict";
var settings = GAME_DATA.settings, client = null, loading = null, current = null;
var opened = false, busy = false, sentUntil = 0, returnFocus = null;
var sentEmail = "";
var cloud = null, cloudState = "local", migrationPrompt = false, restoring = false;
var STORAGE_KEY = "flight_friends_account";
function words(zh, en) { return document.documentElement.lang.indexOf("zh") === 0 ? zh : en; }
var style = document.createElement("style");
style.textContent = "#account-panel{position:fixed;inset:0;z-index:100;background:rgba(24,34,30,.8);overflow:auto;padding:16px;box-sizing:border-box;display:flex;align-items:safe center;justify-content:center}" +
    "#account-panel[hidden],#account-panel [hidden]{display:none!important}" +
    "#account-box{box-sizing:border-box;width:100%;max-width:420px;background:#fff4dc;color:#242530;padding:22px;border:4px solid #242530;font:16px/1.5 sans-serif;position:relative;margin:auto}" +
    "#account-box h2{margin:0 40px 16px 0;font-size:23px}#account-box h3{margin:14px 0 6px;font-size:17px}#account-volume-row{display:flex;align-items:center;gap:12px}#account-volume-amount{min-width:3.6em;text-align:right}#account-box p{margin:12px 0;overflow-wrap:anywhere}#account-box label{overflow-wrap:anywhere}" +
    "#account-box input{display:block;box-sizing:border-box;width:100%;font:18px sans-serif;padding:10px;margin:6px 0 12px;border:2px solid #242530;background:white;color:#242530;user-select:text}" +
    "#account-box #account-volume-slider{flex:1;min-width:0;width:auto;height:44px;margin:0;padding:0;border:0;background:transparent;cursor:pointer;-webkit-appearance:none;appearance:none;touch-action:none;--track:linear-gradient(to right,#488a42 var(--filled,0%),#fff var(--filled,0%))}" +
    "#account-volume-slider::-webkit-slider-runnable-track{height:14px;box-sizing:border-box;border:3px solid #242530;background:var(--track)}" +
    "#account-volume-slider::-webkit-slider-thumb{-webkit-appearance:none;box-sizing:border-box;width:22px;height:32px;margin-top:-12px;border:3px solid #242530;background:#ffd361}" +
    "#account-volume-slider::-moz-range-track{height:14px;box-sizing:border-box;border:3px solid #242530;background:var(--track)}" +
    "#account-volume-slider::-moz-range-thumb{box-sizing:border-box;width:22px;height:32px;border:3px solid #242530;border-radius:0;background:#ffd361}" +
    "#account-box button{font:inherit;cursor:pointer;min-height:42px;padding:7px 12px;border:2px solid #242530;background:#488a42;color:white;margin:4px 0}#account-box button:disabled{opacity:.6;cursor:wait}" +
    "#account-box button:focus-visible,#account-box input:focus-visible{outline:3px solid #ce8025;outline-offset:3px}" +
    "#account-box #account-close{position:absolute;right:12px;top:8px;background:#fff4dc;color:#242530;font-size:23px}#account-box #account-spam{margin:8px 0;padding:8px 10px;background:#ffd361;border:2px solid #242530}#account-status{min-height:24px}#account-note{font-size:14px}";
document.head.appendChild(style);
var panel = document.createElement("div");
panel.id = "account-panel";
panel.hidden = true;
panel.innerHTML = '<section id="account-box" role="dialog" aria-modal="true" aria-labelledby="account-title">' +
    '<button id="account-close" type="button">×</button><h2 id="account-title"></h2>' +
    '<div id="account-volume"><h3 id="account-volume-label"></h3><div id="account-volume-row">' +
    '<input id="account-volume-slider" type="range" min="0" max="100" step="1" aria-labelledby="account-volume-label">' +
    '<span id="account-volume-amount"></span></div></div>' +
    '<h3 id="account-heading"></h3><p id="account-migration" hidden></p><div id="account-signed" hidden><p id="account-email"></p>' +
    '<p id="account-cloud" role="status" aria-live="polite"></p><button id="account-retry" type="button" hidden></button>' +
    '<button id="account-bind" type="button" hidden></button><button id="account-reload" type="button" hidden></button>' +
    '<button id="account-out" type="button"></button></div>' +
    '<form id="account-send"><label id="account-email-label" for="account-address"></label>' +
    '<input id="account-address" type="email" autocomplete="email" inputmode="email" maxlength="254" required>' +
    '<button id="account-send-button" type="submit"></button></form>' +
    '<form id="account-verify" hidden><p id="account-spam"></p><label id="account-code-label" for="account-code"></label>' +
    '<input id="account-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" minlength="6" maxlength="10" required>' +
    '<button id="account-verify-button" type="submit"></button></form>' +
    '<p id="account-status" role="status" aria-live="polite"></p><p id="account-note"></p></section>';
document.body.appendChild(panel);
function element(id) { return document.getElementById("account-" + id); }
function status(message) { element("status").textContent = message; }
function renderVolume() {
    var game = window.flightFriends, percent = game && game.volumePercent ? game.volumePercent() : 0;
    var amount = percent ? percent + "%" : words("静音", "Muted"), slider = element("volume-slider");
    slider.value = String(percent);
    // The thumb's middle travels 22px less than the whole track, so the green ends under it.
    slider.style.setProperty("--filled", "calc(11px + (100% - 22px) * " + percent / 100 + ")");
    slider.setAttribute("aria-valuetext", amount);
    element("volume-amount").textContent = amount;
}
function render() {
    element("title").textContent = migrationPrompt && !current ? words("保存你已有的进度", "Keep your progress safe") : words("设置", "Settings");
    element("heading").textContent = words("账号", "Account");
    element("volume-label").textContent = words("音量", "Volume");
    renderVolume();
    element("close").setAttribute("aria-label", words("关闭", "Close"));
    element("email-label").textContent = words("你的邮箱", "Your email");
    element("code-label").textContent = words("邮件中的验证码", "Code from the email") + (sentEmail ? " · " + sentEmail : "");
    element("spam").textContent = words("没收到验证码？没准在垃圾邮箱里，去找一下。", "No code yet? It may be in your spam folder.");
    element("send-button").textContent = Date.now() < sentUntil ? words("请稍后再发送", "Wait before resending") : words("发送登录邮件", "Send sign-in email");
    element("verify-button").textContent = words("验证并登录", "Verify and sign in");
    element("out").textContent = words("退出账号", "Sign out");
    element("note").textContent = words("无需密码，新邮箱验证后自动注册。登录后保存已有宠物、成就、金币和装扮，保留本机备份。邮箱不会公开。", "No password needed. New emails join after verification. Save your pets, achievements, coins and purchases to your account, with a backup on this device. Your email stays private.");
    element("migration").hidden = !migrationPrompt || !!current;
    element("migration").textContent = words("你的旧宠物和成果不会清零。验证邮箱后，会先备份并把已有进度存入账号；也可以关闭窗口，稍后再绑定。", "Your pets and achievements will stay. Verify your email to back up and bind your existing progress. You can close this and do it later.");
    var cloudWords = {
        local: ["进度保存在本机。", "Progress is on this device."],
        checking: ["正在检查账号存档，本机进度会保留。", "Checking your account save. Local progress stays safe."],
        syncing: ["正在备份并同步进度…", "Backing up and syncing progress…"],
        queued: ["本机已保存，稍后自动同步到账号。", "Saved on this device; account sync will follow shortly."],
        saved: ["宠物、成就和进度已保存到账号。", "Pets, achievements and progress are saved to your account."],
        pending: ["暂未保存到云端，本机进度和待同步备份都还在。可以重试，或稍后继续玩。", "Cloud save is pending. Your local progress and pending backup are kept. Retry, or keep playing for now."],
        choose: ["这台设备的进度属于另一个账号，尚未导入当前账号。若也要保存到这个账号，请点下方合并；原存档会保留备份。", "This device has another account's progress. It has not been imported. Merge below if you want to keep it in this account too; a backup will remain."],
        reload: ["合并完成，旧宠物和成果已保留。重新载入即可继续。", "Progress merged; your pets and achievements are kept. Reload to continue."]
    };
    element("cloud").textContent = words.apply(null, cloudWords[cloudState] || cloudWords.local);
    element("retry").hidden = cloudState !== "pending";
    element("retry").textContent = words("重试保存进度", "Retry cloud save");
    element("bind").hidden = cloudState !== "choose";
    element("bind").textContent = words("保留并合并本机进度", "Keep and merge local progress");
    element("reload").hidden = cloudState !== "reload";
    element("reload").textContent = words("载入完整进度", "Load merged progress");
    element("out").hidden = cloudState === "syncing" || cloudState === "reload";
    element("signed").hidden = !current;
    element("send").hidden = !!current;
    element("verify").hidden = !!current || !sentEmail;
    element("email").textContent = current ? current.user.email || words("已登录", "Signed in") : "";
    element("send-button").disabled = busy || Date.now() < sentUntil;
    element("verify-button").disabled = busy;
    element("out").disabled = busy;
    element("address").disabled = busy;
    element("code").disabled = busy;
}
function changed(session) {
    var before = current && current.user.id;
    current = session;
    render();
    if (before !== (current && current.user.id)) {
        if (cloud) cloud.attach(current ? current.user.id : null);
        window.dispatchEvent(new CustomEvent("flight-account-change"));
        if (opened) {
            status(current ? words("登录成功！可以关闭窗口，继续上榜。", "Signed in! Close this window to post your score.") : words("已退出账号。", "Signed out."));
            (current ? element("out") : element("address")).focus();
        }
    }
}
function errorMessage(error) {
    var code = error && (error.code || error.status);
    if (code === 429 || code === "over_email_send_rate_limit" || code === "over_request_rate_limit") return words("发送太频繁，请稍后再试。", "Too many requests. Please try again later.");
    if (code === "otp_expired") return words("验证码无效或已过期，请重新获取邮件。", "This code is invalid or expired. Request another email.");
    if (code === "email_address_not_authorized" || code === "email_provider_disabled") return words("邮件登录服务尚未开放，请稍后再试。你仍可继续玩。", "Email sign-in is not ready yet. Please try later. You can still play.");
    return words("未能完成，请检查网络或验证码后重试。", "Could not complete this. Check your connection or code and try again.");
}
function loadClient() {
    if (client) return Promise.resolve(client);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
        var tag = document.createElement("script"), timer;
        function failed() {
            clearTimeout(timer);
            tag.onload = tag.onerror = null;
            tag.remove();
            reject(new Error("Account library unavailable"));
        }
        tag.src = "vendor/supabase-2.119.2.js";
        tag.onload = function () {
            clearTimeout(timer);
            try {
                client = window.supabase.createClient(settings.LEADERBOARD_URL, settings.LEADERBOARD_KEY, {
                    auth: {storageKey: STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit"},
                    global: {fetch: function (url, options) {
                        // A failed connection must release the form so the player can retry.
                        var controller = new AbortController(), deadline = setTimeout(function () { controller.abort(); }, 12000);
                        options = Object.assign({}, options, {signal: controller.signal});
                        return fetch(url, options).then(function (reply) { clearTimeout(deadline); return reply; }, function (error) { clearTimeout(deadline); throw error; });
                    }}
                });
                client.auth.onAuthStateChange(function (event, session) { changed(session); });
                client.auth.initialize().then(function (result) {
                    if (result.error) throw result.error;
                    return client.auth.getSession();
                }).then(function (result) {
                    if (result.error) throw result.error;
                    changed(result.data.session);
                    resolve(client);
                }).catch(reject);
            } catch (error) { client = null; reject(error); }
        };
        tag.onerror = failed;
        timer = setTimeout(failed, 15000);
        document.head.appendChild(tag);
    }).catch(function (error) { loading = null; client = null; throw error; });
    return loading;
}
function session() {
    return loadClient().then(function (api) {
        return api.auth.getSession();
    }).then(function (result) {
        if (result.error) throw result.error;
        changed(result.data.session);
        return result.data.session;
    });
}
function open(settingsOnly) {
    if (opened) return;
    opened = true;
    returnFocus = document.activeElement;
    panel.hidden = false;
    render();
    (settingsOnly ? element("close") : current ? element("out") : element("address")).focus();
    if (!settingsOnly) session().catch(function (error) { status(errorMessage(error)); });
}
function close() {
    if (cloud && cloud.reloadRequired()) { location.reload(); return; }
    opened = false;
    panel.hidden = true;
    if (returnFocus && returnFocus.focus) returnFocus.focus();
}
function operation(action) {
    if (busy) return;
    busy = true;
    status(words("正在连接…", "Connecting…"));
    render();
    loadClient().then(action).catch(function (error) { status(errorMessage(error)); }).then(function () {
        busy = false;
        render();
        if (opened && !current && sentEmail) element("code").focus();
    });
}
element("send").addEventListener("submit", function (event) {
    event.preventDefault();
    if (Date.now() < sentUntil) return;
    var email = element("address").value.trim();
    if (!element("address").checkValidity()) return;
    operation(function (api) {
        // This site's address plus the game's language, which the email templates read to pick the
        // email's language. No owner, developer or challenge query parameters.
        var back = location.origin + location.pathname + "?lang=" + words("zh", "en");
        return api.auth.signInWithOtp({email: email, options: {emailRedirectTo: back}}).then(function (result) {
            if (result.error) throw result.error;
            sentUntil = Date.now() + 60000;
            sentEmail = email;
            status(words("验证码已发送，请在上方输入。", "Code sent. Enter it above."));
            render();
            element("code").focus();
        });
    });
});
element("verify").addEventListener("submit", function (event) {
    event.preventDefault();
    var email = sentEmail, code = element("code").value.trim();
    if (!email || !/^[0-9]{6,10}$/.test(code)) return;
    operation(function (api) {
        return api.auth.verifyOtp({email: email, token: code, type: "email"}).then(function (result) {
            if (result.error) throw result.error;
            element("code").value = "";
            changed(result.data.session);
        });
    });
});
element("out").addEventListener("click", function () {
    operation(function (api) {
        return api.auth.signOut({scope: "local"}).then(function (result) {
            if (result.error) throw result.error;
            sentEmail = "";
            element("code").value = "";
            changed(null);
        });
    });
});
["input", "change"].forEach(function (kind) {  // While dragging, and again when the finger lifts.
    element("volume-slider").addEventListener(kind, function () {
        window.flightFriends.changeVolume(Number(element("volume-slider").value));
        renderVolume();
    });
});
element("retry").addEventListener("click", function () { if (cloud) cloud.flush(); });
element("bind").addEventListener("click", function () { if (cloud) cloud.bindLocal(); });
element("reload").addEventListener("click", function () { location.reload(); });
element("close").addEventListener("click", close);
// A drag on the slider that ends outside the box is not a tap outside it.
var pressedOutside = false;
panel.addEventListener("pointerdown", function (event) { pressedOutside = event.target === panel; });
panel.addEventListener("click", function (event) { if (event.target === panel && pressedOutside) close(); });
panel.addEventListener("keydown", function (event) {
    event.stopPropagation(); // Typing must never steer the plane or start a minigame.
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
        var fields = panel.querySelectorAll("button:not(:disabled),input:not(:disabled)");
        var visible = Array.prototype.filter.call(fields, function (field) { return !!field.getClientRects().length; });
        var first = visible[0], last = visible[visible.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});
window.flightFriendsAccount = {
    open: open, openSettings: function () { migrationPrompt = false; open(true); },
    isOpen: function () { return opened; }, session: session,
    playerId: function () { return current ? "acct-" + current.user.id : null; }
};
render();
if (window.flightFriendsCloud) {
    cloud = window.flightFriendsCloud.create({settings: settings, session: session,
        ready: function () { return !!(window.flightFriends && window.flightFriends.accountProgressReady()); },
        snapshot: function () { return window.flightFriends.accountSnapshot(); },
        apply: function (snapshot) { window.flightFriends.applyAccountSnapshot(snapshot); },
        hadProgress: function () { return window.flightFriendsStartedEmpty === false; },
        original: function () {
            var backup = localStorage.getItem("flight_friends_pre_account_backup");
            if (window.flightFriendsStartedEmpty === false && !backup) throw new Error("Original backup unavailable");
            return {original: backup ? JSON.parse(backup) : {}, before_binding: window.flightFriends.accountSnapshot()};
        },
        notify: function (state) {
            cloudState = state;
            render();
            if (state === "reload" || state === "choose") open();
        }
    });
}
function offerMigration() {
    if (current || restoring || window.flightFriendsStartedEmpty !== false || !window.flightFriends || !window.flightFriends.accountProgressReady()) return;
    try {
        if (localStorage.getItem("flight_friends_account_prompt")) return;
        localStorage.setItem("flight_friends_account_prompt", "1");
    } catch (error) { return; }
    migrationPrompt = true;
    open();
}
window.addEventListener("flight-game-ready", offerMigration);
setInterval(function () { if (opened && !busy) render(); }, 1000);
// Returning players restore without blocking game startup; first-time guests download no SDK.
var saved = false;
try { saved = !!localStorage.getItem(STORAGE_KEY); } catch (error) {}
if (saved || /(?:access_token=|error_description=)/.test(location.hash)) {
    restoring = true;
    if (location.hash) open();
    session().catch(function () {}).then(function () { restoring = false; offerMigration(); });
} else offerMigration();
})();
