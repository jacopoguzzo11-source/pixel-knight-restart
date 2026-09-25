const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const publicQueue = [];
const PLAYER_RADIUS = 0.56;
const PLAYER_MIN_DISTANCE = 1.18;
const TICK = 1000 / 30;

const MAPS = {
  keep: {
    id: "keep", name: "Fortezza di Pietra", arena: 16,
    spawns: [
      { x: -10, z: -5.5, yaw: -Math.PI / 2 },
      { x: 10, z: -5.5, yaw: Math.PI / 2 },
      { x: -10, z: 5.5, yaw: -Math.PI / 2 },
      { x: 10, z: 5.5, yaw: Math.PI / 2 }
    ],
    obstacles: [{ x: 0, z: 0, r: 1.65 }]
  },
  forest: {
    id: "forest", name: "Rovine della Foresta", arena: 18,
    spawns: [
      { x: -11, z: -6, yaw: -Math.PI / 2 },
      { x: 11, z: -6, yaw: Math.PI / 2 },
      { x: -11, z: 6, yaw: -Math.PI / 2 },
      { x: 11, z: 6, yaw: Math.PI / 2 }
    ],
    obstacles: [
      { x: -5.5, z: -4.0, r: 0.95 }, { x: 5.0, z: 4.5, r: 0.95 },
      { x: -4.0, z: 6.2, r: 0.85 }, { x: 6.0, z: -5.5, r: 0.85 }
    ]
  },
  colosseum: {
    id: "colosseum", name: "Colosseo delle Ceneri", arena: 17,
    spawns: [
      { x: -7, z: 10.5, yaw: 0 },
      { x: 7, z: -10.5, yaw: Math.PI },
      { x: 7, z: 10.5, yaw: 0 },
      { x: -7, z: -10.5, yaw: Math.PI }
    ],
    obstacles: [
      { x: -6.2, z: -6.2, r: 0.8 }, { x: 6.2, z: -6.2, r: 0.8 },
      { x: -6.2, z: 6.2, r: 0.8 }, { x: 6.2, z: 6.2, r: 0.8 }
    ]
  }
};

const WEAPONS = {
  sword: { name: "Spada", type: "melee", damage: 28, reach: 3.35, width: 0.95, cooldown: 500, stamina: 17 },
  spear: { name: "Lancia", type: "melee", damage: 24, reach: 4.65, width: 0.72, cooldown: 650, stamina: 20 },
  axe: { name: "Ascia da guerra", type: "melee", damage: 40, reach: 2.85, width: 1.02, cooldown: 820, stamina: 27 },
  bow: { name: "Arco", type: "bow", damage: 22, cooldown: 800, stamina: 12 }
};
const PRICES = { bow: 75, arrows: 20, spear: 65, axe: 85, shield: 120 };
const SKINS = new Set(["crimson", "azure", "emerald", "obsidian"]);
const BOT_LEVELS = {
  easy:   { name: "Bot Facile", speed: 2.65, think: 850, aimError: 0.22, attackDelay: 260, blockChance: 0.00, weapon: "sword", skin: "emerald" },
  medium: { name: "Bot Medio",  speed: 3.65, think: 460, aimError: 0.10, attackDelay: 100, blockChance: 0.22, weapon: "spear", skin: "azure" },
  hard:   { name: "Bot Difficile", speed: 4.55, think: 220, aimError: 0.035, attackDelay: 0, blockChance: 0.48, weapon: "sword", skin: "obsidian" }
};

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function getRoom(socket) { return socket.data.room ? rooms.get(socket.data.room) : null; }
function sanitizeName(s) {
  return String(s || "Cavaliere").replace(/[<>]/g, "").slice(0, 18) || "Cavaliere";
}
function mapOf(room) { return MAPS[room.map] || MAPS.keep; }
function forwardFromYaw(yaw) { return { x: -Math.sin(yaw), z: -Math.cos(yaw) }; }
function spawnForIndex(room, i) { return mapOf(room).spawns[i] || mapOf(room).spawns[0]; }
function formatCapacity(room) {
  if (room.mode !== "private") return 2;
  if (room.privateFormat === "1v1v1") return 3;
  if (room.privateFormat === "2v2") return 4;
  return 2;
}
function teamForIndex(room, index) {
  if (room.mode === "private" && room.privateFormat === "2v2") return index % 2;
  return null;
}
function areEnemies(room, a, b) {
  if (!a || !b || a.id === b.id || b.hp <= 0) return false;
  if (room.mode === "private" && room.privateFormat === "2v2") return a.team !== b.team;
  return true;
}
function enemiesOf(room, attacker) {
  return [...room.players.values()].filter(p => areEnemies(room, attacker, p));
}

