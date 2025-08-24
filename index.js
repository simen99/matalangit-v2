/**
 * SangMata++ (Informative 24/7) — Indonesia Edition
 * - 24/7 polling, logging kuat, alert informatif
 * - Lacak: nama (utama), username, pHash foto (opsional)
 * - Setelan per-grup, peringatan mirip admin (nama/username/foto), anti-spam alert
 *
 * ENV:
 *   BOT_TOKEN=123:ABC                 (wajib)
 *   DB_PATH=/data/data.db             (disarankan di Railway; default ./data.db)
 *   CHECK_PHOTO=1                     (0/1) default 1
 *   SIM_THRESHOLD=0.85                (0.70..0.98) default 0.85 (untuk kemiripan NAMA ke admin)
 *   ALERT_COOLDOWN_SECONDS=15         default 15 (default per-grup, masih bisa diubah via /cooldown)
 *   ADMIN_PHOTO_DIST=12               ambang mirip foto admin (0..64) default 12 (lebih kecil = lebih mirip)
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

const bot = new Telegraf(BOT_TOKEN);

// ---------- DB ----------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  chat_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  threshold REAL NOT NULL DEFAULT 0.85,
  check_photo INTEGER NOT NULL DEFAULT 1,
  admins_cache TEXT NOT NULL DEFAULT '[]',
  admins_refreshed_at INTEGER NOT NULL DEFAULT 0
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
-- Pemetaan username -> user_id terakhir per-grup (untuk deteksi reuse username)
CREATE TABLE IF NOT EXISTS username_map (
  chat_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (chat_id, username)
);
`);

/** migrasi ringan: tambahkan kolom alert_cooldown di groups bila belum ada */
try {
  const cols = db.prepare(`PRAGMA table_info(groups)`).all().map(c => c.name);
  if (!cols.includes("alert_cooldown")) {
    db.exec(`ALTER TABLE groups ADD COLUMN alert_cooldown INTEGER NOT NULL DEFAULT ${DEFAULT_ALERT_COOLDOWN}`);
  }
} catch (e) {
  console.error("migrasi groups.alert_cooldown gagal (abaikan jika sudah ada):", e?.message);
}

// Prepared statements
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

