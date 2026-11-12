// Orbit backend — Express + Turso (libSQL, a free cloud SQLite service)
//
// Data now lives in Turso's cloud database instead of a local disk file, so
// it survives container restarts, redeploys, and free-tier spin-downs.
// You need a free Turso database — see README.md for setup.

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@libsql/client");

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || "development";
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@orbit.local").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "OrbitAdmin2026!";
const ADMIN_NAME = process.env.ADMIN_NAME || "Orbit Owner";
const ACCOUNT_RECOVERY_DAYS = 30;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (!JWT_SECRET) {
  if (NODE_ENV === "production") {
    console.error("FATAL: JWT_SECRET is not set.");
    process.exit(1);
  } else {
    console.warn("WARNING: JWT_SECRET is not set — using an insecure development secret.");
  }
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || "dev-only-insecure-secret-change-me";

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error(
    "FATAL: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be set. " +
      "Create a free database at turso.tech and set these env vars — see README.md."
  );
  process.exit(1);
}

// ---------- Database ----------
const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

async function query(sql, params = []) {
  try {
    const result = await db.execute({ sql, args: params });
    return result.rows;
  } catch (e) {
    console.error("Query error:", sql, e.message);
    return [];
  }
}

async function run(sql, params = []) {
  try {
    await db.execute({ sql, args: params });
    return true;
  } catch (e) {
    console.error("Run error:", sql, e.message);
    return false;
  }
}