function playerPublic(p) {
  return {
    id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
    hp: p.hp, stamina: p.stamina, weapon: p.weapon, blocking: p.blocking,
    ammo: p.ammo, coins: p.coins, score: p.score, ready: p.ready,
    owned: p.owned, shieldOwned: p.shieldOwned, shieldEquipped: p.shieldEquipped,
    skin: p.skin, isBot: !!p.isBot, botDifficulty: p.botDifficulty || null,
    team: p.team, alive: p.hp > 0
  };
}
function roomPublic(room) {
  return {
    code: room.code, hostId: room.hostId, map: room.map, mapName: mapOf(room).name,
    phase: room.phase, countdown: room.countdown, mode: room.mode,
    privateFormat: room.privateFormat || "1v1",
    maxPlayers: formatCapacity(room),
    botDifficulty: room.botDifficulty || null,
    players: [...room.players.values()].map(playerPublic),
    arrows: [...room.arrows.values()].map(a => ({
      id: a.id, x: a.x, y: a.y, z: a.z, yaw: a.yaw, pitch: a.pitch, owner: a.owner
    })),
    message: room.message || ""
  };
}
function emitRoom(room) { io.to(room.code).emit("state", roomPublic(room)); }

function newRoom(code, hostId, mode = "private", botDifficulty = null, privateFormat = "1v1") {
  return {
    code, hostId, mode, botDifficulty, privateFormat, map: "keep",
    players: new Map(), arrows: new Map(),
    phase: "lobby", countdown: 0, message: "", arrowSeq: 1
  };
}

function resolveMapCollision(room, x, z) {
  const m = mapOf(room);
  const limit = m.arena - PLAYER_RADIUS;
  x = clamp(x, -limit, limit);
  z = clamp(z, -limit, limit);
  for (const o of m.obstacles) {
    let dx = x - o.x, dz = z - o.z, d = Math.hypot(dx, dz);
    const min = o.r + PLAYER_RADIUS;
    if (d < min) {
      if (d < 0.001) { dx = 1; dz = 0; d = 1; }
      x = o.x + dx / d * min;
      z = o.z + dz / d * min;
    }
  }
  return { x, z };
}
function resolvePlayerCollision(room, self, x, z) {
  for (const other of room.players.values()) {
    if (other.id === self.id || other.hp <= 0) continue;
    let dx = x - other.x, dz = z - other.z, d = Math.hypot(dx, dz);
    if (d < PLAYER_MIN_DISTANCE) {
      if (d < 0.001) { dx = 1; dz = 0; d = 1; }
      x = other.x + dx / d * PLAYER_MIN_DISTANCE;
      z = other.z + dz / d * PLAYER_MIN_DISTANCE;
    }
  }
  return resolveMapCollision(room, x, z);
}

function createPlayer(id, name, room, index) {
  const s = spawnForIndex(room, index);
  return {
    id, name: sanitizeName(name),
    x: s.x, y: 0, z: s.z, yaw: s.yaw, pitch: 0,
    hp: 100, stamina: 100, weapon: "sword",
    owned: { sword: true, spear: false, axe: false, bow: false },
    shieldOwned: false, shieldEquipped: false, blocking: false,
    ammo: 0, coins: 220, score: 0, ready: false,
    attackAt: 0, lastMoveAt: Date.now(), skin: "crimson",
    team: teamForIndex(room, index),
    isBot: false, botDifficulty: null
  };
}

