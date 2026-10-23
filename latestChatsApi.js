const express = require('express');
const { TikTokConnectionWrapper } = require('./connectionWrapper');

/**
 * REST API: latest live chat messages as JSON
 *
 *   GET /:username/latest-chats          (e.g. /cocothelarper/latest-chats)
 *   GET /api/:username/latest-chats      (alias)
 *
 * Designed to be polled (e.g. every 1-3 seconds) by bots or game mods such as
 * JsMacros for Minecraft. The first request for a username opens a TikTok LIVE
 * connection on the server; subsequent requests return the buffered messages.
 */

const router = express.Router();

// ---- Configuration ----
const BUFFER_SIZE = 50;              // max buffered chat messages per stream
const GIFT_BUFFER_SIZE = 20;         // max buffered gifts per stream
const DEFAULT_MESSAGE_LIMIT = 15;    // messages returned per request by default
const MAX_MESSAGE_LIMIT = 50;        // hard cap for ?limit=
const RETRY_COOLDOWN_MS = 30000;     // min delay between connection attempts for offline/errored streams
const CONNECT_TIMEOUT_MS = 45000;    // consider a stale "connecting" stream dead after this time
const MAX_TRACKED_STREAMS = 25;      // safety cap to avoid unbounded memory usage

const USERNAME_PATTERN = /^[a-zA-Z0-9._]{1,30}$/;

// username -> stream state
const streams = new Map();

// ---------------- Stream management ----------------

function createStream(username) {
    const stream = {
        username,
        wrapper: null,
        state: 'connecting',   // connecting | connected | reconnecting | offline | error
        error: null,
        messages: [],
        gifts: [],
        seenMessageIds: new Set(),
        viewers: 0,
        likes: 0,
        diamonds: 0,
        connectedAt: null,
        lastUpdate: null,
        lastAttempt: 0
    };
    streams.set(username, stream);
    return stream;
}

function enforceStreamCap(username) {
    if (streams.size <= MAX_TRACKED_STREAMS) return;
    // Evict the least recently updated stream that is not the one just requested
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, stream] of streams) {
        if (key === username) continue;
        const t = stream.lastUpdate || stream.lastAttempt || 0;
        if (t < oldestTime) {
            oldestTime = t;
            oldestKey = key;
        }
    }
    if (oldestKey) {
        const old = streams.get(oldestKey);
        if (old.wrapper) {
            try { old.wrapper.disconnect(); } catch (err) { /* ignore */ }
        }
        streams.delete(oldestKey);
        console.info(`LATEST-CHATS API: evicted idle stream @${oldestKey} (cap ${MAX_TRACKED_STREAMS})`);
    }
}

function isOfflineReason(reason) {
    if (!reason) return false;
    const r = String(reason).toLowerCase();
    return r.includes('offline')
        || r.includes('not live')
        || r.includes('live has ended')
        || r.includes('stream ended')
        || r.includes('suspended')
        || r.includes('roomid');
}

