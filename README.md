# TikTok-Chat-Reader
A chat reader for <a href="https://www.tiktok.com/live">TikTok LIVE</a> utilizing <a href="https://github.com/zerodytrash/TikTok-Live-Connector">TikTok-Live-Connector</a> and <a href="https://socket.io/">Socket.IO</a> to forward the data to the client. This demo project uses the unofficial TikTok API to retrieve chat comments, gifts and other events from TikTok LIVE.

## Demo: https://tiktok-chat-reader.zerody.one/

## Installation
To run the chat reader locally, follow these steps:

1. Install [Node.js](https://nodejs.org/) on your system
2. Clone this repository or download and extract [this ZIP file](https://github.com/zerodytrash/TikTok-Chat-Reader/archive/refs/heads/main.zip)
3. Open a console/terminal in the root directory of the project
4. Enter `npm i` to install all required dependencies 
5. Enter `node server.js` to start the application server

Now you should see the following message: `Server running! Please visit http://localhost:8091`<br>
Simply open http://localhost:8091/ in your browser. Thats it.

If you have problems with Node.js, you can also just open the `index.html` from the `public` folder.<br>
This will use the server backend of the [demo site](https://tiktok-chat-reader.zerody.one/), which is sufficient for testing purposes. If you want to offer it to others or make many connections at the same time, please consider using your own server.

## Screenshot

![TikTok LIVE Chat Reader (Demo)](.demo/demo-image.png)

## Latest Chats JSON API

Besides the web interface, the server exposes a simple REST endpoint that returns the latest chat messages of a TikTok LIVE stream as JSON. It is designed to be polled by external tools (bots, game mods such as [JsMacros](https://modrinth.com/mod/jsmacros) for Minecraft, overlay tools, etc.).

### Endpoints

| Endpoint | Description |
|---|---|
| `GET /:username/latest-chats` | Latest live chat messages of `@username` as JSON (e.g. `/cocothelarper/latest-chats`) |
| `GET /api/:username/latest-chats` | Same as above (alias) |
| `GET /health` | Server status + list of tracked streams |

### How it works

- The **first request** for a username opens a TikTok LIVE connection on the server and starts buffering incoming chat messages.
- Every **subsequent request** (e.g. every 1-3 seconds) instantly returns the currently buffered messages.
- If the streamer is offline, the server keeps retrying in the background (with a 30 second cooldown) and starts buffering automatically once the streamer goes live.
- Each username keeps its own buffer of the last 50 messages (and last 20 gifts).

### Query parameters

| Parameter | Default | Description |
|---|---|---|
| `limit` | `15` | Maximum number of messages to return (1-50), e.g. `?limit=30` |

### Example response

```json
{
  "success": true,
  "username": "cocothelarper",
  "state": "connected",
  "live": true,
  "viewers": 1234,
  "likes": 5678,
  "diamonds": 99,
  "totalMessages": 42,
  "connectedAt": 1729650000000,
  "lastUpdate": 1729650012345,
  "serverTime": 1729650012346,
  "messages": [
    { "id": "7365...", "user": "someviewer", "nickname": "Some Viewer", "text": "hello!", "time": 1729650009000 },
    { "id": "7366...", "user": "anotheruser", "nickname": "Another User", "text": "W stream", "time": 1729650011000 }
  ],
  "gifts": [
    { "user": "generousguy", "nickname": "Generous Guy", "gift": "Rose", "count": 5, "diamonds": 1, "time": 1729650012000 }
  ]
}
```

The `state` field is one of: `connecting`, `connected`, `reconnecting`, `offline`, `error`. Only `connected` streams receive live messages (`live: true`).

### Display the chat in Minecraft (JsMacros)

A ready-to-use JsMacros service script is included in this repo: [`examples/jsmacros/tiktok_live_chat.js`](examples/jsmacros/tiktok_live_chat.js).

1. Copy the script into `.minecraft/macros/scripts/`
2. Edit the `CONFIG` section at the top: set `API_BASE` to your server URL (e.g. `https://ttlivechat.onrender.com`) and `USERNAME` to the TikTok username
3. Open the JsMacros config screen in Minecraft, go to the **Services** tab, add the script as a service and enable it
4. TikTok chat messages and gifts will now be printed into your Minecraft chat

### Notes for Render free tier

- Render free instances sleep after ~15 minutes without inbound traffic. The first request after a cold start takes ~30-60 seconds while the service spins up (and your polling tool should tolerate request timeouts).
- To keep the instance awake, you can point an uptime monitor (e.g. cron-job.org or UptimeRobot) at `GET /health` every 10 minutes.