function createBot(room, difficulty, index) {
  const cfg = BOT_LEVELS[difficulty] || BOT_LEVELS.easy;
  const p = createPlayer(`BOT-${room.code}`, cfg.name, room, index);
  p.isBot = true;
  p.botDifficulty = difficulty;
  p.team = 1;
  p.skin = cfg.skin;
  p.weapon = cfg.weapon;
  p.owned = { sword: true, spear: true, axe: true, bow: true };
  p.shieldOwned = difficulty !== "easy";
  p.shieldEquipped = difficulty === "hard";
  p.coins = 0;
  p.ammo = 99;
  p.ready = true;
  p.bot = {
    nextThink: 0, desiredYaw: p.yaw, strafe: 1,
    nextGuard: 0, guardUntil: 0, attackReadyAt: 0
  };
  return p;
}

function resetRound(room) {
  room.phase = "active";
  room.message = "";
  room.arrows.clear();
  const ps = [...room.players.values()];
  ps.forEach((p, i) => {
    const s = spawnForIndex(room, i);
    p.x = s.x; p.y = 0; p.z = s.z; p.yaw = s.yaw; p.pitch = 0;
    p.hp = 100; p.stamina = 100; p.blocking = false;
    p.attackAt = 0; p.lastMoveAt = Date.now();
    if (p.weapon === "bow" && p.ammo < 6) p.ammo = 6;
    if (p.isBot && p.bot) {
      p.bot.nextThink = 0; p.bot.nextGuard = 0; p.bot.guardUntil = 0; p.bot.attackReadyAt = Date.now() + 500;
    }
  });
  io.to(room.code).emit("roundStart", {
    map: room.map, scores: ps.map(p => ({ id: p.id, score: p.score }))
  });
  emitRoom(room);
}
function beginCountdown(room) {
  if (room.phase !== "lobby") return;
  room.phase = "countdown"; room.countdown = 3; emitRoom(room);
  const iv = setInterval(() => {
    if (!rooms.has(room.code)) return clearInterval(iv);
    if (room.players.size !== formatCapacity(room)) {
      clearInterval(iv); room.phase = "lobby"; room.countdown = 0; emitRoom(room); return;
    }
    room.countdown--;
    if (room.countdown <= 0) { clearInterval(iv); resetRound(room); }
    else emitRoom(room);
  }, 1000);
}
function finishRound(room, winner, winnerTeam = null) {
  if (room.phase !== "active") return;
  room.phase = "roundEnd";

  let winners = [];
  if (winnerTeam !== null) {
    winners = [...room.players.values()].filter(p => p.team === winnerTeam);
    winners.forEach(p => p.score++);
    room.message = `Squadra ${winnerTeam === 0 ? "A" : "B"} vince il round`;
  } else if (winner) {
    winner.score++;
    winners = [winner];
    room.message = `${winner.name} vince il round`;
  } else {
    room.message = "Round in pareggio";
  }

  io.to(room.code).emit("roundEnd", {
    winner: winner ? winner.id : null,
    winnerTeam,
    winners: winners.map(p => p.id)
  });
  emitRoom(room);

  const matchWon = winners.length && winners.some(p => p.score >= 3);
  if (matchWon) {
    room.phase = "matchEnd";
    if (winnerTeam !== null) room.message = `Squadra ${winnerTeam === 0 ? "A" : "B"} vince il duello`;
    else room.message = `${winner.name} vince il duello`;
    io.to(room.code).emit("matchEnd", {
      winner: winner ? winner.id : null,
      winnerTeam,
      winners: winners.map(p => p.id)
    });
    setTimeout(() => {
      if (!rooms.has(room.code)) return;
      room.players.forEach(p => {
        p.score = 0; p.ready = p.isBot; p.hp = 100; p.stamina = 100; p.blocking = false;
      });
      room.phase = "lobby"; room.message = "";
      emitRoom(room);
    }, 6000);
  } else {
    setTimeout(() => {
      if (rooms.has(room.code) && room.players.size === formatCapacity(room)) resetRound(room);
    }, 3500);
  }
}

