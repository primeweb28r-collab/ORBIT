// Orbit backend — Express + sql.js (pure JavaScript SQLite)
// No native compilation needed — works on any Node.js version
// Database is saved to disk in DATA_DIR so it persists across restarts

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const initSqlJs = require("sql.js");

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || "development";
function resolveDataDir() {
  const desired = process.env.DATA_DIR || path.join(__dirname, "data");
  const fallback = path.join(__dirname, "data");
  try {
    fs.mkdirSync(desired, { recursive: true });
    fs.accessSync(desired, fs.constants.W_OK);
    return desired;
  } catch (e) {
    console.warn(
      `Could not use DATA_DIR="${desired}" (${e.code || e.message}). ` +
        `Falling back to ${fallback}. NOTE: without a persistent disk mounted there, ` +
        `data will be lost on redeploy — see README.md.`
    );
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}
const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, "orbit.db");
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@orbit.local").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "OrbitAdmin2026!";
const ADMIN_NAME = process.env.ADMIN_NAME || "Orbit Owner";
const ACCOUNT_RECOVERY_DAYS = 30;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

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

// DATA_DIR is created inside resolveDataDir() above.

// ---------- Database ----------
let database = null;

async function initDatabase() {
  const SQL = await initSqlJs();

  // Load existing database from disk, or create new one
  let dbBuffer = null;
  if (fs.existsSync(DB_PATH)) {
    dbBuffer = fs.readFileSync(DB_PATH);
  }

  database = new SQL.Database(dbBuffer);

  // Create tables if they don't exist
  database.run(`
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

  saveDatabase();
  console.log(`Database loaded/created at ${DB_PATH}`);
  ensureAdminAccount();
  purgeExpiredDeletedAccounts();
}

function saveDatabase() {
  if (!database) return;
  const data = database.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function query(sql, params = []) {
  try {
    const stmt = database.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (e) {
    console.error("Query error:", sql, e.message);
    return [];
  }
}

function run(sql, params = []) {
  try {
    database.run(sql, params);
    saveDatabase();
    return true;
  } catch (e) {
    console.error("Run error:", sql, e.message);
    return false;
  }
}

function getUserRow(email) {
  const results = query("SELECT * FROM users WHERE email = ?", [String(email).toLowerCase()]);
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

function ensureAdminAccount() {
  const existing = getUserRow(ADMIN_EMAIL);
  if (existing) return;
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  run(
    "INSERT INTO users (email, name, password_hash, is_admin, created_at, data) VALUES (?, ?, ?, 1, ?, ?)",
    [ADMIN_EMAIL, ADMIN_NAME, hash, new Date().toISOString(), JSON.stringify(freshAppData())]
  );
  console.log(`Seeded admin account: ${ADMIN_EMAIL}`);
}

function purgeExpiredDeletedAccounts() {
  const rows = query("SELECT email, deleted_at FROM users WHERE deleted = 1");
  const now = Date.now();
  rows.forEach((r) => {
    if (!r.deleted_at) return;
    const days = (now - new Date(r.deleted_at).getTime()) / 86400000;
    if (days > ACCOUNT_RECOVERY_DAYS) {
      run("DELETE FROM users WHERE email = ?", [r.email]);
    }
  });
}

setInterval(purgeExpiredDeletedAccounts, 6 * 60 * 60 * 1000); // every 6h

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));

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
    run("DELETE FROM users WHERE email = ?", [email]);
  }
  run(
    "INSERT INTO users (email, name, password_hash, is_admin, created_at, data) VALUES (?, ?, ?, 0, ?, ?)",
    [email, String(name).trim(), hash, createdAt, JSON.stringify(freshAppData())]
  );
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
    run("UPDATE users SET deleted = 0, deleted_at = NULL WHERE email = ?", [email]);
    restored = true;
  }
  const token = signToken(email);
  res.json({ token, user: toPublicUser(getUserRow(email)), restored });
});

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
  run("UPDATE users SET data = ? WHERE email = ?", [JSON.stringify(data), req.user.email]);
  res.json({ ok: true });
});

app.delete("/api/me", requireAuth, (req, res) => {
  const { data } = req.body || {};
  if (data && typeof data === "object") {
    run("UPDATE users SET data = ? WHERE email = ?", [JSON.stringify(data), req.user.email]);
  }
  run("UPDATE users SET deleted = 1, deleted_at = ? WHERE email = ?", [
    new Date().toISOString(),
    req.user.email,
  ]);
  res.json({ ok: true, recoveryDays: ACCOUNT_RECOVERY_DAYS });
});

// ---------- Feedback ----------
app.post("/api/feedback", requireAuth, (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required" });
  run("INSERT INTO feedback (name, email, message, created_at) VALUES (?, ?, ?, ?)", [
    req.user.name,
    req.user.email,
    message,
    new Date().toISOString(),
  ]);
  res.status(201).json({ ok: true });
});

// ---------- Admin ----------
app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const rows = query("SELECT email, name, is_admin, created_at, deleted FROM users ORDER BY created_at ASC");
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
  const rows = query("SELECT id, name, email, message, created_at FROM feedback ORDER BY created_at DESC");
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

// ---------- Serve frontend ----------
// Looks for index.html in ./public first, then in the repo root, so it works
// whether you uploaded it into a "public" folder or straight to the repo root.
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOT_INDEX = path.join(__dirname, "index.html");
const FRONTEND_DIR = fs.existsSync(path.join(PUBLIC_DIR, "index.html"))
  ? PUBLIC_DIR
  : fs.existsSync(ROOT_INDEX)
  ? __dirname
  : null;

if (FRONTEND_DIR) {
  console.log(`Serving frontend from: ${FRONTEND_DIR}`);
  app.use(express.static(FRONTEND_DIR, { index: false })); // index:false so "/" always goes through the handler below
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });
} else {
  console.warn(
    "No index.html found in ./public or the repo root — this deployment will only serve the API. " +
      "Add index.html to your repo (either at the root or inside a 'public' folder) to serve the frontend too."
  );
}

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

// ---------- Start server ----------
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Orbit backend listening on port ${PORT} (${NODE_ENV})`);
    console.log(`Database: ${DB_PATH}`);
  });
});
