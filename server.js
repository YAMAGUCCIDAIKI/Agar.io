const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const MAX_ROOM_PEERS = 10;
const WORLD_SIZE = 5000;
const FOOD_TARGET = 900;
const VIRUS_TARGET = 40;
const PLAYER_MASS = 132;
const FOOD_MASS = 1;
const VIRUS_MASS = 100;
const MAX_CELLS = 16;
const MIN_SPLIT_MASS = 36;
const EJECT_MASS = 21;
const CONSUME_RATIO = 1.325;
const TICK_RATE = 45;
const SNAPSHOT_RATE = 20;
const WORLD_RATE = 0.5;
const TAU = Math.PI * 2;

let nextClientId = 1;
let nextEntityId = 1;
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
  socket.setNoDelay(true);
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

function radiusFromMass(mass) {
  return Math.sqrt(Math.max(1, mass)) * 4;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomColor(seed = Math.random()) {
  const colors = ["#2e90fa", "#f04438", "#12b76a", "#f79009", "#7a5af8", "#06aed4", "#e31b54", "#84cc16"];
  return colors[Math.floor(Math.abs(seed * 9973)) % colors.length];
}

function createRoom(id) {
  const room = {
    id,
    peers: new Set(),
    actors: new Map(),
    foods: [],
    viruses: [],
    feeds: [],
    removedFoodIds: new Set(),
    removedVirusIds: new Set(),
    worldSeq: 0,
    lastSnapshotAt: 0,
    lastWorldAt: 0,
    lastTickAt: Date.now() / 1000
  };
  while (room.foods.length < FOOD_TARGET) room.foods.push(createFood());
  while (room.viruses.length < VIRUS_TARGET) room.viruses.push(createVirus());
  rooms.set(id, room);
  return room;
}

function createFood() {
  return {
    id: nextEntityId++,
    x: rand(20, WORLD_SIZE - 20),
    y: rand(20, WORLD_SIZE - 20),
    mass: FOOD_MASS,
    radius: 8.5,
    color: randomColor(),
    dead: false
  };
}

function createVirus() {
  return {
    id: nextEntityId++,
    x: rand(120, WORLD_SIZE - 120),
    y: rand(120, WORLD_SIZE - 120),
    mass: VIRUS_MASS,
    radius: radiusFromMass(VIRUS_MASS),
    color: "#00f018",
    feedCount: 0,
    natural: true,
    dead: false
  };
}

function spawnCell(actor, mass = PLAYER_MASS, x = rand(200, WORLD_SIZE - 200), y = rand(200, WORLD_SIZE - 200)) {
  const radius = radiusFromMass(mass);
  return {
    id: nextEntityId++,
    x: clamp(x, radius, WORLD_SIZE - radius),
    y: clamp(y, radius, WORLD_SIZE - radius),
    mass,
    radius,
    vx: 0,
    vy: 0,
    boostX: 0,
    boostY: 0,
    faceX: 1,
    faceY: 0,
    cooldown: 0,
    mergeReadyAt: 0,
    birthAge: 1,
    birthDuration: 0,
    birthX: x,
    birthY: y,
    birthScale: 1,
    fragmentAge: 0,
    splitBoostAge: 0,
    splitHoldAge: 0,
    pendingBoostX: 0,
    pendingBoostY: 0,
    virusCooldown: 0,
    mergeVirusWindow: 0,
    mergeOverflowMass: 0,
    mergeBurstPieces: 1,
    mergeBurstTotal: mass,
    splitPriority: 0,
    targetX: x,
    targetY: y,
    dead: false,
    ownerId: actor.id
  };
}

function createActor(id, name) {
  const actor = {
    id,
    name: name || id,
    color: randomColor(id.length),
    isHuman: true,
    localClone: false,
    input: {
      targetX: WORLD_SIZE * 0.5,
      targetY: WORLD_SIZE * 0.5,
      splitSeq: 0,
      ejectSeq: 0,
      respawnSeq: 0,
      cloneSeq: 0,
      lastNetSplitSeq: 0,
      lastNetEjectSeq: 0,
      lastNetRespawnSeq: 0,
      lastNetCloneSeq: 0,
      e: false
    },
    cells: []
  };
  actor.cells.push(spawnCell(actor));
  return actor;
}

function handleMessage(client, text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return;
  }

  if (message.t === "relayJoin") {
    joinRoom(client, String(message.room || "").trim());
    return;
  }

  const room = rooms.get(client.room);
  if (!room) return;

  if (message.t === "input") {
    const actor = room.actors.get(client.actorId);
    if (!actor) return;
    const cloneSeq = Number(message.cloneSeq) || 0;
    if (cloneSeq > actor.input.lastNetCloneSeq) {
      ensureCloneActor(room, actor);
      actor.input.lastNetCloneSeq = cloneSeq;
    }
    const activeActor = message.activeActorId === cloneActorId(actor.id)
      ? ensureCloneActor(room, actor)
      : actor;
    activeActor.input.targetX = clamp(Number(message.targetX) || WORLD_SIZE * 0.5, 0, WORLD_SIZE);
    activeActor.input.targetY = clamp(Number(message.targetY) || WORLD_SIZE * 0.5, 0, WORLD_SIZE);
    activeActor.input.e = Boolean(message.e);
    const splitSeq = Number(message.splitSeq) || 0;
    if (splitSeq > actor.input.lastNetSplitSeq) {
      const count = clamp(Math.round(Number(message.splitCount) || splitSeq - actor.input.lastNetSplitSeq), 1, 4);
      for (let i = 0; i < count; i += 1) splitActor(activeActor);
      actor.input.lastNetSplitSeq = splitSeq;
    }
    const ejectSeq = Number(message.ejectSeq) || 0;
    if (ejectSeq > actor.input.lastNetEjectSeq) {
      ejectMass(room, activeActor);
      actor.input.lastNetEjectSeq = ejectSeq;
    }
    const respawnSeq = Number(message.respawnSeq) || 0;
    if (respawnSeq > actor.input.lastNetRespawnSeq) {
      if (!actor.cells.some((cell) => !cell.dead)) actor.cells = [spawnCell(actor)];
      actor.input.lastNetRespawnSeq = respawnSeq;
    }
  }
}

