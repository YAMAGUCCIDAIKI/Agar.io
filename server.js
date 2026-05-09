const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const MAX_ROOM_PEERS = 10;
const WORLD_SIZE = 5000;
const FOOD_TARGET = 1200;
const VIRUS_TARGET = 36;
const PLAYER_MASS = 132;
const FOOD_MASS = 1;
const VIRUS_MASS = 100;
const MAX_CELLS = 16;
const MIN_SPLIT_MASS = 36;
const EJECT_MASS = 21;
const CONSUME_RATIO = 1.325;
const CONSUME_RADIUS_RATIO = Math.sqrt(CONSUME_RATIO);
const MAX_CELL_MASS = 22500;
const MAX_MERGE_VIRUS_HIT_MASS = MAX_CELL_MASS * 2;
const UNCONSUMABLE_CELL_MASS = 16900;
const MERGE_COOLDOWN = 30;
const MASS_CAP_SETTLE_FRAMES = 10;
const MERGE_CAP_OVERSIZE_RATIO = 1.04;
const MERGE_SWAP_RESET_TIME = 0.22;
const VIRUS_EXPLODE_MASS = 133;
const VIRUS_FRAGMENT_LIFE = 2.8;
const TICK_RATE = 60;
const SNAPSHOT_RATE = 45;
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
    removedFeedIds: new Set(),
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
    capFramesLeft: mass > MAX_CELL_MASS ? MASS_CAP_SETTLE_FRAMES : 0,
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
    mergeOverflowMass: Math.max(0, mass - MAX_CELL_MASS),
    mergeBurstPieces: 1,
    mergeBurstTotal: mass,
    splitPriority: 0,
    mergePartnerId: null,
    mergeDominantId: null,
    separationGraceUntil: 0,
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
    nextSplitPriority: 1,
    input: {
      targetX: WORLD_SIZE * 0.5,
      targetY: WORLD_SIZE * 0.5,
      lastAimX: 1,
      lastAimY: 0,
      splitQueued: false,
      splitCount: 0,
      splitLockX: 1,
      splitLockY: 0,
      splitLockActive: false,
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
      activeActor.input.splitQueued = true;
      activeActor.input.splitCount += count;
      activeActor.input.splitLockActive = false;
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
    clone = createActor(id, `${source.name || source.id}2`);
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

function actorAimDirection(actor) {
  const live = actor.cells.filter((cell) => !cell.dead);
  const base = live[0] || { x: WORLD_SIZE * 0.5, y: WORLD_SIZE * 0.5 };
  const n = normalized(actor.input.targetX - base.x, actor.input.targetY - base.y, actor.input.lastAimX || 1, actor.input.lastAimY || 0);
  actor.input.lastAimX = n.x;
  actor.input.lastAimY = n.y;
  return n;
}

function splitCell(actor, source, dirX, dirY, targetX = null, targetY = null) {
  if (actor.cells.length >= MAX_CELLS) return false;
  if (source.dead || source.mass < MIN_SPLIT_MASS * 2) return false;
  if (targetX != null && targetY != null) {
    const aim = normalized(targetX - source.x, targetY - source.y, dirX, dirY);
    dirX = aim.x;
    dirY = aim.y;
  }
  const childMass = source.mass * 0.5;
  source.mass = childMass;
  source.radius = radiusFromMass(source.mass);
  setMergeCooldown(source);
  const childRadius = radiusFromMass(childMass);
  const spawnOffset = (source.radius + childRadius) * 0.42;
  const child = spawnCell(actor, childMass, source.x + dirX * spawnOffset, source.y + dirY * spawnOffset);
  const impulse = clamp(110 * Math.sqrt(child.radius) * 0.6, 180, 560);
  child.vx = source.vx + dirX * impulse;
  child.vy = source.vy + dirY * impulse;
  source.faceX = dirX;
  source.faceY = dirY;
  child.faceX = dirX;
  child.faceY = dirY;
  child.splitBoostAge = 0.08;
  child.splitPriority = actor.nextSplitPriority || 1;
  actor.nextSplitPriority = (actor.nextSplitPriority || 1) + 1;
  child.separationGraceUntil = Date.now() / 1000 + 0.14;
  source.separationGraceUntil = Date.now() / 1000 + 0.14;
  setMergeCooldown(child);
  source.vx *= 0.24;
  source.vy *= 0.24;
  actor.cells.push(child);
  return true;
}

function splitActor(actor, dirX, dirY, targetX = null, targetY = null) {
  if (actor.cells.length >= MAX_CELLS) return;
  const candidates = actor.cells
    .filter((cell) => !cell.dead && cell.mass >= MIN_SPLIT_MASS * 2)
    .sort((a, b) => {
      const priorityDiff = (a.splitPriority || 0) - (b.splitPriority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return a.id - b.id;
    });
  for (const cell of candidates) {
    if (actor.cells.length >= MAX_CELLS) break;
    splitCell(actor, cell, dirX, dirY, targetX, targetY);
  }
  return candidates.length > 0;
}

function processActorInputs(room, now) {
  for (const actor of room.actors.values()) {
    if (!actor.input.splitQueued) continue;
    if (!actor.input.splitLockActive) {
      const aim = actorAimDirection(actor);
      actor.input.splitLockX = aim.x;
      actor.input.splitLockY = aim.y;
      actor.input.splitLockActive = true;
    }
    let remaining = Math.max(1, actor.input.splitCount || 1);
    let budget = 4;
    let didAnySplit = false;
    while (remaining > 0 && budget > 0 && actor.cells.filter((cell) => !cell.dead).length < MAX_CELLS) {
      if (!splitActor(actor, actor.input.splitLockX, actor.input.splitLockY, actor.input.targetX, actor.input.targetY)) {
        remaining = 0;
      } else {
        didAnySplit = true;
        remaining -= 1;
        budget -= 1;
      }
    }
    actor.input.splitCount = Math.max(0, remaining);
    if (actor.input.splitCount <= 0 || (!didAnySplit && actor.cells.filter((cell) => !cell.dead).length >= MAX_CELLS)) {
      actor.input.splitQueued = false;
      actor.input.splitCount = 0;
      actor.input.splitLockActive = false;
    }
  }
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
    vx: nx * 710,
    vy: ny * 710,
    age: 0,
    ownerId: actor.id,
    dead: false
  });
}