function startConnection(stream) {
    // Tear down any previous wrapper
    if (stream.wrapper) {
        try { stream.wrapper.disconnect(); } catch (err) { /* ignore */ }
        stream.wrapper = null;
    }

    stream.state = 'connecting';
    stream.error = null;
    stream.lastAttempt = Date.now();

    let wrapper;
    try {
        wrapper = new TikTokConnectionWrapper(stream.username, { processInitialData: true }, true);
    } catch (err) {
        stream.state = 'error';
        stream.error = err.message || String(err);
        console.error(`LATEST-CHATS API: failed to create connection for @${stream.username}:`, stream.error);
        return;
    }

    stream.wrapper = wrapper;
    const connection = wrapper.connection;

    // Fires on every successful connect (also after auto-reconnects)
    connection.on('connected', (state) => {
        stream.state = 'connected';
        stream.connectedAt = Date.now();
        stream.error = null;
        console.info(`LATEST-CHATS API: connected to @${stream.username} (roomId ${state && state.roomId})`);
    });

    // Underlying websocket dropped, wrapper tries to reconnect internally
    connection.on('disconnected', () => {
        if (stream.state === 'connected') {
            stream.state = 'reconnecting';
        }
    });

    // Streamer ended the live
    connection.on('streamEnd', () => {
        stream.state = 'offline';
        stream.error = 'LIVE has ended';
    });

    // Initial connect failed OR reconnect attempts exhausted
    wrapper.once('disconnected', (reason) => {
        if (stream.state !== 'connected') {
            stream.state = isOfflineReason(reason) ? 'offline' : 'error';
        }
        stream.error = reason ? String(reason) : null;
    });

    // ---- Buffer chat messages ----
    connection.on('chat', (msg) => {
        const comment = msg.comment !== undefined ? msg.comment : msg.content;
        const user = msg.uniqueId || (msg.user && msg.user.uniqueId);
        if (typeof comment !== 'string' || comment.length === 0 || !user) return;

        const id = String(msg.msgId || `${msg.userId || user}-${msg.createTime || Date.now()}`);
        if (stream.seenMessageIds.has(id)) return;
        stream.seenMessageIds.add(id);

        const entry = {
            id,
            user,
            nickname: msg.nickname || (msg.user && msg.user.nickname) || user,
            text: comment,
            time: Date.now()
        };

        stream.messages.push(entry);
        while (stream.messages.length > BUFFER_SIZE) stream.messages.shift();

        // Trim the dedupe set so it cannot grow forever
        if (stream.seenMessageIds.size > BUFFER_SIZE * 3) {
            const ids = Array.from(stream.seenMessageIds);
            for (let i = 0; i < ids.length - BUFFER_SIZE * 2; i++) stream.seenMessageIds.delete(ids[i]);
        }

        stream.lastUpdate = Date.now();
    });

    // ---- Buffer finished gift streaks ----
    connection.on('gift', (msg) => {
        const streakable = msg.giftType === 1;
        if (streakable && !msg.repeatEnd) return; // streak still in progress

        const user = msg.uniqueId || (msg.user && msg.user.uniqueId);
        if (!user) return;

        const repeatCount = msg.repeatCount || 1;
        const diamondCount = msg.diamondCount || 0;

        stream.gifts.push({
            user,
            nickname: msg.nickname || (msg.user && msg.user.nickname) || user,
            gift: msg.giftName || (msg.extendedGiftInfo && msg.extendedGiftInfo.name) || 'Gift',
            count: repeatCount,
            diamonds: diamondCount * repeatCount,
            time: Date.now()
        });
        while (stream.gifts.length > GIFT_BUFFER_SIZE) stream.gifts.shift();

        stream.diamonds += diamondCount * repeatCount;
        stream.lastUpdate = Date.now();
    });

    // ---- Track stats ----
    connection.on('roomUser', (msg) => {
        if (typeof msg.viewerCount === 'number' && !isNaN(msg.viewerCount)) {
            stream.viewers = msg.viewerCount;
            stream.lastUpdate = Date.now();
        }
    });

    connection.on('like', (msg) => {
        if (typeof msg.totalLikeCount === 'number' && !isNaN(msg.totalLikeCount)) {
            stream.likes = msg.totalLikeCount;
        }
    });

    // Kick it off (connect() handles its own async errors)
    wrapper.connect();
}

function maybeReconnect(stream) {
    const now = Date.now();

    if (stream.state === 'connecting' || stream.state === 'connected' || stream.state === 'reconnecting') {
        // Retry if a connection attempt appears stuck
        if (stream.state !== 'connected' && now - stream.lastAttempt > CONNECT_TIMEOUT_MS) {
            startConnection(stream);
        }
        return;
    }

    // offline / error -> retry after cooldown (e.g. streamer went live again)
    if (now - stream.lastAttempt >= RETRY_COOLDOWN_MS) {
        startConnection(stream);
    }
}

// ---------------- Routes ----------------

router.get('/:username/latest-chats', (req, res) => {
    const rawUsername = String(req.params.username || '').trim().replace(/^@/, '');

    if (!USERNAME_PATTERN.test(rawUsername)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid TikTok username'
        });
    }

    const username = rawUsername.toLowerCase();

    let stream = streams.get(username);
    if (!stream) {
        stream = createStream(username);
        enforceStreamCap(username);
        startConnection(stream);
        console.info(`LATEST-CHATS API: new stream requested for @${username}`);
    } else {
        maybeReconnect(stream);
    }

    const limit = Math.min(
        MAX_MESSAGE_LIMIT,
        Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_MESSAGE_LIMIT)
    );

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');

    return res.json({
        success: true,
        username,
        state: stream.state,
        live: stream.state === 'connected',
        error: stream.error || undefined,
        viewers: stream.viewers,
        likes: stream.likes,
        diamonds: stream.diamonds,
        totalMessages: stream.messages.length,
        connectedAt: stream.connectedAt,
        lastUpdate: stream.lastUpdate,
        serverTime: Date.now(),
        messages: stream.messages.slice(-limit),
        gifts: stream.gifts.slice(-10)
    });
});

router.get('/health', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({
        ok: true,
        trackedStreams: streams.size,
        streams: Array.from(streams.values()).map(s => ({
            username: s.username,
            state: s.state,
            bufferedMessages: s.messages.length
        }))
    });
});

module.exports = router;
