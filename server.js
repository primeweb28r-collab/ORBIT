// Orbit backend — Express + SQLite
//
// Replaces the browser localStorage-based "multi-user" system in the Orbit
// frontend with a real server: accounts, passwords, and each user's app
// data now live in a SQLite file on the server instead of in one visitor's
// browser. See README.md for how to deploy this and point the frontend at it.

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || "development";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "orbit.db");
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@orbit.local").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "OrbitAdmin2026!";
const ADMIN_NAME = process.env.ADMIN_NAME || "Orbit Owner";
const ACCOUNT_RECOVERY_DAYS = 30;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // comma-separated list, or *
const SERVE_FRONTEND = process.env.SERVE_FRONTEND !== "false"; // serve ./public if present

if (!JWT_SECRET) {
  if (NODE_ENV === "production") {
    console.error(
      "FATAL: JWT_SECRET is not set. Set it in your environment before starting the server in production."
    );
    process.exit(1);
  } else {
    console.warn(
      "WARNING: JWT_SECRET is not set — using an insecure development secret. " +
        "Set JWT_SECRET before deploying this anywhere real."
    );
  }
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || "dev-only-insecure-secret-change-me";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Database ----------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    data TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function getUserRow(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase());
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

// Default app state — mirrors createFreshUserData() in the frontend so a
// brand-new account boots with the same starter habits/goals it always did.
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

function ensureAdminAccount() {
  const existing = getUserRow(ADMIN_EMAIL);
  if (existing) return;
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare(
    "INSERT INTO users (email, name, password_hash, is_admin, created_at, data) VALUES (?, ?, ?, 1, ?, ?)"
  ).run(ADMIN_EMAIL, ADMIN_NAME, hash, new Date().toISOString(), JSON.stringify(freshAppData()));
  console.log(`Seeded admin account: ${ADMIN_EMAIL}`);
}

function purgeExpiredDeletedAccounts() {
  const rows = db.prepare("SELECT email, deleted_at FROM users WHERE deleted = 1").all();
  const now = Date.now();
  const stmt = db.prepare("DELETE FROM users WHERE email = ?");
  rows.forEach((r) => {
    if (!r.deleted_at) return;
    const days = (now - new Date(r.deleted_at).getTime()) / 86400000;
    if (days > ACCOUNT_RECOVERY_DAYS) stmt.run(r.email);
  });
}

ensureAdminAccount();
purgeExpiredDeletedAccounts();
setInterval(purgeExpiredDeletedAccounts, 6 * 60 * 60 * 1000); // every 6h

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" })); // generous limit: avatar/background images are stored as data URLs in app data

const allowedOrigins = CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((s) => s.trim());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: false,
  })
);

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

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    const user = getUserRow(payload.email);
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

// ---------- Auth routes ----------
app.post("/api/auth/register", authLimiter, (req, res) => {
  const { name, password } = req.body || {};
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !isValidEmail(email) || !name || !password) {
    return res.status(400).json({ error: "Name, a valid email, and a password are required" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const existing = getUserRow(email);
  if (existing && !existing.deleted) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }
  const hash = bcrypt.hashSync(password, 10);
  const createdAt = new Date().toISOString();
  if (existing && existing.deleted) {
    db.prepare("DELETE FROM users WHERE email = ?").run(email); // fresh start rather than resurrecting old deleted data
  }
  db.prepare(
    "INSERT INTO users (email, name, password_hash, is_admin, created_at, data) VALUES (?, ?, ?, 0, ?, ?)"
  ).run(email, String(name).trim(), hash, createdAt, JSON.stringify(freshAppData()));
  const user = getUserRow(email);
  const token = signToken(email);
  res.status(201).json({ token, user: toPublicUser(user) });
});

app.post("/api/auth/login", authLimiter, (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const { password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  const user = getUserRow(email);
  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  let restored = false;
  if (user.deleted) {
    db.prepare("UPDATE users SET deleted = 0, deleted_at = NULL WHERE email = ?").run(email);
    restored = true;
  }
  const token = signToken(email);
  res.json({ token, user: toPublicUser(getUserRow(email)), restored });
});

// Verifies credentials WITHOUT starting a session for them — used by the
// "link account" feature so checking a second account's password doesn't
// switch who you're logged in as.
app.post("/api/auth/verify", authLimiter, requireAuth, (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const { password } = req.body || {};
  const user = getUserRow(email);
  if (!user || user.deleted || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Could not verify that account" });
  }
  res.json({ valid: true, user: toPublicUser(user) });
});

// ---------- Current-user data routes ----------
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: toPublicUser(req.user), data: JSON.parse(req.user.data || "{}") });
});

app.put("/api/me/data", requireAuth, (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== "object") return res.status(400).json({ error: "Missing data payload" });
  db.prepare("UPDATE users SET data = ? WHERE email = ?").run(JSON.stringify(data), req.user.email);
  res.json({ ok: true });
});

app.delete("/api/me", requireAuth, (req, res) => {
  const { data } = req.body || {};
  if (data && typeof data === "object") {
    db.prepare("UPDATE users SET data = ? WHERE email = ?").run(JSON.stringify(data), req.user.email);
  }
  db.prepare("UPDATE users SET deleted = 1, deleted_at = ? WHERE email = ?").run(
    new Date().toISOString(),
    req.user.email
  );
  res.json({ ok: true, recoveryDays: ACCOUNT_RECOVERY_DAYS });
});

// ---------- Feedback ----------
app.post("/api/feedback", requireAuth, (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required" });
  db.prepare("INSERT INTO feedback (name, email, message, created_at) VALUES (?, ?, ?, ?)").run(
    req.user.name,
    req.user.email,
    message,
    new Date().toISOString()
  );
  res.status(201).json({ ok: true });
});

// ---------- Admin ----------
app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT email, name, is_admin, created_at, deleted FROM users ORDER BY created_at ASC").all();
  res.json({
    users: rows.map((r) => ({
      email: r.email,
      name: r.name,
      isAdmin: !!r.is_admin,
      createdAt: r.created_at,
      deleted: !!r.deleted,
    })),
  });
});

app.get("/api/admin/feedback", requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT id, name, email, message, created_at FROM feedback ORDER BY created_at DESC").all();
  res.json({
    feedback: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      message: r.message,
      createdAt: r.created_at,
    })),
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Optional: serve the frontend from the same server ----------
// Drop the (possibly API-adapted) index.html into ./public and this server
// will serve it directly, so the whole app can be one deployment.
const PUBLIC_DIR = path.join(__dirname, "public");
if (SERVE_FRONTEND && fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });
}

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => {
  console.log(`Orbit backend listening on port ${PORT} (${NODE_ENV})`);
  console.log(`SQLite database: ${DB_PATH}`);
});