function cloneActorId(actorId) {
  return `${actorId}-clone-1`;
}

function ensureCloneActor(room, source) {
  const id = cloneActorId(source.id);
  let clone = room.actors.get(id);
  if (!clone) {
    clone = createActor(id, `${source.name || source.id} 2`);
    clone.color = source.color;
    clone.localClone = true;
    clone.cells = [];
    room.actors.set(id, clone);
  }
  if (!clone.cells.some((cell) => !cell.dead)) {
    const anchor = source.cells.find((cell) => !cell.dead);
    if (anchor) {
      const mass = PLAYER_MASS;
      const radius = radiusFromMass(mass);
      const angle = Math.random() * TAU;
      const distance = anchor.radius + radius + 80;
      clone.cells = [spawnCell(clone, mass, anchor.x + Math.cos(angle) * distance, anchor.y + Math.sin(angle) * distance)];
    } else {
      clone.cells = [spawnCell(clone)];
    }
  }
  return clone;
}

function joinRoom(client, requestedRoom) {
  const roomId = requestedRoom.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "agar";
  let room = rooms.get(roomId);
  if (!room) room = createRoom(roomId);
  if (!room.peers.has(client) && room.peers.size >= MAX_ROOM_PEERS) {
    sendJson(client, { t: "relayError", message: "ROOM_FULL" });
    return;
  }

  client.room = roomId;
  if (!client.actorId) client.actorId = `player-${client.id}`;
  room.peers.add(client);
  if (!room.actors.has(client.actorId)) room.actors.set(client.actorId, createActor(client.actorId, `P${room.peers.size}`));
  sendJson(client, { t: "relayReady", room: roomId, peers: room.peers.size, maxPeers: MAX_ROOM_PEERS, actorId: client.actorId, role: "client" });
  broadcast(room, { t: "relayPeer", room: roomId, peers: room.peers.size, maxPeers: MAX_ROOM_PEERS });
  sendSnapshot(room, true);
}

function leaveRoom(client) {
  if (!client.alive) return;
  client.alive = false;
  const room = rooms.get(client.room);
  if (!room) return;
  room.peers.delete(client);
  room.actors.delete(client.actorId);
  room.actors.delete(cloneActorId(client.actorId));
  broadcast(room, { t: "relayPeer", room: client.room, peers: room.peers.size, maxPeers: MAX_ROOM_PEERS });
  if (room.peers.size === 0) rooms.delete(client.room);
}

