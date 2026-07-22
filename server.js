"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const QRCode = require("qrcode");

const port = Number(process.env.PORT || 3000);
const publicDir = __dirname;
const rooms = new Map();
const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon" };

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function leave(socket) {
  const members = rooms.get(socket.room);
  if (!members || !members.has(socket)) return;
  members.delete(socket);
  if (members.size === 0) rooms.delete(socket.room);
  else for (const peer of members) send(peer, { type: "peer-left" });
}

const server = http.createServer((request, response) => {
  if (request.method !== "GET") { response.writeHead(405); return response.end(); }
  const requested = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  if (requested === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return response.end(JSON.stringify({ ok: true }));
  }
  if (requested === "/qr") {
    const room = String(new URL(request.url, `http://${request.headers.host}`).searchParams.get("room") || "").toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(room)) { response.writeHead(400); return response.end("Invalid room"); }
    const origin = `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
    response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return QRCode.toFileStream(response, `${origin}/${room}`, { width: 340, margin: 1, errorCorrectionLevel: "M", color: { dark: "#111311", light: "#f1f3ed" } });
  }
  const fileName = requested === "/" || !path.extname(requested) ? "index.html" : requested.replace(/^\/+/, "");
  const safePath = path.resolve(publicDir, fileName);
  if (safePath !== publicDir && !safePath.startsWith(`${publicDir}${path.sep}`)) { response.writeHead(403); return response.end(); }
  fs.readFile(safePath, (error, body) => {
    if (error) { response.writeHead(404); return response.end("Not found"); }
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(safePath)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(body);
  });
});

const websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url, `http://${request.headers.host}`).pathname !== "/signal") return socket.destroy();
  websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client));
});
websocket.on("connection", (client) => {
  client.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return client.close(1003, "Invalid message"); }
    if (message.type === "join") {
      const room = String(message.room || "").toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(room)) return client.close(1008, "Invalid room");
      const members = rooms.get(room) || new Set();
      if (members.size >= 2) return send(client, { type: "room-full" });
      client.room = room;
      client.isHost = members.size === 0;
      members.add(client);
      rooms.set(room, members);
      send(client, { type: "joined", host: client.isHost });
      if (members.size === 2) for (const peer of members) if (peer !== client) send(peer, { type: "peer-joined" });
      return;
    }
    if (message.type === "signal" && client.room && message.signal) {
      for (const peer of rooms.get(client.room) || []) if (peer !== client) send(peer, { type: "signal", signal: message.signal });
    }
  });
  client.on("close", () => leave(client));
  client.on("error", () => leave(client));
});
server.listen(port, () => console.log(`nearby is ready on http://localhost:${port}`));