function updateRoom(room, dt, now) {
  while (room.foods.length < FOOD_TARGET) room.foods.push(createFood());
  while (room.viruses.length < VIRUS_TARGET) room.viruses.push(createVirus());

  processActorInputs(room, now);

  for (const actor of room.actors.values()) {
    for (const cell of actor.cells) {
      if (cell.dead) continue;
      const dx = actor.input.targetX - cell.x;
      const dy = actor.input.targetY - cell.y;
      const len = Math.hypot(dx, dy);
      const speed = clamp(1440 / Math.pow(cell.radius, 0.46), 116, 436) * 0.312;
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
      cell.fragmentAge = Math.max(0, (cell.fragmentAge || 0) - dt);
      cell.mergeVirusWindow = Math.max(0, (cell.mergeVirusWindow || 0) - dt);
      settleMassCap(cell);
      cell.x = clamp(cell.x, cell.radius, WORLD_SIZE - cell.radius);
      cell.y = clamp(cell.y, cell.radius, WORLD_SIZE - cell.radius);
    }
    actor.cells = actor.cells.filter((cell) => !cell.dead);
    if (!actor.cells.length) actor.cells.push(spawnCell(actor));
  }

  resolveOwnCells(room, now);
  for (const feed of room.feeds) {
    feed.x += feed.vx * dt;
    feed.y += feed.vy * dt;
    feed.vx *= Math.exp(-dt * 2.3);
    feed.vy *= Math.exp(-dt * 2.3);
    feed.age += dt;
    if (feed.x < 0 || feed.x > WORLD_SIZE || feed.y < 0 || feed.y > WORLD_SIZE) {
      feed.dead = true;
      room.removedFeedIds.add(feed.id);
    }
  }

  handleFoodEating(room);
  handleFeedEating(room);
  handleFeedVirusCollisions(room);
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
  if (b.ownerId && b.mass >= UNCONSUMABLE_CELL_MASS) return false;
  if (a.mass + 0.001 < b.mass * CONSUME_RATIO) return false;
  if (a.radius + 0.001 < b.radius * CONSUME_RADIUS_RATIO) return false;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const threshold = a.radius - b.radius * 0.22;
  if (threshold > 0 && dx * dx + dy * dy <= threshold * threshold) return true;
  return circleOverlapArea(a.radius, b.radius, Math.hypot(dx, dy)) >= Math.PI * b.radius * b.radius * 0.5;
}