function splitActor(actor) {
  if (actor.cells.length >= MAX_CELLS) return;
  const source = actor.cells.filter((cell) => !cell.dead && cell.mass >= MIN_SPLIT_MASS * 2).sort((a, b) => b.mass - a.mass)[0];
  if (!source) return;
  const dx = actor.input.targetX - source.x;
  const dy = actor.input.targetY - source.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  const childMass = source.mass * 0.5;
  source.mass = childMass;
  source.radius = radiusFromMass(source.mass);
  const child = spawnCell(actor, childMass, source.x + nx * (source.radius + 16), source.y + ny * (source.radius + 16));
  child.boostX = nx * 520;
  child.boostY = ny * 520;
  child.splitBoostAge = 0.7;
  actor.cells.push(child);
}

function ejectMass(room, actor) {
  const cell = actor.cells.filter((item) => !item.dead && item.mass > EJECT_MASS + 20).sort((a, b) => b.mass - a.mass)[0];
  if (!cell) return;
  const dx = actor.input.targetX - cell.x;
  const dy = actor.input.targetY - cell.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  cell.mass -= EJECT_MASS;
  cell.radius = radiusFromMass(cell.mass);
  room.feeds.push({
    id: nextEntityId++,
    x: cell.x + nx * (cell.radius + 12),
    y: cell.y + ny * (cell.radius + 12),
    mass: EJECT_MASS,
    radius: radiusFromMass(EJECT_MASS),
    color: actor.color,
    vx: nx * 620,
    vy: ny * 620,
    age: 0,
    ownerId: actor.id,
    dead: false
  });
}

function updateRoom(room, dt, now) {
  while (room.foods.length < FOOD_TARGET) room.foods.push(createFood());
  while (room.viruses.length < VIRUS_TARGET) room.viruses.push(createVirus());

  for (const actor of room.actors.values()) {
    for (const cell of actor.cells) {
      if (cell.dead) continue;
      const dx = actor.input.targetX - cell.x;
      const dy = actor.input.targetY - cell.y;
      const len = Math.hypot(dx, dy);
      const speed = clamp(1400 / Math.pow(cell.radius, 0.46), 90, 330);
      if (len > 1) {
        cell.faceX = dx / len;
        cell.faceY = dy / len;
        const throttle = clamp(len / Math.max(35, cell.radius * 1.8), 0, 1);
        cell.vx += (cell.faceX * speed * throttle - cell.vx) * Math.min(1, dt * 6);
        cell.vy += (cell.faceY * speed * throttle - cell.vy) * Math.min(1, dt * 6);
      }
      if (cell.virusCooldown > 0) cell.virusCooldown = Math.max(0, cell.virusCooldown - dt);
      cell.x += (cell.vx + cell.boostX) * dt;
      cell.y += (cell.vy + cell.boostY) * dt;
      cell.boostX *= Math.exp(-dt * 4.4);
      cell.boostY *= Math.exp(-dt * 4.4);
      cell.splitBoostAge = Math.max(0, cell.splitBoostAge - dt);
      cell.radius = radiusFromMass(cell.mass);
      cell.x = clamp(cell.x, cell.radius, WORLD_SIZE - cell.radius);
      cell.y = clamp(cell.y, cell.radius, WORLD_SIZE - cell.radius);
    }
    actor.cells = actor.cells.filter((cell) => !cell.dead);
    if (!actor.cells.length) actor.cells.push(spawnCell(actor));
  }

  resolveOwnCellOverlap(room);
  for (const feed of room.feeds) {
    feed.x += feed.vx * dt;
    feed.y += feed.vy * dt;
    feed.vx *= Math.exp(-dt * 2.3);
    feed.vy *= Math.exp(-dt * 2.3);
    feed.age += dt;
    if (feed.x < 0 || feed.x > WORLD_SIZE || feed.y < 0 || feed.y > WORLD_SIZE) feed.dead = true;
  }

  handleFoodEating(room);
  handleFeedEating(room);
  handleVirusCellCollisions(room);
  handleCellEating(room);
  room.foods = room.foods.filter((food) => !food.dead);
  room.viruses = room.viruses.filter((virus) => !virus.dead);
  room.feeds = room.feeds.filter((feed) => !feed.dead && feed.age < 18);

  if (now - room.lastSnapshotAt >= 1 / SNAPSHOT_RATE) {
    sendSnapshot(room, false);
    room.lastSnapshotAt = now;
  }
  if (now - room.lastWorldAt >= 1 / WORLD_RATE) {
    sendWorld(room);
    room.lastWorldAt = now;
  }
}

