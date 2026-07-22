"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT || 3000);
const publicDir = __dirname;
const qrBundle = require.resolve("qrcode-generator");
const rooms = new Map();
const MAX_RECEIVERS = 250;
const MAX_RECIPIENT_BUFFER = 4 * 1024 * 1024;
const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon" };

function send(client, payload) { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload)); }
function sameSecret(left, right) { if (!left || !right || left.length !== right.length) return false; return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
function receiverCount(room) { return [...room.members.values()].filter((client) => client.role === "receiver").length; }
function broadcastRoom(room, payload, except) { for (const client of room.members.values()) if (client !== except) send(client, payload); }
function roomUpdate(room) { broadcastRoom(room, { type: "room-update", receivers: receiverCount(room) }); }
function removeClient(client) {
  const room = rooms.get(client.room);
  if (!room || !room.members.delete(client.id)) return;
  if (client.role === "owner") { room.ownerId = null; broadcastRoom(room, { type: "owner-offline", receivers: receiverCount(room) }); }
  if (room.transfer) room.transfer.accepted.delete(client.id);
  if (room.members.size === 0) rooms.delete(client.room); else roomUpdate(room);
}

const server = http.createServer((request, response) => {
  if (request.method !== "GET") { response.writeHead(405); return response.end(); }
  const parsed = new URL(request.url, `http://${request.headers.host}`);
  const requested = decodeURIComponent(parsed.pathname);
  if (requested === "/health") { response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); return response.end(JSON.stringify({ ok: true, rooms: rooms.size })); }
  if (requested === "/vendor/qrcode-generator.js") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" }); return fs.createReadStream(qrBundle).pipe(response); }
  const fileName = requested === "/" || !path.extname(requested) ? "index.html" : requested.replace(/^\/+/, "");
  const safePath = path.resolve(publicDir, fileName);
  if (safePath !== publicDir && !safePath.startsWith(`${publicDir}${path.sep}`)) { response.writeHead(403); return response.end(); }
  fs.readFile(safePath, (error, body) => { if (error) { response.writeHead(404); return response.end("Not found"); } response.writeHead(200, { "Content-Type": mimeTypes[path.extname(safePath)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(body); });
});

const websocket = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on("upgrade", (request, socket, head) => { if (new URL(request.url, `http://${request.headers.host}`).pathname !== "/signal") return socket.destroy(); websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client)); });
websocket.on("connection", (client) => {
  client.id = crypto.randomUUID();
  client.on("message", (raw, binary) => {
    const room = rooms.get(client.room);
    if (binary) {
      if (!room?.transfer || client.role !== "owner" || room.ownerId !== client.id || !room.transfer.started) return;
      for (const receiverId of [...room.transfer.accepted]) {
        const receiver = room.members.get(receiverId);
        if (!receiver || receiver.readyState !== WebSocket.OPEN || receiver.bufferedAmount > MAX_RECIPIENT_BUFFER) { room.transfer.accepted.delete(receiverId); if (receiver) send(receiver, { type: "broadcast-cancel", transferId: room.transfer.id, reason: "slow" }); send(client, { type: "receiver-slow" }); continue; }
        receiver.send(raw, { binary: true });
      }
      return;
    }
    let event; try { event = JSON.parse(raw); } catch { return client.close(1003, "Invalid message"); }
    if (event.type === "join") {
      const roomCode = String(event.room || "").toUpperCase(); if (!/^[A-Z0-9]{4,8}$/.test(roomCode)) return client.close(1008, "Invalid room");
      let current = rooms.get(roomCode);
      if (!current) { if (!event.ownerKey) return send(client, { type: "room-not-found" }); current = { ownerKey: String(event.ownerKey), ownerId: client.id, members: new Map(), transfer: null }; rooms.set(roomCode, current); client.role = "owner"; }
      else if (sameSecret(current.ownerKey, String(event.ownerKey || "")) && !current.ownerId) { current.ownerId = client.id; client.role = "owner"; }
      else { if (receiverCount(current) >= MAX_RECEIVERS) return send(client, { type: "room-full", receivers: receiverCount(current) }); client.role = "receiver"; }
      client.room = roomCode; current.members.set(client.id, client); send(client, { type: "joined", role: client.role, receivers: receiverCount(current) }); roomUpdate(current); return;
    }
    if (!room) return;
    if (event.type === "broadcast-offer" && client.role === "owner" && room.ownerId === client.id) { if (room.transfer) return; if (!event.transferId || !Number.isFinite(event.size) || event.size < 0) return; room.transfer = { id: event.transferId, accepted: new Set(), started: false }; broadcastRoom(room, { type: "broadcast-offer", transferId: event.transferId, name: String(event.name || "file"), size: event.size, mime: String(event.mime || "application/octet-stream"), nonce: String(event.nonce || "") }, client); return; }
    if (event.type === "broadcast-accept" && client.role === "receiver" && room.transfer?.id === event.transferId && !room.transfer.started) { room.transfer.accepted.add(client.id); const owner = room.members.get(room.ownerId); if (owner) send(owner, { type: "broadcast-audience", transferId: room.transfer.id, count: room.transfer.accepted.size }); return; }
    if (event.type === "broadcast-decline" && client.role === "receiver" && room.transfer?.id === event.transferId) { room.transfer.accepted.delete(client.id); return; }
    if (event.type === "broadcast-start" && client.role === "owner" && room.ownerId === client.id && room.transfer?.id === event.transferId) { room.transfer.started = true; for (const receiverId of room.transfer.accepted) send(room.members.get(receiverId), { type: "broadcast-start", transferId: room.transfer.id }); return; }
    if ((event.type === "broadcast-end" || event.type === "broadcast-cancel") && client.role === "owner" && room.ownerId === client.id && room.transfer?.id === event.transferId) { broadcastRoom(room, { type: event.type, transferId: room.transfer.id }, client); room.transfer = null; }
  });
  client.on("close", () => removeClient(client)); client.on("error", () => removeClient(client));
});
server.listen(port, () => console.log(`nearby is ready on http://localhost:${port}`));