function circleOverlapArea(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) {
    const r = Math.min(r1, r2);
    return Math.PI * r * r;
  }
  const a1 = Math.acos(clamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1), -1, 1));
  const a2 = Math.acos(clamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2), -1, 1));
  return r1 * r1 * a1 + r2 * r2 * a2 - 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
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
        addConsumedMass(cell, food.mass);
      }
    }
  }
}

function setMergeCooldown(cell, now = Date.now() / 1000) {
  cell.mergeReadyAt = now + MERGE_COOLDOWN;
  cell.cooldown = MERGE_COOLDOWN;
  cell.mergePartnerId = null;
  cell.mergeDominantId = null;
}

function refreshCell(cell) {
  cell.mass = Math.max(12, cell.mass);
  cell.radius = radiusFromMass(cell.mass);
}

function addMass(cell, amount) {
  cell.mass += amount;
  if (cell.mass > MAX_CELL_MASS) cell.capFramesLeft = MASS_CAP_SETTLE_FRAMES;
  refreshCell(cell);
}

function addConsumedMass(cell, amount) {
  const previousMass = cell.mass;
  addMass(cell, amount);
  const massDamping = Math.sqrt(Math.max(12, previousMass) / Math.max(previousMass, cell.mass));
  const damping = clamp(massDamping * 0.88, 0.42, 0.96);
  cell.vx *= damping;
  cell.vy *= damping;
  cell.boostX *= damping;
  cell.boostY *= damping;
}

function settleMassCap(cell) {
  if (cell.mass <= MAX_CELL_MASS) return;
  if (cell.capFramesLeft > 0) {
    cell.mass -= (cell.mass - MAX_CELL_MASS) / cell.capFramesLeft;
    cell.capFramesLeft -= 1;
  } else {
    cell.mass = MAX_CELL_MASS;
  }
  refreshCell(cell);
}

function handleFeedVirusCollisions(room) {
  for (const feed of room.feeds) {
    if (feed.dead) continue;
    for (const virus of room.viruses) {
      if (virus.dead) continue;
      const hit = virus.radius + feed.radius * 0.4;
      const dx = feed.x - virus.x;
      const dy = feed.y - virus.y;
      if (dx * dx + dy * dy > hit * hit) continue;
      feed.dead = true;
      room.removedFeedIds.add(feed.id);
      virus.feedCount += 1;
      if (virus.feedCount >= 7) {
        virus.feedCount = 0;
        const n = normalized(feed.vx, feed.vy, feed.x - virus.x, feed.y - virus.y);
        const spawned = createVirus();
        spawned.x = clamp(virus.x + n.x * (virus.radius * 2.1), virus.radius, WORLD_SIZE - virus.radius);
        spawned.y = clamp(virus.y + n.y * (virus.radius * 2.1), virus.radius, WORLD_SIZE - virus.radius);
        spawned.vx = n.x * 540;
        spawned.vy = n.y * 540;
        room.viruses.push(spawned);
      }
      break;
    }
  }
}

function normalized(x, y, fallbackX = 1, fallbackY = 0) {
  const length = Math.hypot(x, y);
  if (length > 0.0001) return { x: x / length, y: y / length };
  const fallbackLength = Math.hypot(fallbackX, fallbackY) || 1;
  return { x: fallbackX / fallbackLength, y: fallbackY / fallbackLength };
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
      const hit = cell.radius + virus.radius * 0.85;
      if (dx * dx + dy * dy > hit * hit) continue;
      if (entry.actor.cells.filter((item) => !item.dead).length >= MAX_CELLS) {
        virus.dead = true;
        room.removedVirusIds.add(virus.id);
        addConsumedMass(cell, virus.mass);
        cell.virusCooldown = 0.35;
        break;
      }
      explodeCellOnVirus(entry.actor, cell, virus);
      virus.dead = true;
      room.removedVirusIds.add(virus.id);
      break;
    }
  }
}