function allCells(room) {
  const cells = [];
  for (const actor of room.actors.values()) {
    for (const cell of actor.cells) if (!cell.dead) cells.push({ actor, cell });
  }
  return cells;
}

function canEat(a, b) {
  if (a.radius < b.radius * Math.sqrt(CONSUME_RATIO)) return false;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const threshold = a.radius - b.radius * 0.22;
  return dx * dx + dy * dy <= threshold * threshold;
}

function handleFoodEating(room) {
  for (const { cell } of allCells(room)) {
    for (const food of room.foods) {
      if (food.dead) continue;
      const dx = cell.x - food.x;
      const dy = cell.y - food.y;
      if (dx * dx + dy * dy <= (cell.radius + 10) * (cell.radius + 10)) {
        food.dead = true;
        room.removedFoodIds.add(food.id);
        cell.mass += food.mass;
      }
    }
  }
}

function handleVirusCellCollisions(room) {
  const entries = allCells(room).sort((a, b) => b.cell.mass - a.cell.mass);
  for (const entry of entries) {
    const cell = entry.cell;
    if (cell.dead || cell.virusCooldown > 0 || cell.mass < 133) continue;
    for (const virus of room.viruses) {
      if (virus.dead) continue;
      const dx = cell.x - virus.x;
      const dy = cell.y - virus.y;
      const hitRadius = cell.radius + virus.radius * 0.85;
      if (dx * dx + dy * dy > hitRadius * hitRadius) continue;
      virus.dead = true;
      room.removedVirusIds.add(virus.id);
      burstCellOnVirus(room, entry.actor, cell, virus);
      break;
    }
  }
}

function burstCellOnVirus(room, actor, cell, virus) {
  const liveCount = actor.cells.filter((item) => !item.dead).length;
  if (liveCount >= MAX_CELLS) {
    cell.mass += virus.mass;
    cell.radius = radiusFromMass(cell.mass);
    cell.virusCooldown = 0.35;
    return;
  }

  const capacity = MAX_CELLS - liveCount;
  const pieceCount = Math.max(1, Math.min(capacity, Math.max(3, Math.floor(cell.mass / 95))));
  const totalMass = cell.mass + Math.max(0, virus.mass * 0.25);
  const mainMass = Math.max(64, totalMass * 0.42);
  const fragmentTotal = Math.max(pieceCount * 18, totalMass - mainMass);
  cell.mass = Math.max(24, totalMass - fragmentTotal);
  cell.radius = radiusFromMass(cell.mass);
  cell.virusCooldown = 0.55;

  for (let i = 0; i < pieceCount; i += 1) {
    const share = fragmentTotal / pieceCount;
    const angle = (i / pieceCount) * TAU + rand(-0.32, 0.32);
    const distance = cell.radius + radiusFromMass(share) + 10;
    const child = spawnCell(actor, share, cell.x + Math.cos(angle) * distance, cell.y + Math.sin(angle) * distance);
    const speed = rand(430, 620);
    child.boostX = Math.cos(angle) * speed;
    child.boostY = Math.sin(angle) * speed;
    child.splitBoostAge = 0.75;
    child.virusCooldown = 0.55;
    actor.cells.push(child);
  }
}

function resolveOwnCellOverlap(room) {
  for (const actor of room.actors.values()) {
    const cells = actor.cells.filter((cell) => !cell.dead);
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        const a = cells[i];
        const b = cells[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const minDistance = (a.radius + b.radius) * 0.86;
        if (distance >= minDistance) continue;
        const push = (minDistance - distance) * 0.5;
        const nx = dx / distance;
        const ny = dy / distance;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
        const damp = clamp(1 - push / Math.max(80, minDistance), 0.45, 0.92);
        a.vx *= damp;
        a.vy *= damp;
        b.vx *= damp;
        b.vy *= damp;
        a.x = clamp(a.x, a.radius, WORLD_SIZE - a.radius);
        a.y = clamp(a.y, a.radius, WORLD_SIZE - a.radius);
        b.x = clamp(b.x, b.radius, WORLD_SIZE - b.radius);
        b.y = clamp(b.y, b.radius, WORLD_SIZE - b.radius);
      }
    }
  }
}

