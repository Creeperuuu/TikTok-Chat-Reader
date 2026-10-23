const { EventEmitter } = require('events');

/**
 * Resolve the WebcastPushConnection class across tiktok-live-connector versions:
 *
 * - v2.x: The class was removed from the main export (renamed to TikTokLiveConnection) and
 *   now lives in the "tiktok-live-connector/legacy" subpath export. The legacy class keeps
 *   emitting v1-style flattened event data (uniqueId, nickname, profilePictureUrl, comment,
 *   giftName, diamondCount, ...) which this server and the frontend rely on.
 * - v1.x: WebcastPushConnection is exported directly from the main package.
 *
 * This fixes the "WebcastPushConnection is not a constructor" error on fresh installs.
 */
let WebcastPushConnection;
try {
    ({ WebcastPushConnection } = require('tiktok-live-connector/legacy'));
} catch (err) {
    ({ WebcastPushConnection } = require('tiktok-live-connector'));
}

let globalConnectionCount = 0;

/**
 * TikTok LIVE connection wrapper with advanced reconnect functionality and error handling
 */
class TikTokConnectionWrapper extends EventEmitter {
    constructor(uniqueId, options, enableLog) {
        super();

        this.uniqueId = uniqueId;
        this.enableLog = enableLog;

        // Connection State
        this.clientDisconnected = false;
        this.reconnectEnabled = true;
        this.reconnectCount = 0;
        this.reconnectWaitMs = 1000;
        this.maxReconnectAttempts = 5;
        this.connectedOnce = false;

        // tiktok-live-connector v2 requires an options object (throws otherwise)
        options = options || {};

        // Map the legacy "sessionId" option to the v2 session bundle format (optional)
        if (options.sessionId) {
            options.session = { cookie: { sessionid: options.sessionId } };
            delete options.sessionId;
        }

        this.connection = new WebcastPushConnection(uniqueId, options);

        // Compatibility normalization for tiktok-live-connector v2 legacy payloads:
        // some v1-style field names differ in the underlying protobuf messages.
        // These listeners mutate the message before any other listener receives it.
        this.connection.on('chat', (msg) => {
            if (msg.comment === undefined && typeof msg.content === 'string') {
                msg.comment = msg.content;
            }
        });

        this.connection.on('roomUser', (msg) => {
            if (typeof msg.viewerCount !== 'number' && msg.total !== undefined) {
                msg.viewerCount = parseInt(msg.total);
            }
        });

        this.connection.on('like', (msg) => {
            if (msg.likeCount === undefined && msg.count !== undefined) {
                msg.likeCount = msg.count;
            }
            if (typeof msg.totalLikeCount !== 'number' && msg.total !== undefined) {
                msg.totalLikeCount = parseInt(msg.total);
            }
        });

        this.connection.on('streamEnd', () => {
            this.log(`streamEnd event received, giving up connection`);
            this.reconnectEnabled = false;
        })

        this.connection.on('disconnected', ({ code, reason }) => {
            if (this.connectedOnce) {
                globalConnectionCount -= 1;
            }
            this.log(`TikTok connection disconnected (code: ${code}, reason: ${reason})`);
            this.scheduleReconnect();
        });

        this.connection.on('error', (err) => {
            this.log(`Error event triggered: ${err.info}, ${err.exception}`);
            console.error(err);
        })
    }

    connect(isReconnect) {
        this.connection.connect().then((state) => {
            this.log(`${isReconnect ? 'Reconnected' : 'Connected'} to roomId ${state.roomId}`);

            if (!this.connectedOnce) {
                globalConnectionCount += 1;
                this.connectedOnce = true;
            }

            // Reset reconnect vars
            this.reconnectCount = 0;
            this.reconnectWaitMs = 1000;

            // Client disconnected while establishing connection => drop connection
            if (this.clientDisconnected) {
                this.connection.disconnect();
                return;
            }

            // Notify client
            if (!isReconnect) {
                this.emit('connected', state);
            }

        }).catch((err) => {
            this.log(`${isReconnect ? 'Reconnect' : 'Connection'} failed, ${err}`);

            let errorMessage = err.message || err.toString();

            // Extract detailed sub-errors if available (e.g. FetchIsLiveError)
            if (Array.isArray(err.errors) && err.errors.length > 0) {
                const details = err.errors
                    .map(e => e.message || e.toString())
                    .filter(Boolean)
                    .join(' | ');
                if (details) {
                    errorMessage += ': ' + details;
                }
            }

            if (isReconnect) {
                // Schedule the next reconnect attempt
                this.scheduleReconnect(errorMessage);
            } else {
                // Notify client
                this.emit('disconnected', errorMessage);
            }
        })
    }

    scheduleReconnect(reason) {

        if (!this.reconnectEnabled) {
            return;
        }

        if (this.reconnectCount >= this.maxReconnectAttempts) {
            this.log(`Give up connection, max reconnect attempts exceeded`);
            this.emit('disconnected', `Connection lost. ${reason}`);
            return;
        }

        this.log(`Try reconnect in ${this.reconnectWaitMs}ms`);

        setTimeout(() => {
            if (!this.reconnectEnabled || this.reconnectCount >= this.maxReconnectAttempts) {
                return;
            }

            this.reconnectCount += 1;
            this.reconnectWaitMs *= 2;
            this.connect(true);

        }, this.reconnectWaitMs)
    }

    disconnect() {
        this.log(`Client connection disconnected`);

        this.clientDisconnected = true;
        this.reconnectEnabled = false;

        if (this.connection.isConnected) {
            this.connection.disconnect();
        }
    }

    log(logString) {
        if (this.enableLog) {
            console.log(`WRAPPER @${this.uniqueId}: ${logString}`);
        }
    }
}

module.exports = {
    TikTokConnectionWrapper,
    getGlobalConnectionCount: () => {
        return globalConnectionCount;
    }
};
