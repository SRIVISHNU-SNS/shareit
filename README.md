# nearby

`nearby` is a no-account browser file-transfer starter. The WebSocket server only introduces two browsers in a short-lived room; file bytes travel over a WebRTC DataChannel, not through the server.

## Run locally

Install Node.js 20+ and then, from this folder:

```powershell
npm install
npm start
```

Open `http://localhost:3000` in two browser windows. For testing across two physical devices, expose the app through an HTTPS tunnel or deploy it; WebRTC camera/clipboard and reliable peer connectivity are best on HTTPS.

## Production checklist

- Terminate TLS and serve the app over HTTPS; WebSocket automatically becomes WSS.
- Add authenticated TURN credentials (for example, coturn) to `iceServers` in `app.js`. STUN alone cannot connect every pair of networks.
- Add rate limiting, abuse controls, telemetry that excludes file names/content, and a privacy policy before public launch.
- On Chromium browsers, the receiver chooses a save location and chunks stream directly to disk with the File System Access API. Browsers without that API use their normal Blob-download fallback, which can still be memory-limited for very large files.
- The QR generator is an application dependency served from `/vendor/qrcode.min.js`; it does not call a third-party CDN at runtime.

## What is deliberately not included

Browser security models do not permit reliable, consent-free LAN device discovery. The product therefore uses room links and QR pairing, which work across iPhone, Android, Windows, macOS, and modern browsers.