function checkRoundOutcome(room) {
  if (room.phase !== "active") return;
  const alive = [...room.players.values()].filter(p => p.hp > 0);

  if (room.mode === "private" && room.privateFormat === "2v2") {
    const teams = [...new Set(alive.map(p => p.team))];
    if (teams.length === 1) finishRound(room, null, teams[0]);
    else if (teams.length === 0) finishRound(room, null, null);
    return;
  }

  if (alive.length === 1) finishRound(room, alive[0], null);
  else if (alive.length === 0) finishRound(room, null, null);
}

function targetOf(room, attacker) {
  const enemies = enemiesOf(room, attacker);
  enemies.sort((a, b) =>
    Math.hypot(a.x - attacker.x, a.z - attacker.z) -
    Math.hypot(b.x - attacker.x, b.z - attacker.z)
  );
  return enemies[0] || null;
}

function pickMeleeTarget(room, attacker, weapon) {
  return enemiesOf(room, attacker)
    .filter(t => meleeCanHit(attacker, t, weapon))
    .sort((a, b) =>
      Math.hypot(a.x - attacker.x, a.z - attacker.z) -
      Math.hypot(b.x - attacker.x, b.z - attacker.z)
    )[0] || null;
}
function targetFacesAttacker(target, attacker) {
  const f = forwardFromYaw(target.yaw);
  const dx = attacker.x - target.x, dz = attacker.z - target.z;
  const d = Math.hypot(dx, dz) || 1;
  return (f.x * dx / d + f.z * dz / d) > 0.48;
}
function meleeCanHit(attacker, target, weapon) {
  const f = forwardFromYaw(attacker.yaw);
  const dx = target.x - attacker.x, dz = target.z - attacker.z;
  const along = dx * f.x + dz * f.z;
  const side = Math.abs(dx * f.z - dz * f.x);
  const vertical = Math.abs((attacker.y || 0) - (target.y || 0));
  return vertical < 1.55 && along > -0.15 && along <= weapon.reach && side <= weapon.width + PLAYER_RADIUS;
}
function applyDamage(room, attacker, target, damage, source) {
  if (room.phase !== "active" || target.hp <= 0) return;
  let dealt = damage, blocked = false;
  if (target.blocking && target.shieldOwned && target.shieldEquipped &&
      target.weapon !== "bow" && target.stamina > 0 && targetFacesAttacker(target, attacker)) {
    blocked = true;
    dealt = Math.max(2, Math.round(damage * 0.15));
    target.stamina = Math.max(0, target.stamina - 25);
  }
  target.hp = Math.max(0, target.hp - dealt);
  io.to(room.code).emit("combatEvent", {
    type: blocked ? "block" : "hit",
    attacker: attacker.id, target: target.id, damage: dealt, rawDamage: damage,
    source, x: target.x, z: target.z
  });
  if (target.hp <= 0) {
    target.blocking = false;
    checkRoundOutcome(room);
  }
}

