const { Telegraf } = require("telegraf");
const Database = require("better-sqlite3");
const stringSimilarity = require("string-similarity");
const Jimp = require("jimp");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN env.");
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || "./data.db";
const DEFAULT_THRESHOLD = 0.85;
const DEFAULT_COOLDOWN = 0; // set 10 kalau mau jeda alert default
const ADMIN_PHOTO_DIST = 12;

const bot = new Telegraf(BOT_TOKEN);

// ---------- DB ----------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  chat_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  threshold REAL NOT NULL DEFAULT 0.85,
  check_photo INTEGER NOT NULL DEFAULT 1,
  alert_cooldown INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_name TEXT,
  last_username TEXT,
  last_photo_hash TEXT,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS alerts_rl (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_alert_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
`);

const getGroup = db.prepare(`SELECT * FROM groups WHERE chat_id=?`);
const upsertGroup = db.prepare(`
INSERT INTO groups(chat_id, enabled, threshold, check_photo, alert_cooldown)
VALUES (@chat_id, @enabled, @threshold, @check_photo, @alert_cooldown)
ON CONFLICT(chat_id) DO UPDATE SET
  enabled=excluded.enabled,
  threshold=excluded.threshold,
  check_photo=excluded.check_photo,
  alert_cooldown=excluded.alert_cooldown
`);
const getUser = db.prepare(`SELECT * FROM users WHERE chat_id=? AND user_id=?`);
const upsertUser = db.prepare(`
INSERT INTO users(chat_id, user_id, first_seen, last_seen, last_name, last_username, last_photo_hash)
VALUES (@chat_id, @user_id, @first_seen, @last_seen, @last_name, @last_username, @last_photo_hash)
ON CONFLICT(chat_id, user_id) DO UPDATE SET
  last_seen=excluded.last_seen,
  last_name=excluded.last_name,
  last_username=excluded.last_username,
  last_photo_hash=excluded.last_photo_hash
`);
const getRL = db.prepare(`SELECT * FROM alerts_rl WHERE chat_id=? AND user_id=?`);
const setRL = db.prepare(`
INSERT INTO alerts_rl(chat_id, user_id, last_alert_at)
VALUES (?, ?, ?)
ON CONFLICT(chat_id, user_id) DO UPDATE SET last_alert_at=excluded.last_alert_at
`);

// ---------- Utils ----------
const now = () => Math.floor(Date.now() / 1000);
const ts = () => new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour12: false });

function normName(s) {
  if (!s) return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function similarityPct(a, b) {
  const score = stringSimilarity.compareTwoStrings(normName(a), normName(b));
  return Math.round(score * 100);
}

async function isAdmin(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return ["creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

// --- pHash utils ---
async function getPhotoHash(ctx, userId) {
  try {
    const photos = await ctx.telegram.getUserProfilePhotos(userId, 0, 1);
    if (!photos?.photos?.length) return null;
    const fileId = photos.photos[0][0].file_id;
    const file = await ctx.telegram.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url, { timeout: 8000 }).catch(() => null);
    if (!res) return null;
    const buf = await res.buffer();
    const img = await Jimp.read(buf);
    // kecilkan dulu biar hashing cepat (tanpa ubah logika hasil secara signifikan)
    img.resize(64, 64);
    return img.hash(2);
  } catch {
    return null;
  }
}
function phashDistance(a, b) {
  if (!a || !b) return 64;
  const A = BigInt("0x" + a);
  const B = BigInt("0x" + b);
  let x = A ^ B, d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}
function phashSimilarityPct(a, b) {
  const d = phashDistance(a, b);
  return Math.max(0, Math.round(100 - (d / 64 * 100)));
}

function rlAllow(chat_id, user_id, sec) {
  const row = getRL.get(chat_id, user_id);
  const t = now();
  if (!row || t - row.last_alert_at >= sec) {
    setRL.run(chat_id, user_id, t);
    return true;
  }
  return true; // tetap no rate limit sesuai logika lama
}

function ensureGroup(chat) {
  let g = getGroup.get(chat.id);
  if (!g) {
    upsertGroup.run({
      chat_id: chat.id,
      enabled: 0,
      threshold: DEFAULT_THRESHOLD,
      check_photo: 1,
      alert_cooldown: DEFAULT_COOLDOWN
    });
    g = getGroup.get(chat.id);
  }
  return g;
}

// ---------- Admin Cache (baru) ----------
/**
 * Struktur:
 * ADMIN_CACHE: Map<chatId, { ts, list: Array<{id, name, username, pHash?: string|null}> }>
 */
const ADMIN_CACHE = new Map();
const ADMIN_CACHE_TTL = 300; // 5 menit

async function getAdminsCached(ctx, chatId) {
  const t = now();
  const c = ADMIN_CACHE.get(chatId);
  if (c && (t - c.ts) < ADMIN_CACHE_TTL) return c.list;

  const raw = await ctx.telegram.getChatAdministrators(chatId);
  const list = raw.map(a => ({
    id: a.user.id,
    name: `${a.user.first_name || ""} ${a.user.last_name || ""}`.trim(),
    username: a.user.username || "",
    pHash: undefined // diisi on-demand
  }));
  ADMIN_CACHE.set(chatId, { ts: t, list });
  return list;
}

async function ensureAdminPHash(ctx, chatId, adminObj) {
  // kalau sudah pernah dihitung (null atau string), jangan hitung lagi
  if (adminObj.pHash !== undefined) return adminObj.pHash;
  const h = await getPhotoHash(ctx, adminObj.id);
  adminObj.pHash = h || null;
  // simpan balik ke cache
  const c = ADMIN_CACHE.get(chatId);
  if (c) {
    const idx = c.list.findIndex(x => x.id === adminObj.id);
    if (idx >= 0) c.list[idx] = adminObj;
  }
  return adminObj.pHash;
}

// ---------- Tracking ----------
async function trackAndAlert(ctx, user, chat) {
  const g = ensureGroup(chat);
  if (!g.enabled) return;

  const row = getUser.get(chat.id, user.id);
  const displayName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  const username = user.username || "-";
  const t = now();

  // hitung foto user hanya sekali di sini (opsional aktif)
  const photoHash = g.check_photo ? await getPhotoHash(ctx, user.id) : null;

  let changes = { name: "tidak berubah", username: "tidak berubah", photo: "tidak berubah" };
  let alerts = [];

  if (!row) {
    upsertUser.run({
      chat_id: chat.id,
      user_id: user.id,
      first_seen: t,
      last_seen: t,
      last_name: displayName,
      last_username: username !== "-" ? username : null,
      last_photo_hash: photoHash
    });
    return;
  }

  // detect changes
  if (displayName && displayName !== row.last_name) {
    changes.name = `${row.last_name || "-"} → ${displayName}`;
  }
  if (username !== (row.last_username || "-")) {
    changes.username = `${row.last_username || "-"} → ${username}`;
  }
  if (photoHash && photoHash !== row.last_photo_hash) {
    changes.photo = "diperbarui";
  } else {
    changes.photo = "tidak berubah";
  }

  // update user row
  upsertUser.run({
    chat_id: chat.id,
    user_id: user.id,
    first_seen: row.first_seen,
    last_seen: t,
    last_name: displayName,
    last_username: username !== "-" ? username : row.last_username,
    last_photo_hash: photoHash || row.last_photo_hash
  });

  // only alert if ada perubahan
  const hasChange =
    changes.name !== "tidak berubah" ||
    changes.username !== "tidak berubah" ||
    changes.photo === "diperbarui";

  if (!hasChange) return;
  if (!rlAllow(chat.id, user.id, g.alert_cooldown)) return;

  // ---------- Cek kemiripan admin (versi cepat) ----------
  const admins = await getAdminsCached(ctx, chat.id);

  // 1) Cek nama & username (super cepat, tanpa I/O)
  const susAdmins = [];
  for (const a of admins) {
    if (a.id === user.id) continue;

    const simName = similarityPct(displayName, a.name);
    const userMatch = a.username && username !== "-" && a.username.toLowerCase() === username.toLowerCase();

    if (simName >= g.threshold * 100) {
      alerts.push(`• Nama mirip "${a.name}" (${simName}%)`);
      susAdmins.push(a); // kandidat untuk cek foto
    } else if (userMatch) {
      alerts.push(`• Username identik "@${a.username}" (100%)`);
      susAdmins.push(a);
    }
  }

  // 2) Cek foto (BERAT) hanya untuk kandidat yang sudah mencurigakan
  if (g.check_photo && photoHash && susAdmins.length) {
    // hitung pHash admin yang belum punya pHash di cache (paralel)
    await Promise.all(
      susAdmins.map(async (a) => {
        const ap = await ensureAdminPHash(ctx, chat.id, a);
        if (!ap) return;
        const simPhoto = phashSimilarityPct(photoHash, ap);
        if (simPhoto >= 100 - (ADMIN_PHOTO_DIST / 64 * 100)) {
          alerts.push(`• Foto mirip "${a.name || "Admin"}" (${simPhoto}%)`);
        }
      })
    );
  }

  const text = [
    "━━━━━━━━━━━━━━━━━━",
    `👤 ${displayName || "-"} | ${user.id} | ${username !== "-" ? "@" + username : "-"}`,
    "",
    `📝 Nama: ${changes.name}`,
    `🔗 Username: ${changes.username}`,
    `🖼️ Foto profil: ${changes.photo}`,
    "",
    alerts.length ? `⚠️ Mirip Admin:\n   ${alerts.join("\n   ")}` : "",
    "",
    `🕒 ${ts()} WIB`,
    "━━━━━━━━━━━━━━━━━━"
  ].join("\n");

  await ctx.telegram.sendMessage(chat.id, text.trim(), { parse_mode: "HTML" });
}

// ---------- Commands ----------
bot.command("aktif", async (ctx) => {
  if (!ctx.chat) return;
  if (!(await isAdmin(ctx))) {
    return ctx.reply("❌ Hanya admin grup yang bisa menjalankan perintah ini.");
  }

  const g = ensureGroup(ctx.chat);
  upsertGroup.run({
    chat_id: ctx.chat.id,
    enabled: 1,
    threshold: g.threshold,
    check_photo: g.check_photo,
    alert_cooldown: g.alert_cooldown || DEFAULT_COOLDOWN,
  });

  const gg = getGroup.get(ctx.chat.id);
  return ctx.reply(
    [
      "━━━━━━━━━━━━━━━━━━",
      `✅ Bot Aktif di grup: ${ctx.chat.title}`,
      "",
      "📊 Konfigurasi:",
      `• Ambang mirip admin : ${gg.threshold}`,
      `• Cek foto profil    : ${gg.check_photo ? "ON" : "OFF"}`,
      `• Cooldown alert      : ${gg.alert_cooldown}s`,
      `• Ambang foto admin   : Δ≤${ADMIN_PHOTO_DIST}`,
      "",
      "ℹ️ Bot memantau perubahan identitas & anti-cloner admin.",
      `🕒 ${ts()} WIB`,
      "━━━━━━━━━━━━━━━━━━",
    ].join("\n"),
    { parse_mode: "HTML" }
  );
});

bot.command("nonaktif", async (ctx) => {
  if (!ctx.chat) return;
  if (!(await isAdmin(ctx))) {
    return ctx.reply("❌ Hanya admin grup yang bisa menjalankan perintah ini.");
  }

  const g = ensureGroup(ctx.chat);
  upsertGroup.run({
    chat_id: ctx.chat.id,
    enabled: 0,
    threshold: g.threshold,
    check_photo: g.check_photo,
    alert_cooldown: g.alert_cooldown || DEFAULT_COOLDOWN,
  });

  const gg = getGroup.get(ctx.chat.id);
  return ctx.reply(
    [
      "━━━━━━━━━━━━━━━━━━",
      `⛔ Bot Nonaktif di grup: ${ctx.chat.title}`,
      "",
      "📊 Konfigurasi:",
      `• Ambang mirip admin : ${gg.threshold}`,
      `• Cek foto profil    : ${gg.check_photo ? "ON" : "OFF"}`,
      `• Cooldown alert      : ${gg.alert_cooldown}s`,
      `• Ambang foto admin   : Δ≤${ADMIN_PHOTO_DIST}`,
      "",
      "ℹ️ Bot berhenti memantau identitas.",
      `🕒 ${ts()} WIB`,
      "━━━━━━━━━━━━━━━━━━",
    ].join("\n"),
    { parse_mode: "HTML" }
  );
});

// ---------- Event Hooks ----------
bot.on("message", (ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  trackAndAlert(ctx, ctx.from, ctx.chat);
});
bot.on("edited_message", (ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  trackAndAlert(ctx, ctx.from, ctx.chat);
});
bot.on("chat_member", (ctx) => {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const user = ctx.update.chat_member?.new_chat_member?.user;
  if (user) trackAndAlert(ctx, user, ctx.chat);
});

// ---------- Launch ----------
console.log("🚀 Bot berjalan dengan DB:", DB_PATH);
bot.launch().then(() => console.log("✅ Bot aktif (polling)..."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