function virusBurstMasses(totalMass, pieces) {
  if (pieces <= 1) return [totalMass];
  const weights = [];
  const chainBurst = pieces > 5;
  if (chainBurst) {
    weights.push(rand(7.8, 9.4), rand(2.1, 3.0));
    for (let i = 2; i < pieces; i += 1) weights.push(rand(0.18, 0.32));
  } else {
    const mediumCount = Math.min(2, Math.max(1, pieces - 2));
    for (let i = 0; i < pieces; i += 1) {
      if (i === 0) weights.push(rand(9.2, 10.8));
      else if (i === 1) weights.push(rand(4.2, 5.4));
      else if (i <= mediumCount) weights.push(rand(1.0, 1.45));
      else weights.push(rand(0.2, 0.38));
    }
  }
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const masses = weights.map((weight) => Math.max(12, totalMass * weight / weightTotal));
  const massTotal = masses.reduce((sum, mass) => sum + mass, 0);
  masses[0] += totalMass - massTotal;
  return masses.sort((a, b) => b - a);
}

function explodeCellOnVirus(actor, cell, virus) {
  const liveCells = actor.cells.filter((item) => !item.dead).length;
  const slots = MAX_CELLS - liveCells + 1;
  const total = mergeVirusHitMass(cell) + virus.mass;
  const pieces = Math.floor(Math.min(slots, clamp(Math.floor(total / MIN_SPLIT_MASS), 4, 16)));
  if (pieces <= 1) return;
  const masses = virusBurstMasses(total, pieces);
  const originX = cell.x;
  const originY = cell.y;
  const baseAngle = Math.atan2(cell.y - virus.y, cell.x - virus.x);
  cell.mass = masses[0];
  refreshCell(cell);
  cell.vx *= 0.16;
  cell.vy *= 0.16;
  cell.virusCooldown = 0.42;
  cell.faceX = Math.cos(baseAngle);
  cell.faceY = Math.sin(baseAngle);

  for (let i = 1; i < pieces; i += 1) {
    const angle = baseAngle + (TAU * (i - 1) / Math.max(1, pieces - 1)) + rand(-0.16, 0.16);
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const mass = masses[i];
    const radius = radiusFromMass(mass);
    const distance = Math.max(radius + 3, cell.radius * 0.58 + radius * 0.18);
    const child = spawnCell(actor, mass, originX + dirX * distance, originY + dirY * distance);
    const massDrag = clamp(Math.sqrt(72 / Math.max(20, child.mass)), 0.45, 0.92);
    const burst = rand(210, 390) * massDrag * 0.6;
    child.vx = dirX * burst;
    child.vy = dirY * burst;
    child.faceX = dirX;
    child.faceY = dirY;
    child.fragmentAge = 2.8;
    child.virusCooldown = 0.42;
    setMergeCooldown(child);
    actor.cells.push(child);
  }
}

function mergeVirusHitMass(cell) {
  const burstMass = cell.mergeVirusWindow > 0 ? Math.max(cell.mergeBurstTotal || 0, cell.mass) : cell.mass;
  return clamp(burstMass, cell.mass, MAX_MERGE_VIRUS_HIT_MASS);
}