function handleFeedEating(room) {
  for (const { cell } of allCells(room)) {
    for (const feed of room.feeds) {
      if (feed.dead || (feed.ownerId === cell.ownerId && feed.age < 0.7)) continue;
      const dx = cell.x - feed.x;
      const dy = cell.y - feed.y;
      if (dx * dx + dy * dy <= (cell.radius + feed.radius * 0.5) ** 2) {
        feed.dead = true;
        cell.mass += feed.mass;
      }
    }
  }
}

function handleCellEating(room) {
  const entries = allCells(room).sort((a, b) => b.cell.radius - a.cell.radius);
  for (const eater of entries) {
    if (eater.cell.dead) continue;
    for (const victim of entries) {
      if (victim.cell.dead || eater.cell === victim.cell || eater.actor.id === victim.actor.id) continue;
      if (!canEat(eater.cell, victim.cell)) continue;
      victim.cell.dead = true;
      eater.cell.mass += victim.cell.mass;
      eater.cell.radius = radiusFromMass(eater.cell.mass);
    }
  }
}

function serializeCell(cell) {
  return {
    id: cell.id,
    x: cell.x,
    y: cell.y,
    mass: cell.mass,
    vx: cell.vx,
    vy: cell.vy,
    boostX: cell.boostX,
    boostY: cell.boostY,
    faceX: cell.faceX,
    faceY: cell.faceY,
    mergeReadyAt: 0,
    birthAge: cell.birthAge,
    birthDuration: cell.birthDuration,
    birthX: cell.birthX,
    birthY: cell.birthY,
    birthScale: cell.birthScale,
    fragmentAge: 0,
    splitBoostAge: cell.splitBoostAge,
    splitHoldAge: 0,
    pendingBoostX: 0,
    pendingBoostY: 0,
    virusCooldown: 0,
    mergeVirusWindow: 0,
    mergeOverflowMass: 0,
    mergeBurstPieces: 1,
    mergeBurstTotal: cell.mass,
    splitPriority: cell.splitPriority,
    targetX: cell.targetX,
    targetY: cell.targetY
  };
}

function serializeActor(actor) {
  return {
    id: actor.id,
    name: actor.name,
    color: actor.color,
    isHuman: true,
    localClone: Boolean(actor.localClone),
    cells: actor.cells.filter((cell) => !cell.dead).map(serializeCell)
  };
}

function serializeCircle(entity) {
  return {
    id: entity.id,
    x: entity.x,
    y: entity.y,
    mass: entity.mass,
    radius: entity.radius,
    color: entity.color,
    vx: entity.vx || 0,
    vy: entity.vy || 0,
    age: entity.age || 0,
    feedCount: entity.feedCount || 0,
    ownerId: entity.ownerId || "",
    natural: entity.natural !== false
  };
}

function sendSnapshot(room, forceWorld) {
  const removedFoodIds = Array.from(room.removedFoodIds);
  const removedVirusIds = Array.from(room.removedVirusIds);
  broadcast(room, {
    t: "snapshot",
    now: Date.now() / 1000,
    worldSize: WORLD_SIZE,
    settings: {
      splitSpeed: 110,
      splitDecayTime: 0.7,
      splitInputSpeed: 4,
      spawnMass: PLAYER_MASS,
      gameSpeed: 1,
      botEnabled: false,
      nRespawnEnabled: true
    },
    partialActors: true,
    actors: Array.from(room.actors.values()).map(serializeActor),
    removedFoodIds,
    removedVirusIds,
    feeds: room.feeds.slice(0, 220).map(serializeCircle)
  });
  room.removedFoodIds.clear();
  room.removedVirusIds.clear();
  if (forceWorld) sendWorld(room);
}

function sendWorld(room) {
  room.worldSeq += 1;
  broadcast(room, { t: "world", kind: "foods", seq: room.worldSeq, index: 0, total: 1, items: room.foods.slice(0, FOOD_TARGET).map(serializeCircle) });
  broadcast(room, { t: "world", kind: "viruses", seq: room.worldSeq, index: 0, total: 1, items: room.viruses.slice(0, VIRUS_TARGET).map(serializeCircle) });
}

function broadcast(room, message) {
  for (const peer of room.peers) sendJson(peer, message);
}

function sendJson(client, message) {
  if (!client.socket || client.socket.destroyed) return;
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

setInterval(() => {
  const now = Date.now() / 1000;
  for (const room of rooms.values()) {
    const dt = Math.min(0.05, Math.max(0.001, now - room.lastTickAt));
    room.lastTickAt = now;
    updateRoom(room, dt, now);
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Tain.io authoritative server ready: http://localhost:${PORT}`);
});