function normName(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "") // buang emoji
    .replace(/[^a-z0-9@._\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function similarity(a, b) {
  const base = stringSimilarity.compareTwoStrings(a, b);
  // bonus token ringan
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  const inter = [...A].filter(x => B.has(x)).length;
  const bonus = Math.min(0.1, inter * 0.02);
  return Math.min(1, base + bonus);
}
function rlAllow(chat_id, user_id, seconds) {
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
    const fileId = photos.photos[0][0].file_id; // ukuran kecil cukup
    const file = await ctx.telegram.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const buf = await res.buffer();
    const img = await Jimp.read(buf);
    return img.hash(); // pHash hex
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

async function refreshAdmins(ctx, chatId, force = false) {
  let g = getGroup.get(chatId);
  if (!g) {
    upsertGroup.run({
      chat_id: chatId,
      enabled: 1,
      threshold: DEFAULT_THRESHOLD,
      check_photo: DEFAULT_CHECK_PHOTO,
      admins_cache: "[]",
      admins_refreshed_at: 0,
      alert_cooldown: DEFAULT_ALERT_COOLDOWN,
    });
    g = getGroup.get(chatId);
  }
  const t = now();
  if (!force && t - g.admins_refreshed_at < 3600) return JSON.parse(g.admins_cache);
  const admins = await ctx.telegram.getChatAdministrators(chatId);

  // Simpan name/username + pHash (jika check_photo ON)
  const out = [];
  for (const a of admins) {
    const u = a.user;
    const entry = {
      id: u.id,
      name: normName(`${u.first_name || ""} ${u.last_name || ""}`),
      username: (u.username || "").toLowerCase(),
      photo_hash: null
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
  return out;
}

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

  // Deteksi reuse username: username yang sama tapi user_id berbeda
  if (username) {
    const umap = getUMap.get(chat_id, username.toLowerCase());
    if (!umap || umap.user_id !== user_id) {
      // simpan pemetaan terbaru
      upsertUMap.run(chat_id, username.toLowerCase(), user_id, t);
      if (umap && umap.user_id !== user_id) {
        // username berpindah ke akun lain
        await ctx.telegram.sendMessage(chat_id,
          [
            `🔁 <b>Username dipakai akun lain</b> di grup ini`,
            `• Username: <b>@${username.toLowerCase()}</b>`,
            `• Sebelumnya milik: <code>${umap.user_id}</code>`,
            `• Sekarang dipakai oleh: <code>${user_id}</code>`,
            `🕒 ${new Date().toLocaleString()}`
          ].join("\n"),
          { parse_mode: "HTML" }
        );
      }
    } else {
      // update last_seen map
      upsertUMap.run(chat_id, username.toLowerCase(), user_id, t);
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

  const admins = await refreshAdmins(ctx, chat.id);
  const threshold = g.threshold || DEFAULT_THRESHOLD;

  const displayName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  const uname = user.username || null;
  const simNameUser = adminSimilarityByNameOrUsername(admins, displayName, uname, threshold);

  // siapkan teks alert
  const lines = [];
  lines.push(`👤 <b>${displayName || "(tanpa nama)"}</b> <code>${user.id}</code>${uname ? " @" + uname : ""}`);
  for (const c of changes) {
    if (c.type === "name")     lines.push(`📝 <b>Nama</b>: <code>${c.from || "-"}</code> → <b>${c.to}</b>`);
    if (c.type === "username") lines.push(`🔗 <b>Username</b>: <code>${c.from ? "@"+c.from : "-"}</code> → <b>${c.to ? "@"+c.to : "-"}</b>`);
    if (c.type === "photo")    lines.push(`🖼️ <b>Foto profil</b> berubah${c.dist!=null?` (Δ=${c.dist})`:""}`);
  }

  // peringatan mirip admin (nama/username)
  if (simNameUser.hit) {
    lines.push("");
    lines.push(simNameUser.by === "username"
      ? "🚨 <b>Peringatan:</b> Username identik dengan admin!"
      : `⚠️ <b>Nama mirip admin</b> (skor ≈ <b>${simNameUser.score.toFixed(2)}</b>)`
    );
  }

  // jika ada perubahan foto: cocokkan foto user dengan foto admin (pHash)
  const photoChange = changes.find(c => c.type === "photo");
  if (photoChange && photoChange.to) {
    const simPhoto = adminSimilarityByPhoto(admins, photoChange.to);
    if (simPhoto.hit) {
      lines.push(`🛑 <b>Foto mirip dengan admin</b> (Δ=${simPhoto.dist})`);
    }
  }

  lines.push("");
  lines.push(`🕒 ${new Date().toLocaleString()}`);
  lines.push("ℹ️ Balas pesan user lalu kirim /riwayat untuk melihat histori nama/username/foto.");

  await ctx.telegram.sendMessage(chat.id, lines.join("\n"), { parse_mode: "HTML" });
}

// ---------- Helper target ----------
function extractTarget(ctx) {
  if (ctx.message?.reply_to_message?.from) return ctx.message.reply_to_message.from;
  const q = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  return { username: q.startsWith("@") ? q.slice(1) : undefined, id: /^\d+$/.test(q) ? Number(q) : undefined };
}

// ---------- Perintah (Indonesia + alias lama) ----------
async function cmdMulai(ctx) {
  if (!ctx.chat) return;
  if (["group", "supergroup"].includes(ctx.chat.type)) {
    ensureGroup(ctx.chat);
    await refreshAdmins(ctx, ctx.chat.id, true);
    return ctx.reply("Siap! Saya aktif memantau perubahan identitas di grup ini.\nGunakan /bantuan untuk daftar perintah.");
  } else {
    return ctx.reply("Halo! Tambahkan saya ke grup dan jadikan admin agar saya bisa memantau perubahan nama/username/foto.\nKetik /bantuan untuk perintah.");
  }
}
function cmdBantuan(ctx) {
  return ctx.reply(
    [
      "Perintah admin (jalankan di grup):",
      "• /pengaturan – lihat konfigurasi grup",
      "• /aktif – nyalakan/matikan alert",
      "• /ambang 0.85 – set ambang mirip nama admin (0.70–0.98)",
      "• /foto on|off – aktif/nonaktif cek foto profil",
      "• /cooldown <detik> – atur jeda anti-spam alert per user",
      "• /riwayat @user (atau balas pesan) – riwayat nama/username/foto",
      "• /siapa @user|<id> – profil singkat menurut data bot",
      "• /muat_admin – muat ulang daftar admin",
    ].join("\n")
  );
}
function cmdPengaturan(ctx) {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const g = ensureGroup(ctx.chat);
  ctx.reply(
    [
      `Pengaturan untuk <b>${ctx.chat.title}</b>:`,
      `• status: <b>${g.enabled ? "AKTIF" : "NONAKTIF"}</b>`,
      `• ambang_nama_admin: <b>${(g.threshold || DEFAULT_THRESHOLD).toFixed(2)}</b>`,
      `• cek_foto: <b>${g.check_photo ? "ON" : "OFF"}</b>`,
      `• cooldown: <b>${g.alert_cooldown ?? DEFAULT_ALERT_COOLDOWN}s</b>`,
      `• admin_photo_dist: <b>${ADMIN_PHOTO_DIST}</b> (Δ≤${ADMIN_PHOTO_DIST} dianggap mirip)`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
}
function cmdAktif(ctx) {
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
  ctx.reply(`Alert: ${gg.enabled ? "AKTIF" : "NONAKTIF"}`);
}
function cmdAmbang(ctx) {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const arg = (ctx.message.text || "").split(/\s+/)[1];
  const val = parseFloat(arg);
  if (isNaN(val) || val < 0.7 || val > 0.98) {
    return ctx.reply("Gunakan nilai antara 0.70–0.98. Contoh: /ambang 0.85");
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
  ctx.reply(`Ambang mirip nama admin di-set ke ${val.toFixed(2)}`);
}
async function cmdMuatAdmin(ctx) {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  await refreshAdmins(ctx, ctx.chat.id, true);
  ctx.reply("Daftar admin diperbarui (termasuk pHash foto bila cek_foto ON).");
}
async function cmdRiwayat(ctx) {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const target = extractTarget(ctx);
  let userId = target.id;
  if (!userId && target.username) {
    try { const m = await ctx.telegram.getChatMember(ctx.chat.id, `@${target.username}`); userId = m?.user?.id; } catch {}
  }
  if (!userId) return ctx.reply("Balas pesan user atau gunakan: /riwayat @username | /riwayat <user_id>");
  const row = getUser.get(ctx.chat.id, userId);
  if (!row) return ctx.reply("Belum ada riwayat untuk user ini.");
  const names = JSON.parse(row.names_json || "[]");
  const usernames = JSON.parse(row.usernames_json || "[]");
  const photos = JSON.parse(row.photos_json || "[]");
  const lines = [];
  lines.push(`👤 <b>${row.last_name || "-"}</b> <code>${userId}</code> ${row.last_username ? "(@" + row.last_username + ")" : ""}`);
  lines.push(`• Pertama terlihat: ${new Date(row.first_seen * 1000).toLocaleString()}`);
  lines.push(`• Terakhir terlihat: ${new Date(row.last_seen  * 1000).toLocaleString()}`);
  if (names.length)     lines.push(`• Nama (${names.length}): ${names.map(n => `<code>${n}</code>`).join(", ")}`);
  if (usernames.length) lines.push(`• Username (${usernames.length}): ${usernames.map(u => `<code>@${u}</code>`).join(", ")}`);
  if (photos.length)    lines.push(`• Foto (${photos.length}) pHash: ${photos.map(p => `<code>${p.slice(0,10)}…</code>`).join(", ")}`);
  ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
async function cmdSiapa(ctx) {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const target = extractTarget(ctx);
  let userId = target.id;
  if (!userId && target.username) {
    try { const m = await ctx.telegram.getChatMember(ctx.chat.id, `@${target.username}`); userId = m?.user?.id; } catch {}
  }
  if (!userId) return ctx.reply("Gunakan: /siapa @username | /siapa <user_id> atau balas pesan user.");
  const row = getUser.get(ctx.chat.id, userId);
  if (!row) return ctx.reply("Belum ada data user ini.");
  const lines = [];
  lines.push(`👤 <code>${userId}</code>`);
  lines.push(`• Nama terakhir : <b>${row.last_name || "-"}</b>`);
  lines.push(`• Username      : ${row.last_username ? "@"+row.last_username : "-"}`);
  lines.push(`• Foto pHash    : ${row.last_photo_hash ? row.last_photo_hash.slice(0,16)+"…" : "-"}`);
  ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
function cmdFoto(ctx) {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const arg = (ctx.message.text || "").split(/\s+/)[1]?.toLowerCase();
  if (!["on", "off"].includes(arg || "")) {
    return ctx.reply("Gunakan: /foto on  atau  /foto off");
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
  ctx.reply(`Cek foto profil: ${val ? "ON" : "OFF"}\n(ingat /muat_admin untuk segarkan pHash foto admin)`);
}
function cmdCooldown(ctx) {
  if (!ctx.chat || !["group","supergroup"].includes(ctx.chat.type)) return;
  const arg = (ctx.message.text || "").split(/\s+/)[1];
  const sec = Math.max(5, parseInt(arg, 10) || 0);
  if (!sec) return ctx.reply("Gunakan: /cooldown <detik>  (min 5)");
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
  ctx.reply(`Cooldown alert per user di-set ke ${sec} detik.`);
}

// Map perintah Indonesia + alias lama (tetap didukung)
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
    console.error("message handler error:", e?.message);
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
    console.error("chat_member handler error:", e?.message);
  }
});

// ---------- Launch ----------
console.log(
  "Menjalankan bot…",
  `(DB: ${DB_PATH} | ambang_nama_admin: ${DEFAULT_THRESHOLD} | cek_foto: ${DEFAULT_CHECK_PHOTO} | cooldown_default: ${DEFAULT_ALERT_COOLDOWN}s | admin_photo_dist: ${ADMIN_PHOTO_DIST})`
);
bot.launch()
  .then(() => console.log("✅ SangMata++ (Indonesia) berjalan (polling). 24/7 siap."))
  .catch(err => console.error("Launch error:", err));

// Graceful stop (Railway)
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
