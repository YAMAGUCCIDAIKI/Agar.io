const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const HOST_TIMEOUT_MS = 2200;
const rooms = new Map();

function publicRelayUrl() {
  const rawUrl =
    process.env.PUBLIC_RELAY_URL ||
    process.env.RELAY_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.FLY_APP_NAME ||
    "";
  const value = String(rawUrl).trim();
  if (!value) return "wss://your-server.example.com/ws";
  if (/^(https?|wss?):\/\//i.test(value)) {
    return `${value.replace(/\/+$/, "").replace(/^http:/i, "ws:").replace(/^https:/i, "wss:")}/ws`;
  }
  if (process.env.FLY_APP_NAME && value === process.env.FLY_APP_NAME) return `wss://${value}.fly.dev/ws`;
  return `wss://${value.replace(/\/+$/, "")}/ws`;
}

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
    socket,
    id: crypto.randomBytes(8).toString("hex"),
    room: "",
    role: "client",
    buffer: Buffer.alloc(0),
    alive: true,
    joinedAt: Date.now(),
    lastMessageAt: Date.now()
  };

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    readFrames(client);
  });

  socket.on("close", () => leaveRoom(client));
  socket.on("error", () => leaveRoom(client));
});

function roomState(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      clients: new Set(),
      host: null,
      nextPlayerIndex: 1,
      snapshot: null,
      world: new Map(),
      lastHostMessageAt: 0
    };
    rooms.set(roomId, room);
  }
  return room;
}

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

  client.lastMessageAt = Date.now();
  if (message.t === "relayJoin") {
    joinRoom(client, String(message.room || "").trim(), String(message.role || ""));
    client.name = String(message.name || "").slice(0, 18);
    return;
  }

  if (!client.room) return;
  const room = rooms.get(client.room);
  if (!room) return;

  if (client === room.host) {
    room.lastHostMessageAt = Date.now();
    if (message.t === "snapshot") room.snapshot = message;
    if (message.t === "world") room.world.set(`${message.kind}:${message.seq}:${message.index}`, message);
  }

  for (const peer of room.clients) {
    if (peer !== client) sendJson(peer, message);
  }
}

function joinRoom(client, requestedRoom, role) {
  const roomId = requestedRoom.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "agar";
  if (client.room && client.room !== roomId) leaveRoom(client, false);
  const room = roomState(roomId);

  client.room = roomId;
  if (!client.playerId) {
    client.playerId = `p${room.nextPlayerIndex}`;
    room.nextPlayerIndex += 1;
  }
  client.role = role === "host" ? "host" : "client";
  client.alive = true;
  client.joinedAt = Date.now();
  room.clients.add(client);

  if (!room.host || !room.clients.has(room.host)) {
    promoteHost(room, client);
  } else {
    sendJson(client, { t: "relayReady", room: roomId, peers: room.clients.size, host: room.host.id, playerId: client.playerId });
    if (room.snapshot) sendJson(client, room.snapshot);
    for (const worldMessage of room.world.values()) sendJson(client, worldMessage);
  }
  broadcastPeerCount(room);
}

function promoteHost(room, client = null) {
  const previousHost = room.host;
  const nextHost = client || [...room.clients].sort((a, b) => a.joinedAt - b.joinedAt)[0] || null;
  room.host = nextHost;
  room.lastHostMessageAt = Date.now();
  if (!nextHost) return;
  if (previousHost && previousHost !== nextHost && room.clients.has(previousHost)) {
    previousHost.role = "client";
    sendJson(previousHost, { t: "relayDemoteClient", room: room.id });
  }
  nextHost.role = "host";
  sendJson(nextHost, { t: "relayReady", room: room.id, peers: room.clients.size, host: nextHost.id, playerId: nextHost.playerId });
  sendJson(nextHost, {
    t: "relayPromoteHost",
    room: room.id,
    snapshot: room.snapshot
  });
}

function broadcastPeerCount(room) {
  for (const peer of room.clients) {
    sendJson(peer, {
      t: "relayPeer",
      room: room.id,
      peers: room.clients.size,
      host: room.host ? room.host.id : ""
    });
  }
}

function leaveRoom(client, markDead = true) {
  if (markDead) client.alive = false;
  if (!client.room) return;
  const room = rooms.get(client.room);
  if (!room) return;
  room.clients.delete(client);
  if (room.host === client) {
    room.host = null;
    promoteHost(room);
  }
  broadcastPeerCount(room);
  client.room = "";
}

function checkRooms() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.host && room.clients.size) {
      promoteHost(room);
      broadcastPeerCount(room);
      continue;
    }
    if (room.host && now - room.lastHostMessageAt > HOST_TIMEOUT_MS) {
      const candidates = [...room.clients].filter((client) => client !== room.host);
      if (candidates.length) {
        room.host = null;
        promoteHost(room, candidates.sort((a, b) => a.joinedAt - b.joinedAt)[0]);
        broadcastPeerCount(room);
      }
    }
  }
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

setInterval(checkRooms, 500);

server.listen(PORT, () => {
  console.log(`Agar relay ready: http://localhost:${PORT}`);
  console.log(`GitHub Pages relay URL: ${publicRelayUrl()}`);
});