function performAttack(room, p, noAmmoSocket = null) {
  if (!room || room.phase !== "active" || !p || p.hp <= 0 || p.blocking) return false;
  const w = WEAPONS[p.weapon] || WEAPONS.sword;
  const now = Date.now();
  if (now - p.attackAt < w.cooldown || p.stamina < w.stamina) return false;
  p.attackAt = now; p.stamina -= w.stamina;
  if (w.type === "bow") {
    if (p.ammo <= 0) {
      if (noAmmoSocket) noAmmoSocket.emit("noAmmo");
      return false;
    }
    p.ammo--;
    const id = String(room.arrowSeq++);
    const cp = Math.cos(p.pitch);
    room.arrows.set(id, {
      id, owner: p.id, x: p.x, y: (p.y || 0) + 1.55, z: p.z,
      dx: -Math.sin(p.yaw) * cp, dy: Math.sin(p.pitch),
      dz: -Math.cos(p.yaw) * cp, yaw: p.yaw, pitch: p.pitch, life: 2.25
    });
    io.to(room.code).emit("combatEvent", { type: "shot", attacker: p.id, source: "bow" });
  } else {
    io.to(room.code).emit("combatEvent", { type: "swing", attacker: p.id, source: p.weapon });
    const target = pickMeleeTarget(room, p, w);
    if (target) applyDamage(room, p, target, w.damage, p.weapon);
  }
  return true;
}

function angleToTarget(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z;
  return Math.atan2(-dx, -dz);
}
function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function updateBot(room, bot, dt, now) {
  const target = targetOf(room, bot);
  if (!target || target.hp <= 0 || bot.hp <= 0) return;
  const cfg = BOT_LEVELS[bot.botDifficulty] || BOT_LEVELS.easy;
  const brain = bot.bot;
  const dx = target.x - bot.x, dz = target.z - bot.z;
  const dist = Math.hypot(dx, dz) || 0.001;

  if (now >= brain.nextThink) {
    const base = angleToTarget(bot, target);
    brain.desiredYaw = base + (Math.random() * 2 - 1) * cfg.aimError;
    brain.nextThink = now + cfg.think;
    if (Math.random() < 0.3) brain.strafe *= -1;
  }

  const yawDiff = normalizeAngle(brain.desiredYaw - bot.yaw);
  bot.yaw += clamp(yawDiff, -2.8 * dt, 2.8 * dt);
  bot.pitch = 0;

  // Guard windows: medium/hard occasionally raise shield before the next exchange.
  if (bot.shieldOwned && bot.shieldEquipped) {
    if (now >= brain.nextGuard) {
      if (Math.random() < cfg.blockChance && dist < 4.4) {
        brain.guardUntil = now + (bot.botDifficulty === "hard" ? 430 : 280);
      }
      brain.nextGuard = now + (bot.botDifficulty === "hard" ? 620 : 1000);
    }
    bot.blocking = now < brain.guardUntil && bot.stamina > 12;
  } else {
    bot.blocking = false;
  }

  const w = WEAPONS[bot.weapon] || WEAPONS.sword;
  const preferred = Math.max(1.6, (w.reach || 3.0) * 0.72);
  let forward = 0, strafe = 0;

  if (!bot.blocking) {
    if (dist > preferred + 0.35) forward = 1;
    else if (dist < Math.max(1.15, preferred - 0.75)) forward = -0.45;
    if (bot.botDifficulty !== "easy" && dist < 6.0) strafe = 0.35 * brain.strafe;
  }

  const f = forwardFromYaw(bot.yaw);
  const rx = Math.cos(bot.yaw), rz = -Math.sin(bot.yaw);
  let mx = f.x * forward + rx * strafe, mz = f.z * forward + rz * strafe;
  const ml = Math.hypot(mx, mz);
  if (ml > 0) { mx /= ml; mz /= ml; }

  if (ml > 0) {
    let next = resolveMapCollision(room, bot.x + mx * cfg.speed * dt, bot.z + mz * cfg.speed * dt);
    next = resolvePlayerCollision(room, bot, next.x, next.z);
    bot.x = next.x; bot.z = next.z;
  }

  const facingError = Math.abs(normalizeAngle(angleToTarget(bot, target) - bot.yaw));
  const inRange = dist <= (w.reach || 3.3) + 0.15;
  if (!bot.blocking && inRange && facingError < (bot.botDifficulty === "easy" ? 0.30 : 0.18)) {
    if (!brain.attackReadyAt) brain.attackReadyAt = now + cfg.attackDelay;
    if (now >= brain.attackReadyAt) {
      if (performAttack(room, bot)) {
        brain.attackReadyAt = now + w.cooldown + cfg.attackDelay + (bot.botDifficulty === "easy" ? 280 : 70);
      }
    }
  } else {
    brain.attackReadyAt = Math.max(brain.attackReadyAt || 0, now + cfg.attackDelay);
  }
}