async function initDatabase() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      data TEXT NOT NULL DEFAULT '{}'
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      chunks INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS media_chunks (
      media_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (media_id, seq)
    )
  `);
  console.log("Connected to Turso database and verified tables.");
  await ensureAdminAccount();
  await purgeExpiredDeletedAccounts();
}

async function getUserRow(email) {
  const results = await query("SELECT * FROM users WHERE email = ?", [String(email).toLowerCase()]);
  return results[0] || null;
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    email: row.email,
    name: row.name,
    isAdmin: !!row.is_admin,
    createdAt: row.created_at,
  };
}

function freshAppData() {
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const uid = () => Math.random().toString(36).slice(2, 10);
  const weekTasks = {};
  DAYS.forEach((d) => (weekTasks[d] = []));
  return {
    tab: "dashboard",
    drafts: {},
    habits: [
      { id: uid(), name: "Wake up at 6:30", icon: "☀️", color: "#F5A623", done: {}, notes: {}, skipDays: [6] },
      { id: uid(), name: "Drink 2L of water", icon: "💧", color: "#22D3EE", done: {}, notes: {}, skipDays: [] },
      { id: uid(), name: "Read 10 pages", icon: "📖", color: "#7C3AED", done: {}, notes: {}, skipDays: [] },
      { id: uid(), name: "Move / gym", icon: "🏋️", color: "#34D399", done: {}, notes: {}, skipDays: [6] },
      { id: uid(), name: "Meditate", icon: "🧘", color: "#F472B6", done: {}, notes: {}, skipDays: [] },
    ],
    weekTasks,
    goals: [
      { id: uid(), title: "Complete my first project", type: "weekly", progress: 0, deadline: "", category: "Work", priority: "Medium", milestones: [], template: null },
      { id: uid(), title: "Start a fitness routine", type: "monthly", progress: 0, deadline: "", category: "Health", priority: "High", milestones: [{ text: "Exercise 3x this week", done: false }, { text: "Track meals for 5 days", done: false }], template: null },
    ],
    journal: {},
    weeklyJournals: {},
    dailyJournals: {},
    xp: 0,
    focus: { mode: "focus", timeLeft: 25 * 60, running: false, sessions: [], customDurations: {} },
    weeklyHistory: [],
    monthlyHistory: [],
    yearlyHistory: [],
    habitArchive: [],
    goalArchive: [],
    goalTemplates: [],
    theme: "system",
    accent: "#7C3AED",
    compact: false,
    notifyEnabled: false,
    unlockedBadges: [],
    timetable: { preset: null, blocks: [] },
    plannerWeekKey: new Date().toISOString().slice(0, 10),
    language: "en",
    mascot: "🤖",
    linkedAccounts: [],
    font: "Inter",
    reduceMotion: false,
    highContrast: false,
    hiddenNav: [],
    avatarImage: null,
    bgImage: null,
    dismissedNotifs: [],
    events: [],
    refreshDay: 0,
    eventRemindersEnabled: true,
    zoomLevel: null,
  };
}

async function ensureAdminAccount() {
  const existing = await getUserRow(ADMIN_EMAIL);
  if (existing) return;
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  await run(
    "INSERT INTO users (email, name, password_hash, is_admin, created_at, data) VALUES (?, ?, ?, 1, ?, ?)",
    [ADMIN_EMAIL, ADMIN_NAME, hash, new Date().toISOString(), JSON.stringify(freshAppData())]
  );
  console.log(`Seeded admin account: ${ADMIN_EMAIL}`);
}

async function purgeExpiredDeletedAccounts() {
  const rows = await query("SELECT email, deleted_at FROM users WHERE deleted = 1");
  const now = Date.now();
  for (const r of rows) {
    if (!r.deleted_at) continue;
    const days = (now - new Date(r.deleted_at).getTime()) / 86400000;
    if (days > ACCOUNT_RECOVERY_DAYS) {
      await deleteAllMediaFor(r.email);
      await run("DELETE FROM users WHERE email = ?", [r.email]);
    }
  }
}
setInterval(purgeExpiredDeletedAccounts, 6 * 60 * 60 * 1000);

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));

const allowedOrigins = CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((s) => s.trim());
app.use(cors({ origin: allowedOrigins, credentials: false }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

function signToken(email) {
  return jwt.sign({ email }, EFFECTIVE_JWT_SECRET, { expiresIn: "30d" });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    const user = await getUserRow(payload.email);
    if (!user || user.deleted) return res.status(401).json({ error: "Account not found" });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: "Admin access required" });
  next();
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Wrap async route handlers so a thrown/rejected error returns 500 instead of hanging
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- Auth routes ----------
app.post("/api/auth/register", authLimiter, ah(async (req, res) => {
  const { name, password } = req.body || {};
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !isValidEmail(email) || !name || !password) {
    return res.status(400).json({ error: "Name, a valid email, and a password are required" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const existing = await getUserRow(email);
  if (existing && !existing.deleted) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }
  const hash = bcrypt.hashSync(password, 10);
  const createdAt = new Date().toISOString();
  if (existing && existing.deleted) await run("DELETE FROM users WHERE email = ?", [email]);
  await run(
    "INSERT INTO users (email, name, password_hash, is_admin, created_at, data) VALUES (?, ?, ?, 0, ?, ?)",
    [email, String(name).trim(), hash, createdAt, JSON.stringify(freshAppData())]
  );
  const user = await getUserRow(email);
  const token = signToken(email);
  res.status(201).json({ token, user: toPublicUser(user) });
}));

app.post("/api/auth/login", authLimiter, ah(async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const { password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  const user = await getUserRow(email);
  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  let restored = false;
  if (user.deleted) {
    await run("UPDATE users SET deleted = 0, deleted_at = NULL WHERE email = ?", [email]);
    restored = true;
  }
  const token = signToken(email);
  res.json({ token, user: toPublicUser(await getUserRow(email)), restored });
}));

app.post("/api/auth/verify", authLimiter, requireAuth, ah(async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const { password } = req.body || {};
  const user = await getUserRow(email);
  if (!user || user.deleted || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Could not verify that account" });
  }
  res.json({ valid: true, user: toPublicUser(user) });
}));

// ---------- Current-user data routes ----------
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: toPublicUser(req.user), data: JSON.parse(req.user.data || "{}") });
});

app.put("/api/me/data", requireAuth, ah(async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== "object") return res.status(400).json({ error: "Missing data payload" });
  await run("UPDATE users SET data = ? WHERE email = ?", [JSON.stringify(data), req.user.email]);
  res.json({ ok: true });
}));

app.delete("/api/me", requireAuth, ah(async (req, res) => {
  const { data } = req.body || {};
  if (data && typeof data === "object") {
    await run("UPDATE users SET data = ? WHERE email = ?", [JSON.stringify(data), req.user.email]);
  }
  await run("UPDATE users SET deleted = 1, deleted_at = ? WHERE email = ?", [
    new Date().toISOString(),
    req.user.email,
  ]);
  res.json({ ok: true, recoveryDays: ACCOUNT_RECOVERY_DAYS });
}));

// ---------- Feedback ----------
app.post("/api/feedback", requireAuth, ah(async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required" });
  await run("INSERT INTO feedback (name, email, message, created_at) VALUES (?, ?, ?, ?)", [
    req.user.name,
    req.user.email,
    message,
    new Date().toISOString(),
  ]);
  res.status(201).json({ ok: true });
}));

// ---------- Media: voice notes and videos attached to journal entries ----------
// The files live in their own tables (split into small chunks) instead of inside the
// user's JSON data blob, so big recordings never slow down the normal save/load.
const MEDIA_LIMITS = { audio: 10 * 1024 * 1024, video: 25 * 1024 * 1024 };
const MEDIA_USER_QUOTA = 300 * 1024 * 1024;
const MEDIA_CHUNK = 512 * 1024;

async function deleteMediaById(id) {
  await run("DELETE FROM media_chunks WHERE media_id = ?", [id]);
  await run("DELETE FROM media WHERE id = ?", [id]);
}
async function deleteAllMediaFor(email) {
  const rows = await query("SELECT id FROM media WHERE email = ?", [email]);
  for (const r of rows) await deleteMediaById(r.id);
}

app.post("/api/media", requireAuth, express.raw({ type: () => true, limit: "26mb" }), ah(async (req, res) => {
  const kind = String(req.headers["x-media-kind"] || "").toLowerCase();
  const mime = String(req.headers["content-type"] || "").slice(0, 100);
  if (!MEDIA_LIMITS[kind] || !mime.startsWith(kind + "/")) {
    return res.status(400).json({ error: "Only audio and video files can be attached" });
  }
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: "Empty file" });
  if (buf.length > MEDIA_LIMITS[kind]) {
    return res.status(413).json({ error: `That ${kind} is too large (max ${MEDIA_LIMITS[kind] / 1048576} MB)` });
  }
  const used = await query("SELECT COALESCE(SUM(size), 0) AS total FROM media WHERE email = ?", [req.user.email]);
  if (Number(used[0]?.total || 0) + buf.length > MEDIA_USER_QUOTA) {
    return res.status(413).json({ error: "Attachment storage is full — delete some older voice notes or videos first" });
  }
  const id = crypto.randomBytes(12).toString("hex");
  const duration = Math.max(0, Math.min(86400, parseInt(req.headers["x-media-duration"], 10) || 0));
  const chunks = Math.ceil(buf.length / MEDIA_CHUNK);
  try {
    for (let i = 0; i < chunks; i++) {
      await db.execute({
        sql: "INSERT INTO media_chunks (media_id, seq, data) VALUES (?, ?, ?)",
        args: [id, i, buf.subarray(i * MEDIA_CHUNK, (i + 1) * MEDIA_CHUNK)],
      });
    }
    await db.execute({
      sql: "INSERT INTO media (id, email, kind, mime, size, duration, chunks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, req.user.email, kind, mime, buf.length, duration, chunks, new Date().toISOString()],
    });
  } catch (e) {
    console.error("Media upload error:", e.message);
    await run("DELETE FROM media_chunks WHERE media_id = ?", [id]);
    return res.status(500).json({ error: "Couldn't save that file — please try again" });
  }
  res.status(201).json({ id, kind, mime, size: buf.length, duration });
}));

app.get("/api/media/:id", requireAuth, ah(async (req, res) => {
  const rows = await query("SELECT mime FROM media WHERE id = ? AND email = ?", [req.params.id, req.user.email]);
  if (!rows[0]) return res.status(404).json({ error: "Attachment not found" });
  const parts = await query("SELECT data FROM media_chunks WHERE media_id = ? ORDER BY seq ASC", [req.params.id]);
  const out = Buffer.concat(parts.map((p) => Buffer.from(p.data)));
  res.set({ "Content-Type": rows[0].mime, "Cache-Control": "private, max-age=86400" });
  res.send(out);
}));

app.delete("/api/media/:id", requireAuth, ah(async (req, res) => {
  const rows = await query("SELECT id FROM media WHERE id = ? AND email = ?", [req.params.id, req.user.email]);
  if (rows[0]) await deleteMediaById(req.params.id);
  res.json({ ok: true });
}));

// ---------- Admin ----------
app.get("/api/admin/users", requireAuth, requireAdmin, ah(async (req, res) => {
  const rows = await query("SELECT email, name, is_admin, created_at, deleted FROM users ORDER BY created_at ASC");
  res.json({
    users: rows.map((r) => ({
      email: r.email,
      name: r.name,
      isAdmin: !!r.is_admin,
      createdAt: r.created_at,
      deleted: !!r.deleted,
    })),
  });
}));

app.get("/api/admin/feedback", requireAuth, requireAdmin, ah(async (req, res) => {
  const rows = await query("SELECT id, name, email, message, created_at FROM feedback ORDER BY created_at DESC");
  res.json({
    feedback: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      message: r.message,
      createdAt: r.created_at,
    })),
  });
}));

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Install-as-app (PWA) files, served from code so the repo stays simple ----------
const PWA_ICONS = {
  "icon-192.png": "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",
  "icon-512.png": "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",
  "icon-180.png": "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAMAAAAKE/YAAAAAkFBMVEWbrLCA3dIsyLVG2cU60b39/v5S4sw+1MAcvasAAAAPFyrO9O8dwa6Q5dls282u7ORx4dIEBxwMDSG78OlB0b5Dzr0ZRk8ibG0jdHQrlY6e6uDE7+oWJTYys6Wj598VMT4WNUEcUlgpjYcvpZo+4Mlna3iAhpCMkJm7vsPb3uDl5ugjIzYvr6J9qapus6+em6Q44tZMAAAAMHRSTlP///////////8A//////////////////////////////////////////////////+4d2/zAAAH8klEQVR42tXdaZvbKAwAYNYiZhOC7SQz0+mxPbfnXv//361zGWxzSJhkgK99ZvpWFQILErO1f/zuHNvqdiOAYjHeW5tDchYlvofZ42ZR5DuZXWwWQ76f2c5mEeS7mm1slr95rmYFmGdqRiW/hJlz7kbnax6rWSHmkZqVYjbVrBizoWblmLWa5V3ruBddgnlQs5LMVzUrynxRswz3dR6zgS7HfFazvPb8QfOALsl8UrNsngeR5gu6LPNRHUbnZsagszOf0KWZhQihczSH0FmaA+g8zX50puYeXZ5ZCFag2Y3O2OxE52x2oZeYt+Mf3iY3A0tq7n8OGvVeSrk6Dylb1UBisx29jQxwo96urEO+bx7Sma3obZy4XXmHVJDIbENvI7IiJL66H1OYLegtnazkCjtaWG6eo7d08oo0DPZFwiuaeYbe3phssIX48vzp6enV60pUJPMUvaXm8ipqKN6b/37a7Pb7/W7/4bVwp4jFPEETzWDL5WNlvpZmaBrVWhO+EZ83+81l7F8JinmMJuaGspSHxrYGgpoXl392Gz12rxwZYjWP0FtaakwXkrZ59KzZk6L486+NOfavrWq72UTTzM28BAd+wYNZGb/uRujNB3ycTfQSs2xw+6Lmyv61mQxbqF1mjaaZ2xiywf4xCbQtq53mAb3ArCrSD5/+j75P0fsngTZf0fFm+UhdQ3n/49+CaI/5go43K/oDyjHYbIb+JNDmMzreDDFbb17VbD/N6ec/K6z5hI42y+jHwerdtHx8EWjzEU0z/2asJvHPkeJ550npgLlHR9dnFW/uQ/1xnCB/CLwZGDEpjS1P9BN776rEHxtDvftsZHTQDIz29+mFWC0xn9Qfrxmye8dqipmG3qoE+Xyx9Tv/53f7XT82X3+u3lLMJPQWdN3YLjT3ai6qf//79v3Hr/NjgUCbaZHWyZGk99Wz9W8EvJmCNioHpDCf2DrfOGDNpEgvn4TzLbMORGOSvWYCWs9CWSUzc/3MJrFxJkV6iMlj0l6u1KEGnBmP1oGOTQ7H83ajQw04MyHSS5PD1SPg7TTUkAqtAx25fDsbGxwmoYZk6KWB9rS9JqGGZGhdo+MC7e0wglGrMWY0ul20FvrN/DAsWigzOj0WlY5A+1kXkI4nROvseExu7teUoVa3SdHX7Hh7CzNwRcsPRssO0jQ8rtKoswk9FXH5gUPHZwdHnacQ84ORVhZ0kT720uVBNbzCmIG/0etLskhLUu3guqcrFUecpwDvSEnNaClNyqXrzwTPgHqpPtZIhQbKyjI71FBV8DwFhqRWPBF6qNIyxuxUm3v+Yf/RJkMrfN/AekbXBM9Thkotk6Hfo+cht58bPoTOU4aZKJPltETPQ8f5rQqdp+iZCPdHu45oQ2dAN0RDVEaft/f+Pj+t5jFKmY7Njml+WHoFQ83r7o4+OK+nhM5TXhAtMWhrTyZztL2P9GJojkkPR+9LvBzaPREv7Wdnv+52aAihPSUv1DNfpUajFxfuQkPgbOIFV0Rnflyyw9fLTY5ukSeH3BXq4NmE6FKjsVvT49O3fWt6PJrwxvkGuzzcQ8Cks28mR8hsPATc93Frdh4xTmj/2cRQ8VT6B1vMvdzZg204zsSKR20hYJoy1YMRbAUYM20eItFtaCZOjwcbJfuhGuCoOIvhETEhugkkteWobejjYs5hh5Q+JGxAPvi7NZ4mLvLsmJTS2K6p9OUH9c62OztwKY1FD7/14QZmnR0y6fEFuO8AJTAPU0alPXORrkVxuRlES8sONFo5pmICs56GuNpR11j0o/3wM4VZB7pLjK5aW6iTxFlfMsKRCWiwhDqJWZ8yY6ZhTUKboeYJzYIU6JqIhumtqzS5oe9eIQJdU9E61G3F05kVIdA1HQ1mZz+R2ZiF4UDXEWjjmQRSmXVySHScaWhuXJxOZNaXsTu8mYQ2HqTaKolZ/98FF8M6Fq3novtwkGLuVuhZWMejOeYgFm3WkzC4gNfx6NGTtmsy4s0SXTnqekmkza6GPdYxZkkzE9GjtLbmdUw+S6CZ6WjziEJVCepGcBLWi9H9UmioD7C4PgcnYb0Ufe5oSNdZPXa/MfqYK91MrB6XtpcctRev7Q3sXnSUGjFm2jJ+HSO1bC5s7P75sNRMQRt5MFKv2mPHDnc3XsCb1WIzAT2ecu1qyhbBe+ZiSibXOip6WtzU9KPM4ugG911iIabf8hBrRqPnbdFm/lUY/Oy2gQXMvuWBuHbT0bbPTcw/ny9VB5cyornHf0hn+V6KLtqMRDv2c8r+rQLH/fzl6itA11m/V6CFeDMO7b6v7fwuEnkazj/tBMSbUWjPdW3e4L+PxMx+WGLGoP1X48nsniyWmRHo4DVzEhtDDpnD6PA9c/Dl9ngcOsD265agMf2NE7trMUHG9HLrpWhkT6avx727eeMuF22HE2PMATSpj3RaRk5X1C2FGylGmf1oeu/rfNYJ0HTncV7CsWCk2Yte0K9DfrAwzuxDp+qLJjd70Pma3eiMzTVbl2deO9A5m13orM0OdN5mOzpz8xG9Ls5sQedutqGzN5/R69LMU3T+5it6XZh5jC7ArNHrsswmugSziV4XZR5erFSSWb/CqiAzEp2HeY5el2M2X4BXjHn0qsFSzOOXOhZinrw+swzz7EWledc61ythCzBbXr6bv9n6muMM93WYF0rntedHv7r7RmZIQPa+JP3l+xsRb3Yf5PePcwD1P9FXAejDlhnWAAAAAElFTkSuQmCC",
  "icon-maskable.png": "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",
};
const PWA_MANIFEST = {"name":"Orbit","short_name":"Orbit","description":"Habits, goals and focus in one place","start_url":"/","scope":"/","display":"standalone","orientation":"portrait","background_color":"#0A0A0F","theme_color":"#0A0A0F","icons":[{"src":"/icon-192.png","sizes":"192x192","type":"image/png"},{"src":"/icon-512.png","sizes":"512x512","type":"image/png"},{"src":"/icon-maskable.png","sizes":"512x512","type":"image/png","purpose":"maskable"}]};
const PWA_SW = "const V='orbit-v1',SHELL=['/','/manifest.json','/icon-192.png'];\nself.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});\nself.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});\nself.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);\nif(r.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;\nif(r.mode==='navigate'){e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(V).then(h=>h.put('/',c));return x}).catch(()=>caches.match('/')));return}\ne.respondWith(caches.match(r).then(h=>{const n=fetch(r).then(x=>{if(x.ok){const c=x.clone();caches.open(V).then(k=>k.put(r,c))}return x}).catch(()=>h);return h||n}))});\n";
app.get("/manifest.json", (req, res) => res.type("application/manifest+json").send(JSON.stringify(PWA_MANIFEST)));
app.get("/sw.js", (req, res) => res.set("Cache-Control", "no-cache").type("text/javascript").send(PWA_SW));
Object.keys(PWA_ICONS).forEach((name) => {
  app.get("/" + name, (req, res) =>
    res.set("Cache-Control", "public, max-age=604800").type("image/png").send(Buffer.from(PWA_ICONS[name], "base64"))
  );
});

// ---------- Serve frontend ----------
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOT_INDEX = path.join(__dirname, "index.html");
const FRONTEND_DIR = fs.existsSync(path.join(PUBLIC_DIR, "index.html"))
  ? PUBLIC_DIR
  : fs.existsSync(ROOT_INDEX)
  ? __dirname
  : null;

if (FRONTEND_DIR) {
  console.log(`Serving frontend from: ${FRONTEND_DIR}`);
  app.use(express.static(FRONTEND_DIR, { index: false }));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });
} else {
  console.warn("No index.html found in ./public or the repo root — this deployment will only serve the API.");
}

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

// ---------- Start server ----------
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Orbit backend listening on port ${PORT} (${NODE_ENV})`);
    });
  })
  .catch((e) => {
    console.error("FATAL: could not connect to Turso database:", e.message);
    process.exit(1);
  });
