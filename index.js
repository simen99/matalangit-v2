/**
 * SangMata++ (Informative 24/7) — Indonesia Edition (Optimized)
 * - Perintah hanya untuk admin grup atau owner (ENV)
 * - Output HTML rapi & konsisten
 * - Cache admin, PRAGMA/INDEX DB, helper utilities
 *
 * ENV (tambahan):
 *   OWNER_IDS=123,456              (opsional; list user_id pemilik, comma-separated)
 *   OWNER_USERNAMES=siemens,foo    (opsional; tanpa '@')
 *
 * ENV lama tetap:
 *   BOT_TOKEN=123:ABC              (wajib)
 *   DB_PATH=/data/data.db          (disarankan Railway; default ./data.db)
 *   CHECK_PHOTO=1                  (0/1) default 1
 *   SIM_THRESHOLD=0.85             (0.70..0.98) default 0.85
 *   ALERT_COOLDOWN_SECONDS=15      default 15
 *   ADMIN_PHOTO_DIST=12            (0..64) default 12
 */

const { Telegraf } = require("telegraf");
const Database = require("better-sqlite3");
const stringSimilarity = require("string-similarity");
const Jimp = require("jimp");
const fetch = require("node-fetch"); // v2

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN env.");
  process.exit(1);
}
const DB_PATH = process.env.DB_PATH || "./data.db";
const DEFAULT_CHECK_PHOTO = Number(process.env.CHECK_PHOTO ?? 1) ? 1 : 0;
const DEFAULT_THRESHOLD = Math.min(
  0.98,
  Math.max(0.7, Number(process.env.SIM_THRESHOLD ?? 0.85))
);
const DEFAULT_ALERT_COOLDOWN = Math.max(5, Number(process.env.ALERT_COOLDOWN_SECONDS ?? 15));
const ADMIN_PHOTO_DIST = Math.max(0, Math.min(64, Number(process.env.ADMIN_PHOTO_DIST ?? 12)));

// Owner (opsional)
const OWNER_IDS = (process.env.OWNER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s))
  .filter(n => Number.isInteger(n));

const OWNER_USERNAMES = (process.env.OWNER_USERNAMES || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const bot = new Telegraf(BOT_TOKEN);

// ---------- DB ----------
const db = new Database(DB_PATH, { timeout: 5000 });
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("temp_store = MEMORY");
db.pragma("cache_size = -10000"); // ~10MB cache

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  chat_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  threshold REAL NOT NULL DEFAULT 0.85,
  check_photo INTEGER NOT NULL DEFAULT 1,
  admins_cache TEXT NOT NULL DEFAULT '[]',
  admins_refreshed_at INTEGER NOT NULL DEFAULT 0,
  alert_cooldown INTEGER NOT NULL DEFAULT ${DEFAULT_ALERT_COOLDOWN}
);

CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_name TEXT,
  last_username TEXT,
  last_photo_hash TEXT,
  names_json TEXT NOT NULL DEFAULT '[]',
  usernames_json TEXT NOT NULL DEFAULT '[]',
  photos_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS alerts_rl (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_alert_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS username_map (
  chat_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (chat_id, username)
);

-- Index untuk performa lookup
CREATE INDEX IF NOT EXISTS idx_users_chat_lastseen ON users(chat_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_rl_chat ON alerts_rl(chat_id);
CREATE INDEX IF NOT EXISTS idx_uname_map_seen ON username_map(chat_id, last_seen DESC);
`);

const getGroup = db.prepare(`SELECT * FROM groups WHERE chat_id=?`);
const upsertGroup = db.prepare(`
INSERT INTO groups(chat_id, enabled, threshold, check_photo, admins_cache, admins_refreshed_at, alert_cooldown)
VALUES (@chat_id, @enabled, @threshold, @check_photo, @admins_cache, @admins_refreshed_at, @alert_cooldown)
ON CONFLICT(chat_id) DO UPDATE SET
  enabled=excluded.enabled,
  threshold=excluded.threshold,
  check_photo=excluded.check_photo,
  admins_cache=excluded.admins_cache,
  admins_refreshed_at=excluded.admins_refreshed_at,
  alert_cooldown=excluded.alert_cooldown
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
const getUMap = db.prepare(`SELECT * FROM username_map WHERE chat_id=? AND username=?`);
const upsertUMap = db.prepare(`
INSERT INTO username_map(chat_id, username, user_id, last_seen)
VALUES (?, ?, ?, ?)
ON CONFLICT(chat_id, username) DO UPDATE SET user_id=excluded.user_id, last_seen=excluded.last_seen
`);

// ---------- Utils ----------
const now = () => Math.floor(Date.now() / 1000);
const TZ = "Asia/Jakarta"; // WIB
const dt = (ts = Date.now()) =>
  new Date(ts).toLocaleString("id-ID", { timeZone: TZ, hour12: false });

const mono = s => `<code>${(s ?? "").toString().replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;

const normName = (s) => {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "") // buang emoji
    .replace(/[^a-z0-9@._\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const similarity = (a, b) => {
  const base = stringSimilarity.compareTwoStrings(a, b);
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  const inter = [...A].filter(x => B.has(x)).length;
  const bonus = Math.min(0.1, inter * 0.02);
  return Math.min(1, base + bonus);
};

const rlAllow = (chat_id, user_id, seconds) => {
  const row = getRL.get(chat_id, user_id);
  const t = now();
  if (!row || t - row.last_alert_at >= seconds) {
    setRL.run(chat_id, user_id, t);
    return true;
  }
  return false;
};

function ensureGroup(chat) {
  let g = getGroup.get(chat.id);
  if (!g) {
    upsertGroup.run({
      chat_id: chat.id,
      enabled: 1,
      threshold: DEFAULT_THRESHOLD,
      check_photo: DEFAULT_CHECK_PHOTO,
      admins_cache: "[]",
      admins_refreshed_at: 0,
      alert_cooldown: DEFAULT_ALERT_COOLDOWN,
    });
    g = getGroup.get(chat.id);
    console.log("🆕 Daftarkan grup:", chat.id, chat.title || "");
  }
  return g;
}

async function getFirstPhotoHashByUserId(ctx, userId) {
  try {
    const photos = await ctx.telegram.getUserProfilePhotos(userId, 0, 1);
    if (!photos?.photos?.length) return null;
    const fileId = photos.photos[0][0].file_id;
    const file = await ctx.telegram.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const buf = await res.buffer();
    const img = await Jimp.read(buf);
    return img.hash(2);
  } catch {
    return null;
  }
}

const phashDistance = (a, b) => {
  if (!a || !b) return 64;
  const A = BigInt("0x" + a);
  const B = BigInt("0x" + b);
  let x = A ^ B, d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
};

// ---------- Admin Cache & Gate ----------
const ADMIN_CACHE = new Map(); // chatId -> { at, ids:Set, usernames:Set, raw:[] }
const ADMIN_TTL = 60; // detik

async function loadAdmins(ctx, chatId) {
  const g = ensureGroup({ id: chatId });
  const t = now();
  const cached = ADMIN_CACHE.get(chatId);
  if (cached && t - cached.at < ADMIN_TTL) return cached;

  const admins = await ctx.telegram.getChatAdministrators(chatId);
  const ids = new Set(admins.map(a => a.user.id));
  const usernames = new Set(admins.map(a => (a.user.username || "").toLowerCase()).filter(Boolean));

  // sinkronkan juga cache admin untuk fitur kemiripan nama/foto
  const out = [];
  for (const a of admins) {
    const u = a.user;
    const entry = {
      id: u.id,
      name: normName(`${u.first_name || ""} ${u.last_name || ""}`),
      username: (u.username || "").toLowerCase(),
      photo_hash: null,
    };
    if (g.check_photo) {
      try { entry.photo_hash = await getFirstPhotoHashByUserId(ctx, u.id); } catch {}
    }
    out.push(entry);
  }
  upsertGroup.run({
    chat_id: chatId,
    enabled: g.enabled,
    threshold: g.threshold,
    check_photo: g.check_photo,
    admins_cache: JSON.stringify(out),
    admins_refreshed_at: now(),
    alert_cooldown: g.alert_cooldown ?? DEFAULT_ALERT_COOLDOWN,
  });

  const payload = { at: t, ids, usernames, raw: out };
  ADMIN_CACHE.set(chatId, payload);
  return payload;
}

function isOwner(user) {
  if (!user) return false;
  if (OWNER_IDS.includes(user.id)) return true;
  if (user.username && OWNER_USERNAMES.includes(user.username.toLowerCase())) return true;
  return false;
}

// Middleware: set ctx.state.isAdminOrOwner
bot.use(async (ctx, next) => {
  try {
    const u = ctx.from;
    const c = ctx.chat;
    ctx.state.isAdminOrOwner = false;

    if (!u) return next();
    if (isOwner(u)) {
      ctx.state.isAdminOrOwner = true;
      return next();
    }

    if (c && ["group", "supergroup"].includes(c.type)) {
      const ac = await loadAdmins(ctx, c.id);
      if (ac.ids.has(u.id)) ctx.state.isAdminOrOwner = true;
    }
  } catch (e) {
    console.error("admin gate middleware error:", e?.message);
  }
  return next();
});

// Helper untuk gate perintah admin/owner
function adminOnly(handler) {
  return async (ctx) => {
    if (!ctx.state?.isAdminOrOwner) {
      return replyErr(ctx, "Perintah ini khusus <b>admin grup</b> atau <b>owner bot</b>.");
    }
    return handler(ctx);
  };
}

// ---------- UI Helpers ----------
function header(title, chat) {
  const where = chat?.title ? ` • ${chat.title}` : "";
  return `┏━━ ${title}${where}\n┗━━ 🕒 ${dt()}`;
}
const replyInfo = (ctx, lines) =>
  ctx.reply([`ℹ️ <b>Info</b>`, ...[].concat(lines)].join("\n"), { parse_mode: "HTML" });
const replyWarn = (ctx, lines) =>
  ctx.reply([`⚠️ <b>Peringatan</b>`, ...[].concat(lines)].join("\n"), { parse_mode: "HTML" });
const replyErr = (ctx, text) =>
  ctx.reply(`❌ ${text}`, { parse_mode: "HTML" });

// ---------- Admin similarity helpers ----------
function adminSimilarityByNameOrUsername(adminsCache, displayName, username, threshold) {
  const n = normName(displayName || "");
  const u = (username || "").toLowerCase();
  if (u && adminsCache.some(a => a.username && a.username === u)) {
    return { hit: true, by: "username", reason: "username-identik", score: 1 };
  }
  let best = 0;
  for (const a of adminsCache) {
    if (!a.name) continue;
    const s = similarity(a.name, n);
    if (s > best) best = s;
    if (s >= threshold) return { hit: true, by: "name", reason: "nama-mirip", score: s };
  }
  return { hit: false, by: "none", reason: "tidak-mirip", score: best };
}
function adminSimilarityByPhoto(adminsCache, photoHash) {
  if (!photoHash) return { hit: false, dist: null, admin: null };
  let best = { hit: false, dist: 64, admin: null };
  for (const a of adminsCache) {
    if (!a.photo_hash) continue;
    const d = phashDistance(photoHash, a.photo_hash);
    if (d < best.dist) best = { hit: d <= ADMIN_PHOTO_DIST, dist: d, admin: a };
  }
  return best;
}

// ---------- Track & Alert ----------
async function trackIdentity(ctx, user, chat) {
  const chat_id = chat.id, user_id = user.id;
  const g = ensureGroup(chat);
  let row = getUser.get(chat_id, user_id);
  const t = now();

  const displayName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  const username = user.username || null;
  const photoNeeded = !!g.check_photo;
  const currentPhotoHash = photoNeeded ? (await getFirstPhotoHashByUserId(ctx, user_id)) : null;

  // Deteksi reuse username
  if (username) {
    const uname = username.toLowerCase();
    const umap = getUMap.get(chat_id, uname);
    if (!umap || umap.user_id !== user_id) {
      upsertUMap.run(chat_id, uname, user_id, t);
      if (umap && umap.user_id !== user_id) {
        await ctx.telegram.sendMessage(chat_id,
          [
            `🔁 <b>Username dipakai akun lain</b>`,
            `• Username: <b>@${uname}</b>`,
            `• Sebelumnya milik: ${mono(umap.user_id)}`,
            `• Sekarang dipakai oleh: ${mono(user_id)}`,
            `🕒 ${dt()}`
          ].join("\n"),
          { parse_mode: "HTML" }
        );
      }
    } else {
      upsertUMap.run(chat_id, uname, user_id, t);
    }
  }

  if (!row) {
    upsertUser.run({
      chat_id, user_id,
      first_seen: t, last_seen: t,
      last_name: displayName || null,
      last_username: username,
      last_photo_hash: currentPhotoHash,
      names_json: JSON.stringify(displayName ? [displayName] : []),
      usernames_json: JSON.stringify(username ? [username] : []),
      photos_json: JSON.stringify(currentPhotoHash ? [currentPhotoHash] : []),
    });
    return { changes: [], row: getUser.get(chat_id, user_id) };
  }

  const changes = [];
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
  if (photoNeeded && currentPhotoHash && currentPhotoHash !== row.last_photo_hash) {
    const dist = row.last_photo_hash ? phashDistance(currentPhotoHash, row.last_photo_hash) : null;
    changes.push({ type: "photo", from: row.last_photo_hash, to: currentPhotoHash, dist });
    if (!photos.includes(currentPhotoHash)) photos.push(currentPhotoHash);
  }

  upsertUser.run({
    chat_id, user_id,
    first_seen: row.first_seen, last_seen: t,
    last_name: displayName || row.last_name,
    last_username: username || row.last_username,
    last_photo_hash: currentPhotoHash || row.last_photo_hash,
    names_json: JSON.stringify(names),
    usernames_json: JSON.stringify(usernames),
    photos_json: JSON.stringify(photos),
  });

  return { changes, row: getUser.get(chat_id, user_id) };
}

async function maybeAlert(ctx, chat, user, changes) {
  const g = ensureGroup(chat);
  if (!g.enabled || changes.length === 0) return;
  const cooldown = g.alert_cooldown ?? DEFAULT_ALERT_COOLDOWN;
  if (!rlAllow(chat.id, user.id, cooldown)) return;

  // pakai cache admin terbaru utk similarity
  const ac = await loadAdmins(ctx, chat.id);
  const admins = ac.raw;
  const threshold = g.threshold || DEFAULT_THRESHOLD;

  const displayName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  const uname = user.username || null;
  const simNameUser = adminSimilarityByNameOrUsername(admins, displayName, uname, threshold);

  const lines = [];
  lines.push(`👤 <b>${displayName || "(tanpa nama)"}</b> ${mono(user.id)}${uname ? " @" + uname : ""}`);
  for (const c of changes) {
    if (c.type === "name")     lines.push(`📝 Nama: ${mono(c.from || "-")} → <b>${(c.to || "-").replace(/</g,"&lt;")}</b>`);
    if (c.type === "username") lines.push(`🔗 Username: ${mono(c.from ? "@"+c.from : "-")} → <b>${c.to ? "@"+c.to : "-"}</b>`);
    if (c.type === "photo")    lines.push(`🖼️ Foto profil berubah${c.dist!=null?` (Δ=${c.dist})`:""}`);
  }

  if (simNameUser.hit) {
    lines.push("");
    lines.push(simNameUser.by === "username"
      ? "🚨 <b>Username identik dengan admin!</b>"
      : `⚠️ <b>Nama mirip admin</b> (skor ≈ <b>${simNameUser.score.toFixed(2)}</b>)`
    );
  }

  const photoChange = changes.find(c => c.type === "photo");
  if (photoChange && photoChange.to) {
    const simPhoto = adminSimilarityByPhoto(admins, photoChange.to);
    if (simPhoto.hit) {
      lines.push(`🛑 <b>Foto mirip admin</b> (Δ=${simPhoto.dist})`);
    }
  }

  lines.push("");
  lines.push(`🕒 ${dt()}`);
  lines.push(`ℹ️ Balas pesan user lalu kirim ${mono("/riwayat")} untuk histori.`);

  await ctx.telegram.sendMessage(chat.id, lines.join("\n"), { parse_mode: "HTML" });
}

// ---------- Helper target ----------
function extractTarget(ctx) {
  if (ctx.message?.reply_to_message?.from) return ctx.message.reply_to_message.from;
  const q = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  return { username: q.startsWith("@") ? q.slice(1) : undefined, id: /^\d+$/.test(q) ? Number(q) : undefined };
}

// ---------- Commands (admin/owner only) ----------
const cmdMulai = adminOnly(async (ctx) => {
  if (!ctx.chat) return;
  if (["group","supergroup"].includes(ctx.chat.type)) {
    ensureGroup(ctx.chat);
    await loadAdmins(ctx, ctx.chat.id); // sekaligus refresh cache
    return ctx.reply(
      [
        header("SangMata++ aktif", ctx.chat),
        "Bot memantau perubahan <b>nama/username/foto</b> di grup ini.",
        `Gunakan ${mono("/bantuan")} untuk daftar perintah.`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  } else {
    return replyInfo(ctx, [
      "Tambah saya ke grup dan jadikan admin agar bisa memantau.",
      `Lihat bantuan: ${mono("/bantuan")}`
    ]);
  }
});

const cmdBantuan = adminOnly((ctx) =>
  ctx.reply(
    [
      header("Bantuan", ctx.chat),
      "Perintah admin:",
      `• ${mono("/pengaturan")} – lihat konfigurasi grup`,
      `• ${mono("/aktif")} – nyalakan/matikan alert`,
      `• ${mono("/ambang 0.85")} – set ambang mirip nama admin (0.70–0.98)`,
      `• ${mono("/foto on|off")} – aktif/nonaktif cek foto profil`,
      `• ${mono("/cooldown <detik>")} – atur jeda anti-spam alert per user (min 5)`,
      `• ${mono("/riwayat @user")} (atau reply) – riwayat nama/username/foto`,
      `• ${mono("/siapa @user|<id>")} – profil singkat versi bot`,
      `• ${mono("/muat_admin")} – muat ulang daftar admin (+ pHash bila foto ON)`,
    ].join("\n"),
    { parse_mode: "HTML" }
  )
);

const cmdPengaturan = adminOnly((ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const g = ensureGroup(ctx.chat);
  ctx.reply(
    [
      header("Pengaturan Grup", ctx.chat),
      `• status: <b>${g.enabled ? "AKTIF" : "NONAKTIF"}</b>`,
      `• ambang_nama_admin: <b>${(g.threshold || DEFAULT_THRESHOLD).toFixed(2)}</b>`,
      `• cek_foto: <b>${g.check_photo ? "ON" : "OFF"}</b>`,
      `• cooldown: <b>${g.alert_cooldown ?? DEFAULT_ALERT_COOLDOWN}s</b>`,
      `• admin_photo_dist: <b>${ADMIN_PHOTO_DIST}</b> (Δ≤${ADMIN_PHOTO_DIST} mirip)`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
});

const cmdAktif = adminOnly((ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const g = ensureGroup(ctx.chat);
  upsertGroup.run({
    chat_id: ctx.chat.id,
    enabled: g.enabled ? 0 : 1,
    threshold: g.threshold,
    check_photo: g.check_photo,
    admins_cache: g.admins_cache,
    admins_refreshed_at: g.admins_refreshed_at,
    alert_cooldown: g.alert_cooldown ?? DEFAULT_ALERT_COOLDOWN,
  });
  const gg = getGroup.get(ctx.chat.id);
  ctx.reply(
    [
      header("Toggle Alert", ctx.chat),
      `Alert: <b>${gg.enabled ? "AKTIF" : "NONAKTIF"}</b>`
    ].join("\n"),
    { parse_mode: "HTML" }
  );
});

const cmdAmbang = adminOnly((ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const arg = (ctx.message.text || "").split(/\s+/)[1];
  const val = parseFloat(arg);
  if (isNaN(val) || val < 0.7 || val > 0.98) {
    return replyErr(ctx, `Gunakan nilai antara 0.70–0.98. Contoh: ${mono("/ambang 0.85")}`);
  }
  const g = ensureGroup(ctx.chat);
  upsertGroup.run({
    chat_id: ctx.chat.id,
    enabled: g.enabled,
    threshold: val,
    check_photo: g.check_photo,
    admins_cache: g.admins_cache,
    admins_refreshed_at: g.admins_refreshed_at,
    alert_cooldown: g.alert_cooldown ?? DEFAULT_ALERT_COOLDOWN,
  });
  return replyInfo(ctx, [`Ambang mirip nama admin di‑set ke <b>${val.toFixed(2)}</b>.`]);
});

const cmdMuatAdmin = adminOnly(async (ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  await loadAdmins(ctx, ctx.chat.id); // force refresh via TTL=0 (gunakan trick hapus cache)
  ADMIN_CACHE.delete(ctx.chat.id);
  const ac = await loadAdmins(ctx, ctx.chat.id);
  ctx.reply(
    [
      header("Muat Admin", ctx.chat),
      `Admin terdeteksi: <b>${ac.ids.size}</b>`,
      `• pHash admin disimpan bila cek_foto ON`
    ].join("\n"),
    { parse_mode: "HTML" }
  );
});

const cmdRiwayat = adminOnly(async (ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const target = extractTarget(ctx);
  let userId = target.id;
  if (!userId && target.username) {
    try { const m = await ctx.telegram.getChatMember(ctx.chat.id, `@${target.username}`); userId = m?.user?.id; } catch {}
  }
  if (!userId) return replyErr(ctx, `Balas pesan user atau gunakan: ${mono("/riwayat @username")} | ${mono("/riwayat <user_id>")}`);
  const row = getUser.get(ctx.chat.id, userId);
  if (!row) return replyInfo(ctx, ["Belum ada riwayat untuk user ini."]);
  const names = JSON.parse(row.names_json || "[]");
  const usernames = JSON.parse(row.usernames_json || "[]");
  const photos = JSON.parse(row.photos_json || "[]");
  const lines = [];
  lines.push(header("Riwayat Identitas", ctx.chat));
  lines.push(`👤 ${mono(userId)} — <b>${(row.last_name || "-").replace(/</g,"&lt;")}</b> ${row.last_username ? "(@" + row.last_username + ")" : ""}`);
  lines.push(`• Pertama terlihat: ${dt(row.first_seen * 1000)}`);
  lines.push(`• Terakhir terlihat: ${dt(row.last_seen  * 1000)}`);
  if (names.length)     lines.push(`• Nama (${names.length}): ${names.map(n => mono(n)).join(", ")}`);
  if (usernames.length) lines.push(`• Username (${usernames.length}): ${usernames.map(u => mono("@"+u)).join(", ")}`);
  if (photos.length)    lines.push(`• Foto (${photos.length}) pHash: ${photos.map(p => mono(p.slice(0,10)+"…")).join(", ")}`);
  ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

const cmdSiapa = adminOnly(async (ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const target = extractTarget(ctx);
  let userId = target.id;
  if (!userId && target.username) {
    try { const m = await ctx.telegram.getChatMember(ctx.chat.id, `@${target.username}`); userId = m?.user?.id; } catch {}
  }
  if (!userId) return replyErr(ctx, `Gunakan: ${mono("/siapa @username")} | ${mono("/siapa <user_id>")} atau balas pesan user.`);
  const row = getUser.get(ctx.chat.id, userId);
  if (!row) return replyInfo(ctx, ["Belum ada data user ini."]);
  const lines = [];
  lines.push(header("Profil Singkat", ctx.chat));
  lines.push(`👤 ${mono(userId)}`);
  lines.push(`• Nama terakhir : <b>${(row.last_name || "-").replace(/</g,"&lt;")}</b>`);
  lines.push(`• Username      : ${row.last_username ? "@"+row.last_username : "-"}`);
  lines.push(`• Foto pHash    : ${row.last_photo_hash ? mono(row.last_photo_hash.slice(0,16)+"…") : "-"}`);
  ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

const cmdFoto = adminOnly((ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const arg = (ctx.message.text || "").split(/\s+/)[1]?.toLowerCase();
  if (!["on", "off"].includes(arg || "")) {
    return replyErr(ctx, `Gunakan: ${mono("/foto on")}  atau  ${mono("/foto off")}`);
  }
  const g = ensureGroup(ctx.chat);
  const val = arg === "on" ? 1 : 0;
  upsertGroup.run({
    chat_id: ctx.chat.id,
    enabled: g.enabled,
    threshold: g.threshold,
    check_photo: val,
    admins_cache: g.admins_cache,
    admins_refreshed_at: g.admins_refreshed_at,
    alert_cooldown: g.alert_cooldown ?? DEFAULT_ALERT_COOLDOWN,
  });
  ctx.reply(
    [
      header("Cek Foto Profil", ctx.chat),
      `Status: <b>${val ? "ON" : "OFF"}</b>`,
      `Tips: jalankan ${mono("/muat_admin")} untuk segarkan pHash foto admin.`
    ].join("\n"),
    { parse_mode: "HTML" }
  );
});

const cmdCooldown = adminOnly((ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const arg = (ctx.message.text || "").split(/\s+/)[1];
  const sec = Math.max(5, parseInt(arg, 10) || 0);
  if (!sec) return replyErr(ctx, `Gunakan: ${mono("/cooldown <detik>")}  (min 5)`);
  const g = ensureGroup(ctx.chat);
  upsertGroup.run({
    chat_id: ctx.chat.id,
    enabled: g.enabled,
    threshold: g.threshold,
    check_photo: g.check_photo,
    admins_cache: g.admins_cache,
    admins_refreshed_at: g.admins_refreshed_at,
    alert_cooldown: sec,
  });
  replyInfo(ctx, [`Cooldown alert per user di‑set ke <b>${sec}</b> detik.`]);
});

// Map perintah (semua di‑gate admin/owner)
bot.command(["mulai","start"], cmdMulai);
bot.command(["bantuan","help"], cmdBantuan);
bot.command(["pengaturan","settings"], cmdPengaturan);
bot.command(["aktif","toggle"], cmdAktif);
bot.command(["ambang","threshold"], cmdAmbang);
bot.command(["muat_admin","refresh_admins"], cmdMuatAdmin);
bot.command(["riwayat","history"], cmdRiwayat);
bot.command(["siapa","whois"], cmdSiapa);
bot.command(["foto"], cmdFoto);
bot.command(["cooldown"], cmdCooldown);

// ---------- Event hooks (24/7) ----------
bot.on("message", async (ctx, next) => {
  try {
    if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return next?.();
    const { changes } = await trackIdentity(ctx, ctx.from, ctx.chat);
    if (changes.length) await maybeAlert(ctx, ctx.chat, ctx.from, changes);
  } catch (e) {
    console.error("message handler error:", e?.stack || e?.message);
  }
  return next?.();
});
bot.on("chat_member", async (ctx) => {
  try {
    if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
    const member = ctx.update.chat_member?.new_chat_member?.user;
    if (!member) return;
    const { changes } = await trackIdentity(ctx, member, ctx.chat);
    if (changes.length) await maybeAlert(ctx, ctx.chat, member, changes);
  } catch (e) {
    console.error("chat_member handler error:", e?.stack || e?.message);
  }
});

// ---------- Launch ----------
console.log(
  "Menjalankan bot…",
  `(DB: ${DB_PATH} | ambang_nama_admin: ${DEFAULT_THRESHOLD} | cek_foto: ${DEFAULT_CHECK_PHOTO} | cooldown_default: ${DEFAULT_ALERT_COOLDOWN}s | admin_photo_dist: ${ADMIN_PHOTO_DIST})`
);
bot.launch()
  .then(() => console.log("✅ SangMata++ (Indonesia) berjalan (polling). 24/7 siap."))
  .catch(err => console.error("Launch error:", err?.stack || err?.message));

// Graceful stop (Railway/Heroku)
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