function removeFromPublicQueue(socketId) {
  for (let i = publicQueue.length - 1; i >= 0; i--) {
    if (publicQueue[i].id === socketId) publicQueue.splice(i, 1);
  }
}

function takeWaitingPlayer(excludeId) {
  while (publicQueue.length) {
    const entry = publicQueue.shift();
    if (!entry || entry.id === excludeId) continue;
    const s = io.sockets.sockets.get(entry.id);
    if (s && s.connected && !s.data.room) return { socket: s, name: entry.name };
  }
  return null;
}

function createPublicMatch(waiting, newcomer, newcomerName) {
  let c = roomCode();
  while (rooms.has(c)) c = roomCode();

  const room = newRoom(c, waiting.socket.id, "public", null, "1v1");
  rooms.set(c, room);

  const p1 = createPlayer(waiting.socket.id, waiting.name, room, 0);
  const p2 = createPlayer(newcomer.id, newcomerName, room, 1);
  room.players.set(waiting.socket.id, p1);
  room.players.set(newcomer.id, p2);

  waiting.socket.join(c);
  newcomer.join(c);
  waiting.socket.data.room = c;
  newcomer.data.room = c;

  waiting.socket.emit("matchmakingStatus", { status: "matched" });
  newcomer.emit("matchmakingStatus", { status: "matched" });
  waiting.socket.emit("joined", { code: c, id: waiting.socket.id, mode: "public" });
  newcomer.emit("joined", { code: c, id: newcomer.id, mode: "public" });
  emitRoom(room);
}

