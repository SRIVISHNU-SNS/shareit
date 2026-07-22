# nearby

`nearby` is a no-account encrypted broadcast file-transfer starter. One room creator can invite up to 250 receivers; only the creator can offer files, and every receiver chooses whether to accept each one.

## Run locally

Install Node.js 20+ and then, from this folder:

```powershell
npm install
npm start
```

Open `http://localhost:3000`, create a room, and open the complete copied invite in another browser. The `#k=...` portion of the link is the end-to-end encryption key and must not be removed.

## Production checklist

- Terminate TLS and serve the app over HTTPS; WebSocket automatically becomes WSS.
- The included Node process is a single-instance prototype. For production scale, use sticky WebSocket routing, Redis-backed room state, and an edge/WebTransport fan-out tier.
- Add rate limiting, abuse controls, a bandwidth budget, telemetry that excludes file names/content, and a privacy policy before public launch.
- On Chromium browsers, the receiver chooses a save location and chunks stream directly to disk with the File System Access API. Browsers without that API use their normal Blob-download fallback, which can still be memory-limited for very large files.
- The QR generator is a local application dependency served from `/vendor/qrcode-generator.js`; it does not call a third-party CDN at runtime.

## What is deliberately not included

Browser security models do not permit reliable, consent-free LAN device discovery. The product therefore uses room links and QR pairing, which work across iPhone, Android, Windows, macOS, and modern browsers.
