const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const MAX_ROOM_PEERS = 10;
let nextClientId = 1;
const rooms = new Map();

function sendHttp(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store"
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const safePath = path.resolve(ROOT, file);
  if (!safePath.startsWith(ROOT)) {
    sendHttp(res, 403, "Forbidden");
    return;
  }

  fs.readFile(safePath, (error, data) => {
    if (error) {
      sendHttp(res, 404, "Not found");
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    const type = ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      "application/octet-stream";
    sendHttp(res, 200, data, type);
  });
});

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = {
    id: nextClientId++,
    socket,
    room: "",
    role: "",
    actorId: "",
    buffer: Buffer.alloc(0),
    alive: true
  };

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    readFrames(client);
  });

  socket.on("close", () => leaveRoom(client));
  socket.on("error", () => leaveRoom(client));
});

function readFrames(client) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const high = client.buffer.readUInt32BE(offset);
      const low = client.buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }

    const maskBytes = masked ? 4 : 0;
    if (client.buffer.length < offset + maskBytes + length) return;

    let payload = client.buffer.subarray(offset + maskBytes, offset + maskBytes + length);
    if (masked) {
      const mask = client.buffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    client.buffer = client.buffer.subarray(offset + maskBytes + length);

    if (opcode === 0x8) {
      client.socket.end();
      leaveRoom(client);
      return;
    }
    if (opcode === 0x9) {
      sendFrame(client.socket, payload, 0xA);
      continue;
    }
    if (opcode !== 0x1) continue;

    handleMessage(client, payload.toString("utf8"));
  }
}

function handleMessage(client, text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return;
  }

  if (message.t === "relayJoin") {
    joinRoom(client, String(message.room || "").trim(), String(message.role || ""));
    return;
  }

  if (!client.room) return;
  const peers = rooms.get(client.room);
  if (!peers) return;
  message.fromActorId = client.actorId || "";
  for (const peer of peers) {
    if (peer !== client) sendJson(peer, message);
  }
}

function joinRoom(client, requestedRoom, role) {
  const roomId = requestedRoom.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "agar";
  let peers = rooms.get(roomId);
  if (!peers) {
    peers = new Set();
    rooms.set(roomId, peers);
  }

  if (!peers.has(client) && peers.size >= MAX_ROOM_PEERS) {
    sendJson(client, { t: "relayError", message: "ROOM_FULL" });
    return;
  }

  const hasHost = Array.from(peers).some((peer) => peer.role === "host");
  const assignedRole = role === "host" && !hasHost ? "host" :
    role === "client" ? "client" :
    hasHost ? "client" : "host";

  client.room = roomId;
  client.role = assignedRole;
  if (!client.actorId) client.actorId = assignedRole === "host" ? "host" : `guest-${client.id}`;
  peers.add(client);
  sendJson(client, { t: "relayReady", room: roomId, peers: peers.size, maxPeers: MAX_ROOM_PEERS, actorId: client.actorId, role: assignedRole });
  for (const peer of peers) {
    sendJson(peer, { t: "relayPeer", room: roomId, peers: peers.size, maxPeers: MAX_ROOM_PEERS });
  }
}

function leaveRoom(client) {
  if (!client.alive) return;
  client.alive = false;
  if (!client.room) return;
  const peers = rooms.get(client.room);
  if (!peers) return;
  peers.delete(client);
  for (const peer of peers) {
    sendJson(peer, { t: "relayPeer", room: client.room, peers: peers.size, maxPeers: MAX_ROOM_PEERS });
  }
  if (peers.size === 0) rooms.delete(client.room);
}

function sendJson(client, message) {
  if (client.socket.destroyed) return;
  sendFrame(client.socket, Buffer.from(JSON.stringify(message), "utf8"));
}

function sendFrame(socket, payload, opcode = 0x1) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  socket.write(Buffer.concat([header, payload]));
}

server.listen(PORT, () => {
  console.log(`Agar relay ready: http://localhost:${PORT}`);
});