function tryMerge(actor, a, b, now) {
  if ((a.mergeReadyAt || 0) > now || (b.mergeReadyAt || 0) > now) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance >= a.radius + b.radius) return false;
  const smallRadius = Math.min(a.radius, b.radius);
  if (circleOverlapArea(a.radius, b.radius, distance) < Math.PI * smallRadius * smallRadius * 0.5) return false;

  const aMass = a.mass;
  const bMass = b.mass;
  const big = aMass >= bMass ? a : b;
  const small = big === a ? b : a;
  const total = aMass + bMass;
  const inv = 1 / total;
  big.x = (a.x * aMass + b.x * bMass) * inv;
  big.y = (a.y * aMass + b.y * bMass) * inv;
  big.vx = (a.vx * aMass + b.vx * bMass) * inv;
  big.vy = (a.vy * aMass + b.vy * bMass) * inv;
  big.boostX = (a.boostX * aMass + b.boostX * bMass) * inv;
  big.boostY = (a.boostY * aMass + b.boostY * bMass) * inv;
  big.mass = total > MAX_CELL_MASS ? Math.min(total, MAX_CELL_MASS * MERGE_CAP_OVERSIZE_RATIO) : total;
  big.mergeOverflowMass = Math.max(0, total - MAX_CELL_MASS);
  big.mergeBurstPieces = 1;
  big.mergeBurstTotal = total;
  big.mergeVirusWindow = total > MAX_CELL_MASS ? 4.0 : 0.28;
  big.virusCooldown = 0;
  if (big.mass > MAX_CELL_MASS) big.capFramesLeft = MASS_CAP_SETTLE_FRAMES;
  refreshCell(big);
  small.dead = true;
  actor.lastMergeAt = now;
  return true;
}

function resolveOwnCells(room, now) {
  for (const actor of room.actors.values()) {
    const cells = actor.cells.filter((cell) => !cell.dead);
    let merged = false;
    for (let i = 0; i < cells.length && !merged; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        if (tryMerge(actor, cells[i], cells[j], now)) {
          merged = true;
          break;
        }
      }
    }
    if (merged) continue;
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        const a = cells[i];
        const b = cells[j];
        if ((a.mergeReadyAt || 0) <= now && (b.mergeReadyAt || 0) <= now) continue;
        if (a.separationGraceUntil > now || b.separationGraceUntil > now) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const minDistance = a.radius + b.radius;
        if (distance >= minDistance) continue;
        const push = (minDistance - distance) * 0.5;
        const nx = dx / distance;
        const ny = dy / distance;
        a.x = clamp(a.x - nx * push, a.radius, WORLD_SIZE - a.radius);
        a.y = clamp(a.y - ny * push, a.radius, WORLD_SIZE - a.radius);
        b.x = clamp(b.x + nx * push, b.radius, WORLD_SIZE - b.radius);
        b.y = clamp(b.y + ny * push, b.radius, WORLD_SIZE - b.radius);
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
        room.removedFeedIds.add(feed.id);
        addConsumedMass(cell, feed.mass);
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
      addConsumedMass(eater.cell, victim.cell.mass);
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
    mergeReadyAt: cell.mergeReadyAt || 0,
    capFramesLeft: cell.capFramesLeft || 0,
    birthAge: cell.birthAge,
    birthDuration: cell.birthDuration,
    birthX: cell.birthX,
    birthY: cell.birthY,
    birthScale: cell.birthScale,
    fragmentAge: cell.fragmentAge || 0,
    splitBoostAge: cell.splitBoostAge,
    splitHoldAge: 0,
    pendingBoostX: 0,
    pendingBoostY: 0,
    virusCooldown: cell.virusCooldown || 0,
    mergeVirusWindow: cell.mergeVirusWindow || 0,
    mergeOverflowMass: cell.mergeOverflowMass || 0,
    mergeBurstPieces: 1,
    mergeBurstTotal: cell.mergeBurstTotal || cell.mass,
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
  const removedFeedIds = Array.from(room.removedFeedIds);
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
      ejectSpeed: 710,
      ejectRate: 11,
      ejectMass: EJECT_MASS,
      gameSpeed: 1,
      botEnabled: false,
      nRespawnEnabled: true
    },
    partialActors: true,
    actors: Array.from(room.actors.values()).map(serializeActor),
    removedFoodIds,
    removedFeedIds,
    removedVirusIds,
    feeds: room.feeds.slice(0, 220).map(serializeCircle)
  });
  room.removedFoodIds.clear();
  room.removedFeedIds.clear();
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
