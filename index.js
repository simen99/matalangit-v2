/**
 * SangMata++ – Advanced Identity Watcher for Telegram Groups
 * by you + ChatGPT
 *
 * Env:
 *  BOT_TOKEN=123:ABC
 *  DB_PATH=./data.db (optional)
 *
 * Run:
 *  npm i telegraf better-sqlite3 string-similarity jimp node-fetch@2
 *  node index.js
 */

const { Telegraf } = require("telegraf");
const Database = require("better-sqlite3");
const stringSimilarity = require("string-similarity");
const Jimp = require("jimp");
const fetch = require("node-fetch"); // for file download (node-fetch v2)

const BOT_TOKEN = process.env.BOT_TOKEN;
const DB_PATH = process.env.DB_PATH || "data.db";
// Optional webhook (commented by default)
// const WEBHOOK_URL = process.env.WEBHOOK_URL;
// const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("❌ Set BOT_TOKEN di environment.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- DB ----------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Tables
db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  chat_id INTEGER PRIMARY KEY,
  enabled INTEGER DEFAULT 1,
  threshold REAL DEFAULT 0.85,
  check_photo INTEGER DEFAULT 1,
  admins_cache TEXT DEFAULT '[]',
  admins_refreshed_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_name TEXT,
  last_username TEXT,
  last_photo_hash TEXT,
  names_json TEXT DEFAULT '[]',
  usernames_json TEXT DEFAULT '[]',
  photos_json TEXT DEFAULT '[]',
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS alerts_rl (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_alert_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
`);

// Helpers: DB wrappers
const getGroup = db.prepare(`SELECT * FROM groups WHERE chat_id=?`);
const upsertGroup = db.prepare(`
INSERT INTO groups(chat_id, enabled, threshold, check_photo, admins_cache, admins_refreshed_at)
VALUES (@chat_id, COALESCE(@enabled,1), COALESCE(@threshold,0.85), COALESCE(@check_photo,1), COALESCE(@admins_cache,'[]'), COALESCE(@admins_refreshed_at,0))
ON CONFLICT(chat_id) DO UPDATE SET
  enabled=excluded.enabled,
  threshold=excluded.threshold,
  check_photo=excluded.check_photo,
  admins_cache=excluded.admins_cache,
  admins_refreshed_at=excluded.admins_refreshed_at
`);

const getUser = db.prepare(`SELECT * FROM users WHERE chat_id=? AND user_id=?`);
const upsertUser = db.prepare(`
INSERT INTO users(chat_id, user_id, first_seen, last_seen, last_name, last_username, last_photo_hash, names_json, usernames_json, photos_json)
VALUES (@chat_id, @user_id, @first_seen, @last_seen, @last_name, @last_username, @last_photo_hash, @names_json, @usernames_json, @photos_json)
ON CONFLICT(chat_id, user_id) DO UPDATE SET
  last_seen=excluded.last_seen,
  last_name=excluded.last_name,
  last_username=excluded.last_username,
  last_photo_hash=excluded.last_photo_hash,
  names_json=excluded.names_json,
  usernames_json=excluded.usernames_json,
  photos_json=excluded.photos_json
`);

const getRL = db.prepare(`SELECT * FROM alerts_rl WHERE chat_id=? AND user_id=?`);
const setRL = db.prepare(`
INSERT INTO alerts_rl(chat_id, user_id, last_alert_at)
VALUES (?, ?, ?)
ON CONFLICT(chat_id, user_id) DO UPDATE SET last_alert_at=excluded.last_alert_at
`);

// ---------- Utils ----------
const now = () => Math.floor(Date.now() / 1000);

function normName(s) {
  if (!s) return "";
  // buang emoji/simbol sederhana
  return s
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[^a-z0-9@._\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function combineScore(a, b) {
  // Jaro-Winkler-like via string-similarity (uses Sorensen-Dice) – we treat as base
  const base = stringSimilarity.compareTwoStrings(a, b); // 0..1
  // Bonus kecil jika ada token unik yang match
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  const inter = [...setA].filter((x) => setB.has(x)).length;
  const bonus = Math.min(0.1, inter * 0.02); // max +0.1
  return Math.min(1, base + bonus);
}

async function getUserProfileFirstPhotoHash(ctx, userId) {
  try {
    const photos = await ctx.telegram.getUserProfilePhotos(userId, 0, 1);
    if (!photos || !photos.photos || photos.photos.length === 0) return null;
    const fileId = photos.photos[0][0].file_id; // smallest size OK for pHash
    const file = await ctx.telegram.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const buf = await res.buffer();
    const img = await Jimp.read(buf);
    const phash = img.hash(); // Jimp pHash
    return phash;
  } catch (e) {
    return null;
  }
}

function phashDistance(a, b) {
  if (!a || !b) return 64; // max distance fallback
  // Hamming distance of hex-based phash (Jimp uses base16)
  const binA = BigInt("0x" + a);
  const binB = BigInt("0x" + b);
  let x = binA ^ binB;
  let dist = 0;
  while (x) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist; // 0..64
}

function rlAllow(chat_id, user_id, seconds = 20) {
  const row = getRL.get(chat_id, user_id);
  const t = now();
  if (!row || t - row.last_alert_at >= seconds) {
    setRL.run(chat_id, user_id, t);
    return true;
  }
  return false;
}

function ensureGroup(chat) {
  let g = getGroup.get(chat.id);
  if (!g) {
    upsertGroup.run({
      chat_id: chat.id,
      enabled: 1,
      threshold: 0.85,
      check_photo: 1,
      admins_cache: "[]",
      admins_refreshed_at: 0
    });
    g = getGroup.get(chat.id);
  }
  return g;
}

async function refreshAdmins(ctx, chatId, force = false) {
  let g = getGroup.get(chatId);
  if (!g) {
    upsertGroup.run({ chat_id: chatId });
    g = getGroup.get(chatId);
  }
  const t = now();
  if (!force && t - g.admins_refreshed_at < 3600) return JSON.parse(g.admins_cache);

  const admins = await ctx.telegram.getChatAdministrators(chatId);
  const cache = admins
    .map((a) => ({
      id: a.user.id,
      name: normName(a.user.first_name + " " + (a.user.last_name || "")),
      username: (a.user.username || "").toLowerCase(),
    }))
    .filter((x) => x.id);

  upsertGroup.run({
    chat_id: chatId,
    admins_cache: JSON.stringify(cache),
    admins_refreshed_at: now(),
  });
  return cache;
}

function isAdminLike(adminsCache, targetName, targetUsername, threshold) {
  const n = normName(targetName || "");
  const u = (targetUsername || "").toLowerCase();

  // Exact username match → red flag
  if (u && adminsCache.some((a) => a.username && a.username === u)) {
    return { hit: true, reason: "username-exact", score: 1 };
  }

  // Name similarity
  let best = 0;
  for (const a of adminsCache) {
    if (a.name) {
      const s = combineScore(a.name, n);
      if (s > best) best = s;
      if (s >= threshold) return { hit: true, reason: "name-similar", score: s };
    }
  }
  return { hit: false, reason: "none", score: best };
}

// ---------- Core trackers ----------
async function trackIdentity(ctx, user, chat) {
  const chat_id = chat.id;
  const user_id = user.id;
  const g = ensureGroup(chat);

  // Pull existing
  let row = getUser.get(chat_id, user_id);
  const t = now();

  // Fresh values
  const displayName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  const username = user.username || null;

  // Optionally compute photo hash
  let currentPhotoHash = null;
  if (g.check_photo) {
    currentPhotoHash = await getUserProfileFirstPhotoHash(ctx, user_id);
  }

  if (!row) {
    const names = displayName ? [displayName] : [];
    const usernames = username ? [username] : [];
    const photos = currentPhotoHash ? [currentPhotoHash] : [];

    upsertUser.run({
      chat_id,
      user_id,
      first_seen: t,
      last_seen: t,
      last_name: displayName || null,
      last_username: username,
      last_photo_hash: currentPhotoHash,
      names_json: JSON.stringify(names),
      usernames_json: JSON.stringify(usernames),
      photos_json: JSON.stringify(photos),
    });
    row = getUser.get(chat_id, user_id);
    return { changes: [], row, photoHash: currentPhotoHash };
  }

  let changes = [];
  let names = JSON.parse(row.names_json || "[]");
  let usernames = JSON.parse(row.usernames_json || "[]");
  let photos = JSON.parse(row.photos_json || "[]");

  if (displayName && displayName !== row.last_name) {
    changes.push({ type: "name", from: row.last_name, to: displayName });
    if (!names.includes(displayName)) names.push(displayName);
  }
  if (username !== row.last_username) {
    changes.push({ type: "username", from: row.last_username, to: username });
    if (username && !usernames.includes(username)) usernames.push(username);
  }
  if (g.check_photo && currentPhotoHash && currentPhotoHash !== row.last_photo_hash) {
    // if last_photo_hash exists, measure distance
    const dist = row.last_photo_hash ? phashDistance(currentPhotoHash, row.last_photo_hash) : null;
    changes.push({ type: "photo", from: row.last_photo_hash, to: currentPhotoHash, dist });
    if (!photos.includes(currentPhotoHash)) photos.push(currentPhotoHash);
  }

  if (changes.length > 0) {
    upsertUser.run({
      chat_id,
      user_id,
      first_seen: row.first_seen,
      last_seen: t,
      last_name: displayName || row.last_name,
      last_username: username || row.last_username,
      last_photo_hash: currentPhotoHash || row.last_photo_hash,
      names_json: JSON.stringify(names),
      usernames_json: JSON.stringify(usernames),
      photos_json: JSON.stringify(photos),
    });
    row = getUser.get(chat_id, user_id);
  } else {
    // just bump last_seen
    upsertUser.run({
      chat_id,
      user_id,
      first_seen: row.first_seen,
      last_seen: t,
      last_name: row.last_name,
      last_username: row.last_username,
      last_photo_hash: row.last_photo_hash,
      names_json: row.names_json,
      usernames_json: row.usernames_json,
      photos_json: row.photos_json,
    });
  }

  return { changes, row, photoHash: currentPhotoHash };
}

// ---------- Alerts ----------
async function maybeAlert(ctx, chat, user, changes) {
  const g = ensureGroup(chat);
  if (!g.enabled) return;

  const allow = rlAllow(chat.id, user.id, 15);
  if (!allow) return;

  const adminsCache = await refreshAdmins(ctx, chat.id);
  const threshold = g.threshold || 0.85;
  const displayName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  const username = user.username || null;

  const sim = isAdminLike(adminsCache, displayName, username, threshold);
  const parts = [];
  for (const c of changes) {
    if (c.type === "name") {
      parts.push(`📝 Nama: <code>${c.from || "-"}</code> → <b>${c.to}</b>`);
    } else if (c.type === "username") {
      parts.push(`🔗 Username: <code>${c.from || "-"}</code> → <b>@${c.to || "-"}</b>`);
    } else if (c.type === "photo") {
      const d = c.dist == null ? "n/a" : `${c.dist}`;
      parts.push(`🖼️ Foto profil berubah (pHash Δ=${d})`);
    }
  }

  if (parts.length === 0) return;

  let badge = "";
  if (sim.hit) {
    badge =
      sim.reason === "username-exact"
        ? "🚨 <b>Penyamaran (username sama dengan admin)!</b>"
        : `⚠️ <b>Mirip admin</b> (skor ~${sim.score.toFixed(2)})`;
  }

  const text =
    `👤 <b>${displayName || "(tanpa nama)"}</b> <code>${user.id}</code>\n` +
    (username ? `@${username}\n` : "") +
    parts.join("\n") +
    (badge ? `\n\n${badge}` : "");

  await ctx.telegram.sendMessage(chat.id, text, { parse_mode: "HTML" });
}

// ---------- Commands ----------
bot.command("start", async (ctx) => {
  if (ctx.chat?.type === "private") {
    return ctx.reply(
      "Halo! Tambahkan saya ke grup dan jadikan admin agar saya bisa memantau perubahan nama/username/foto. Gunakan /help untuk perintah."
    );
  }
  ensureGroup(ctx.chat);
  await refreshAdmins(ctx, ctx.chat.id, true);
  return ctx.reply("Siap! Saya akan memantau perubahan identitas di grup ini. Lihat /help untuk perintah.");
});

bot.command("help", (ctx) => {
  ctx.reply(
    [
      "Perintah admin:",
      "• /settings – lihat konfigurasi grup",
      "• /toggle – nyalakan/matikan alert",
      "• /threshold 0.85 – set ambang kemiripan (0.70–0.98)",
      "• /history @user (atau balas) – riwayat nama/username/foto",
      "• /whois <id|@user> – profil singkat & perubahan terakhir",
      "• /refresh_admins – muat ulang daftar admin",
    ].join("\n")
  );
});

bot.command("settings", async (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private") return;
  const g = ensureGroup(ctx.chat);
  ctx.reply(
    [
      `Settings untuk <b>${ctx.chat.title}</b>:`,
      `• enabled: <b>${g.enabled ? "ON" : "OFF"}</b>`,
      `• threshold: <b>${(g.threshold || 0.85).toFixed(2)}</b>`,
      `• check_photo: <b>${g.check_photo ? "ON" : "OFF"}</b>`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
});

bot.command("toggle", async (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private") return;
  const g = ensureGroup(ctx.chat);
  upsertGroup.run({
    chat_id: ctx.chat.id,
    enabled: g.enabled ? 0 : 1,
    threshold: g.threshold,
    check_photo: g.check_photo,
    admins_cache: g.admins_cache,
    admins_refreshed_at: g.admins_refreshed_at,
  });
  const gg = getGroup.get(ctx.chat.id);
  ctx.reply(`Alert: ${gg.enabled ? "ON" : "OFF"}`);
});

bot.command("threshold", (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private") return;
  const arg = (ctx.message.text || "").split(/\s+/)[1];
  const val = parseFloat(arg);
  if (isNaN(val) || val < 0.7 || val > 0.98) {
    return ctx.reply("Gunakan nilai antara 0.70–0.98. Contoh: /threshold 0.85");
  }
  const g = ensureGroup(ctx.chat);
  upsertGroup.run({
    chat_id: ctx.chat.id,
    enabled: g.enabled,
    threshold: val,
    check_photo: g.check_photo,
    admins_cache: g.admins_cache,
    admins_refreshed_at: g.admins_refreshed_at,
  });
  ctx.reply(`Threshold di-set ke ${val.toFixed(2)}`);
});

bot.command("refresh_admins", async (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private") return;
  await refreshAdmins(ctx, ctx.chat.id, true);
  ctx.reply("Daftar admin diperbarui.");
});

function extractTarget(ctx) {
  // balasan > target = replied-from
  if (ctx.message?.reply_to_message?.from) return ctx.message.reply_to_message.from;
  // @username di argumen
  const parts = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  return { username: parts.startsWith("@") ? parts.slice(1) : undefined, id: /^\d+$/.test(parts) ? Number(parts) : undefined };
}

bot.command("history", async (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private") return;
  const target = extractTarget(ctx);
  let userId = target.id;

  if (!userId && target.username) {
    // try resolve username (best effort)
    try {
      const u = await ctx.telegram.getChatMember(ctx.chat.id, `@${target.username}`);
      userId = u?.user?.id;
    } catch (_) {}
  }
  if (!userId) return ctx.reply("Balas pesan target atau gunakan: /history @username atau /history <user_id>");

  const row = getUser.get(ctx.chat.id, userId);
  if (!row) return ctx.reply("Belum ada riwayat untuk user ini.");

  const names = JSON.parse(row.names_json || "[]");
  const usernames = JSON.parse(row.usernames_json || "[]");
  const photos = JSON.parse(row.photos_json || "[]");

  const lines = [];
  lines.push(`👤 <b>${row.last_name || "-"}</b> <code>${userId}</code> ${row.last_username ? "(@" + row.last_username + ")" : ""}`);
  lines.push(`• First seen: ${new Date(row.first_seen * 1000).toLocaleString()}`);
  lines.push(`• Last seen: ${new Date(row.last_seen * 1000).toLocaleString()}`);
  if (names.length) lines.push(`• Names (${names.length}): ${names.map((n) => `<code>${n}</code>`).join(", ")}`);
  if (usernames.length) lines.push(`• Usernames (${usernames.length}): ${usernames.map((u) => `<code>@${u}</code>`).join(", ")}`);
  if (photos.length) lines.push(`• Photos (${photos.length}) pHash: ${photos.map((p) => `<code>${p.slice(0, 10)}…</code>`).join(", ")}`);

  ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

bot.command("whois", async (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private") return;
  const target = extractTarget(ctx);
  let userId = target.id;

  if (!userId && target.username) {
    try {
      const u = await ctx.telegram.getChatMember(ctx.chat.id, `@${target.username}`);
      userId = u?.user?.id;
    } catch (_) {}
  }
  if (!userId) return ctx.reply("Gunakan: /whois @username atau /whois <user_id> atau balas pesan target.");

  const row = getUser.get(ctx.chat.id, userId);
  if (!row) return ctx.reply("Belum ada data user ini.");

  const changes = [];
  changes.push(`Nama terakhir: <b>${row.last_name || "-"}</b>`);
  changes.push(`Username: ${row.last_username ? "@" + row.last_username : "-"}`);
  changes.push(`Foto pHash: ${row.last_photo_hash ? row.last_photo_hash.slice(0, 16) + "…" : "-"}`);
  ctx.reply(
    `👤 <code>${userId}</code>\n${changes.join("\n")}`,
    { parse_mode: "HTML" }
  );
});

// ---------- Event hooks ----------
// On any message: update seen & check changes
bot.on("message", async (ctx) => {
  if (!ctx.chat || !["group", "supergroup"].includes(ctx.chat.type)) return;
  try {
    const { changes } = await trackIdentity(ctx, ctx.from, ctx.chat);
    if (changes.length) await maybeAlert(ctx, ctx.chat, ctx.from, changes);
  } catch (e) {
    // swallow
  }
});

// Member status updates (join/leave/promote/demote/name updates sometimes show here)
bot.on("chat_member", async (ctx) => {
  if (!ctx.chat || !["group", "supergroup"].includes(ctx.chat.type)) return;
  const member = ctx.update.chat_member.new_chat_member?.user;
  if (!member) return;
  try {
    const { changes } = await trackIdentity(ctx, member, ctx.chat);
    if (changes.length) await maybeAlert(ctx, ctx.chat, member, changes);
  } catch (_) {}
});

// ---------- Launch ----------
// Long polling (default)
bot.launch().then(() => {
  console.log("✅ SangMata++ bot running (polling).");
});

/*
// Webhook mode (optional)
// const express = require("express");
// const app = express();
// bot.telegram.setWebhook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
// app.use(bot.webhookCallback(`/bot${BOT_TOKEN}`));
// app.get("/", (_, res) => res.send("OK"));
// app.listen(PORT, () => console.log("✅ Webhook server on", PORT));
*/

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