io.on("connection", socket => {

  socket.on("joinPublicQueue", ({ name } = {}) => {
    if (socket.data.room) return;
    removeFromPublicQueue(socket.id);

    const cleanName = sanitizeName(name);
    const waiting = takeWaitingPlayer(socket.id);

    if (waiting) {
      createPublicMatch(waiting, socket, cleanName);
      return;
    }

    publicQueue.push({ id: socket.id, name: cleanName });
    socket.emit("matchmakingStatus", { status: "waiting", position: publicQueue.length });
  });

  socket.on("cancelPublicQueue", () => {
    removeFromPublicQueue(socket.id);
    socket.emit("matchmakingStatus", { status: "cancelled" });
  });

  socket.on("createRoom", ({ name, format } = {}) => {
    const privateFormat = ["1v1", "1v1v1", "2v2"].includes(format) ? format : "1v1";
    let c = roomCode(); while (rooms.has(c)) c = roomCode();
    const room = newRoom(c, socket.id, "private", null, privateFormat);
    rooms.set(c, room);
    const p = createPlayer(socket.id, name, room, 0);
    room.players.set(socket.id, p);
    socket.join(c); socket.data.room = c;
    socket.emit("joined", { code: c, id: socket.id, mode: "private" });
    emitRoom(room);
  });

  socket.on("createBotRoom", ({ name, difficulty } = {}) => {
    const level = BOT_LEVELS[difficulty] ? difficulty : "easy";
    let c = roomCode(); while (rooms.has(c)) c = roomCode();
    const room = newRoom(c, socket.id, "bot", level, "1v1");
    rooms.set(c, room);
    const p = createPlayer(socket.id, name, room, 0);
    const bot = createBot(room, level, 1);
    room.players.set(socket.id, p);
    room.players.set(bot.id, bot);
    socket.join(c); socket.data.room = c;
    socket.emit("joined", { code: c, id: socket.id, mode: "bot" });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ code: raw, name } = {}) => {
    const c = String(raw || "").trim().toUpperCase();
    const room = rooms.get(c);
    if (!room) return socket.emit("joinError", "Stanza inesistente.");
    if (room.mode !== "private") return socket.emit("joinError", "Questa stanza non accetta ingressi tramite codice.");
    if (room.players.size >= formatCapacity(room)) return socket.emit("joinError", "La stanza è piena.");
    if (room.phase !== "lobby") return socket.emit("joinError", "Il duello è già iniziato.");
    const p = createPlayer(socket.id, name, room, room.players.size);
    room.players.set(socket.id, p);
    socket.join(c); socket.data.room = c;
    socket.emit("joined", { code: c, id: socket.id, mode: "private" });
    emitRoom(room);
  });

  socket.on("setMap", mapId => {
    const room = getRoom(socket);
    if (!room || room.phase !== "lobby" || room.hostId !== socket.id || !MAPS[mapId]) return;
    room.map = mapId;
    room.players.forEach(p => { p.ready = p.isBot; });
    [...room.players.values()].forEach((p, i) => {
      const s = spawnForIndex(room, i);
      p.x = s.x; p.y = 0; p.z = s.z; p.yaw = s.yaw; p.pitch = 0;
    });
    emitRoom(room);
  });

  socket.on("setSkin", skin => {
    const room = getRoom(socket); if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !SKINS.has(skin)) return;
    p.skin = skin;
    emitRoom(room);
  });

  socket.on("setReady", ({ ready } = {}) => {
    const room = getRoom(socket);
    if (!room || room.phase !== "lobby") return;
    const p = room.players.get(socket.id);
    if (!p || p.isBot) return;

    p.ready = !!ready;
    emitRoom(room);

    if (
      room.players.size === formatCapacity(room) &&
      [...room.players.values()].every(x => x.ready)
    ) {
      beginCountdown(room);
    }
  });

  // Compatibilità: se rimane aperto un vecchio client, continua a funzionare.
  socket.on("ready", () => {
    const room = getRoom(socket);
    if (!room || room.phase !== "lobby") return;
    const p = room.players.get(socket.id);
    if (!p || p.isBot) return;
    p.ready = !p.ready;
    emitRoom(room);
    if (
      room.players.size === formatCapacity(room) &&
      [...room.players.values()].every(x => x.ready)
    ) {
      beginCountdown(room);
    }
  });

  socket.on("purchase", item => {
    const room = getRoom(socket);
    if (!room || room.phase !== "lobby") return;
    const p = room.players.get(socket.id); if (!p) return;

    if (item === "arrows") {
      if (!p.owned.bow || p.coins < PRICES.arrows) return;
      p.coins -= PRICES.arrows; p.ammo += 12; emitRoom(room); return;
    }
    if (item === "shield") {
      if (p.shieldOwned || p.coins < PRICES.shield) return;
      p.coins -= PRICES.shield; p.shieldOwned = true;
      p.shieldEquipped = p.weapon !== "bow"; emitRoom(room); return;
    }
    if (!WEAPONS[item] || item === "sword" || p.owned[item] || p.coins < PRICES[item]) return;
    p.coins -= PRICES[item];
    p.owned[item] = true;
    p.weapon = item;
    if (item === "bow") { p.ammo += 8; p.shieldEquipped = false; }
    emitRoom(room);
  });

  socket.on("selectWeapon", w => {
    const room = getRoom(socket); if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !WEAPONS[w] || !p.owned[w]) return;
    p.weapon = w;
    if (w === "bow") p.shieldEquipped = false;
    emitRoom(room);
  });

  socket.on("toggleShield", () => {
    const room = getRoom(socket); if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.shieldOwned || p.weapon === "bow") return;
    p.shieldEquipped = !p.shieldEquipped;
    if (!p.shieldEquipped) p.blocking = false;
    emitRoom(room);
  });

  socket.on("pose", data => {
    const room = getRoom(socket); if (!room) return;
    const p = room.players.get(socket.id); if (!p || p.isBot || p.hp <= 0) return;
    const now = Date.now();
    const dt = Math.max(0.016, Math.min(0.25, (now - p.lastMoveAt) / 1000));
    p.lastMoveAt = now;

    let nx = Number(data?.x), nz = Number(data?.z);
    if (!Number.isFinite(nx) || !Number.isFinite(nz)) return;
    const d = Math.hypot(nx - p.x, nz - p.z);
    const max = 8.2 * dt + 0.42;
    if (d > max && d > 0) {
      nx = p.x + (nx - p.x) / d * max;
      nz = p.z + (nz - p.z) / d * max;
    }

    let resolved = resolveMapCollision(room, nx, nz);
    resolved = resolvePlayerCollision(room, p, resolved.x, resolved.z);
    p.x = resolved.x; p.z = resolved.z;
    const ny = Number(data?.y);
    if (Number.isFinite(ny)) p.y = clamp(ny, 0, 2.35);
    p.yaw = Number.isFinite(data.yaw) ? data.yaw : p.yaw;
    p.pitch = clamp(Number.isFinite(data.pitch) ? data.pitch : p.pitch, -1.2, 1.2);
    const canBlock = p.shieldOwned && p.shieldEquipped && p.weapon !== "bow";
    p.blocking = !!data.blocking && canBlock && p.stamina > 0 && room.phase === "active";
  });

  socket.on("attack", () => {
    const room = getRoom(socket); if (!room) return;
    const p = room.players.get(socket.id); if (!p) return;
    performAttack(room, p, socket);
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    removeFromPublicQueue(socket.id);
    const room = getRoom(socket); if (!room) return;
    if (room.mode === "bot") {
      rooms.delete(room.code);
      return;
    }
    room.players.delete(socket.id);
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    if (room.hostId === socket.id) room.hostId = [...room.players.keys()][0];
    room.phase = "lobby"; room.message = "L'avversario si è disconnesso.";
    room.players.forEach(p => {
      p.ready = false; p.score = 0; p.hp = 100; p.stamina = 100; p.blocking = false;
    });
    io.to(room.code).emit("opponentLeft");
    emitRoom(room);
  });
});

