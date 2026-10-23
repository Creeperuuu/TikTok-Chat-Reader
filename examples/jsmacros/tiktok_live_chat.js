/**
 * TikTok LIVE Chat -> Minecraft Chat (JsMacros Service Script)
 * ---------------------------------------------------------------------------
 * Prints the chat of a TikTok LIVE stream into your Minecraft chat.
 *
 * Requirements:
 *   - JsMacros mod installed (https://modrinth.com/mod/jsmacros)
 *   - A running TikTok-Chat-Reader server with the latest-chats API
 *     (e.g. https://ttlivechat.onrender.com)
 *
 * Setup:
 *   1. Put this file into:  .minecraft/macros/scripts/
 *   2. Adjust the CONFIG values below (your Render URL + TikTok username).
 *   3. In Minecraft, open the JsMacros config screen, go to the "Services"
 *      tab, add this script as a service and enable it.
 *      (A service runs automatically when the game starts and keeps the
 *      polling loop alive in the background.)
 *   4. TikTok chat messages will appear in your Minecraft chat like:
 *      [TikTok] username: message
 * ---------------------------------------------------------------------------
 */

// ------------------------- CONFIG -------------------------
var API_BASE = "https://ttlivechat.onrender.com"; // your TikTok-Chat-Reader URL (no trailing slash)
var USERNAME = "cocothelarper";                   // TikTok username to follow (no @)
var POLL_MS = 2000;                               // poll interval in ms (2000 = every 2 seconds)
var PREFIX = "\u00A7d[TikTok]\u00A7r";            // chat prefix (magenta [TikTok])
// -----------------------------------------------------------

var seenMessageIds = {};
var seenGiftKeys = {};
var lastState = null;
var lastLiveError = null;

function log(msg) {
    Chat.log(PREFIX + " " + msg);
}

function pruneSeen(map, maxEntries) {
    var keys = Object.keys(map);
    if (keys.length <= maxEntries) return;
    for (var i = 0; i < keys.length - maxEntries; i++) {
        delete map[keys[i]];
    }
}

function pollOnce() {
    var url = API_BASE + "/" + USERNAME + "/latest-chats?limit=20";

    var resp;
    try {
        var req = Request.create(url);
        req.connectTimeout = 15000;
        req.readTimeout = 30000;
        resp = req.get();
    } catch (e) {
        // Network error / timeout (e.g. Render free tier cold start) - just try again later
        return;
    }

    if (resp.responseCode !== 200) {
        return;
    }

    var data;
    try {
        data = JSON.parse(resp.text());
    } catch (e) {
        return;
    }

    // Announce state changes once (connecting -> live / offline / waiting)
    if (data.state !== lastState) {
        lastState = data.state;
        if (data.state === "connected") {
            log("\u00A7aLive: @" + data.username + "\u00A7r (" + data.viewers + " viewers)");
        } else if (data.state === "connecting") {
            log("Connecting to @" + data.username + "...");
        } else if (data.state === "offline") {
            log("\u00A77@" + data.username + " is not live right now. Waiting...\u00A7r");
        } else if (data.state === "error" && data.error) {
            if (data.error !== lastLiveError) {
                log("\u00A7cConnection problem: " + data.error + "\u00A7r");
            }
        }
    }
    lastLiveError = data.error || null;

    // Print new chat messages
    if (data.messages && data.messages.length > 0) {
        for (var i = 0; i < data.messages.length; i++) {
            var m = data.messages[i];
            if (seenMessageIds[m.id]) continue;
            seenMessageIds[m.id] = true;
            log("\u00A7b" + m.user + "\u00A7f: " + m.text);
        }
        pruneSeen(seenMessageIds, 200);
    }

    // Print new gifts
    if (data.gifts && data.gifts.length > 0) {
        for (var g = 0; g < data.gifts.length; g++) {
            var gift = data.gifts[g];
            var key = gift.user + "|" + gift.gift + "|" + gift.count + "|" + gift.time;
            if (seenGiftKeys[key]) continue;
            seenGiftKeys[key] = true;
            log("\u00A7e" + gift.user + "\u00A7f sent \u00A7e" + gift.gift + " x" + gift.count + "\u00A7f");
        }
        pruneSeen(seenGiftKeys, 200);
    }
}

log("Polling TikTok chat of @" + USERNAME + " every " + POLL_MS + " ms via " + API_BASE);

// Service scripts keep their thread alive with a loop + sleep.
while (true) {
    try {
        pollOnce();
    } catch (e) {
        // Never let one bad poll kill the service
    }
    Time.sleep(POLL_MS);
}
