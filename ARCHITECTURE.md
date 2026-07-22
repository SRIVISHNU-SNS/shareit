# Nearby broadcast rooms

## Why this is not 250 peer-to-peer transfers

One browser cannot smoothly upload a large file to 250 WebRTC peers: it would hold 250 peer connections and transmit the same bytes 250 times. Broadcast rooms use one owner upload and an ephemeral WebSocket fan-out relay instead.

## Data path

1. The owner creates a room and receives an invite URL with an AES-256 key in its fragment (`#k=...`). URL fragments never reach the server.
2. Receivers join with the room code but cannot upload; the server records the creator's per-session owner key and enforces the role.
3. The owner offers file metadata. Every receiver chooses **Accept & save** or **Decline** before the first chunk is transmitted.
4. The owner encrypts each 48 KB chunk with AES-GCM and uploads it once to the relay.
5. The relay keeps no file storage and forwards opaque ciphertext only to accepted receivers. Slow receivers are disconnected from the active transfer so they cannot stall everyone else.
6. Receivers decrypt chunks in browser memory only long enough to write them directly to a user-chosen file on Chromium browsers. Other browsers use their normal Blob-download fallback.

## Scale boundary

The included single Node process has a hard cap of 250 receivers per room and is suitable as a functional prototype. Production scale should use sticky WebSocket routing plus shared room state (Redis) and an edge/WebTransport fan-out tier. Relay egress still scales with the number of receivers; the owner's upload remains constant.