setInterval(() => {
  const dt = TICK / 1000, now = Date.now();
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (room.phase === "active") {
        if (p.blocking) {
          p.stamina = Math.max(0, p.stamina - 12 * dt);
          if (p.stamina <= 0) p.blocking = false;
        } else {
          p.stamina = Math.min(100, p.stamina + 18 * dt);
        }
      } else {
        p.stamina = Math.min(100, p.stamina + 28 * dt);
      }
    }

    if (room.phase === "active") {
      const bot = [...room.players.values()].find(p => p.isBot);
      if (bot) updateBot(room, bot, dt, now);

      for (const [id, a] of room.arrows) {
        a.x += a.dx * 19 * dt; a.z += a.dz * 19 * dt; a.y += a.dy * 19 * dt;
        a.dy -= 1.75 * dt; a.life -= dt;
        const owner = room.players.get(a.owner);
        if (owner) {
          const targets = enemiesOf(room, owner);
          let hitTarget = null;
          for (const target of targets) {
            const dh = Math.hypot(a.x - target.x, a.z - target.z);
            if (dh < PLAYER_RADIUS + 0.2 && Math.abs(a.y - ((target.y || 0) + 1.15)) < 1.2) {
              hitTarget = target;
              break;
            }
          }
          if (hitTarget) {
            applyDamage(room, owner, hitTarget, WEAPONS.bow.damage, "bow");
            room.arrows.delete(id); continue;
          }
        }
        if (a.life <= 0 || a.y < 0) room.arrows.delete(id);
      }
    }
    emitRoom(room);
  }
}, TICK);

server.listen(PORT, () => console.log(`Pixel Knight Online v4: http://localhost:${PORT}`));
