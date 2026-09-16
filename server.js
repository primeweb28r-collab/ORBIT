// Orbit backend — Express + Turso (libSQL, free cloud SQLite)
//
// One server.js, no build step: GitHub -> Render, database on Turso.
// Gives the Orbit frontend (index.html) real persistent accounts and
// cross-device data instead of per-browser localStorage.
//
// Data model:
//   - users: account records (email/password/admin flag/soft-delete marker)
//   - user_data: one JSON blob per user holding the entire Orbit app state
//     (habits, tasks, goals, journal, focus sessions, settings, etc.) —
//     this mirrors exactly what the frontend's getStateData() sends.
//   - feedback: rows submitted via the in-app "Complaint bar", readable
//     only by an admin account in the Settings > Admin Panel.
//
// You need a free Turso database — see README.md for setup.

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
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
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "owner@orbit.app").toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "OrbitOwner#2026";
const ACCOUNT_RECOVERY_DAYS = 30; // matches ACCOUNT_RECOVERY_DAYS in the frontend

if (!JWT_SECRET) {
  if (NODE_ENV === "production") {
    console.error("FATAL: JWT_SECRET is not set.");
    process.exit(1);
  } else {
    console.warn("WARNING: JWT_SECRET is not set -- using an insecure development secret.");
  }
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || "dev-only-insecure-secret-change-me";

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error(
    "FATAL: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be set. " +
      "Create a free database at turso.tech and set these env vars -- see README.md."
  );
  process.exit(1);
}

// ---------- Database ----------
const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

async function query(sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return result.rows;
}

async function run(sql, params = []) {
  await db.execute({ sql, args: params });
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

async function initDatabase() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS orbit_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS orbit_user_data (
      user_id TEXT PRIMARY KEY REFERENCES orbit_users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS orbit_feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES orbit_users(id) ON DELETE SET NULL,
      name TEXT,
      email TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Seed an admin account once, so there's always a way into the Admin Panel.
  if (OWNER_EMAIL && OWNER_PASSWORD) {
    const ownerRows = await query("SELECT id FROM orbit_users WHERE email = ?", [OWNER_EMAIL]);
    if (ownerRows.length === 0) {
      const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 10);
      const id = newId("usr");
      const createdAt = new Date().toISOString();
      await run(
        "INSERT INTO orbit_users (id, email, name, password_hash, is_admin, deleted_at, created_at) VALUES (?, ?, ?, ?, 1, NULL, ?)",
        [id, OWNER_EMAIL, "Admin", passwordHash, createdAt]
      );
      await run("INSERT INTO orbit_user_data (user_id, data, updated_at) VALUES (?, ?, ?)", [
        id, JSON.stringify({}), createdAt,
      ]);
      console.log(`Seeded admin account: ${OWNER_EMAIL} (change OWNER_PASSWORD via env var).`);
    }
  }
}

// ---------- App setup ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "12mb" })); // Orbit stores compressed journal/gallery photos as base64 in the data blob

const allowedOrigins = CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((s) => s.trim());
app.use(cors({ origin: allowedOrigins, credentials: false }));

app.use(
  "/api/",
  rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false })
);
app.use(
  "/api/auth/",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false })
);

// Wrap async route handlers so thrown errors reach Express's error handler.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function signToken(user) {
  return jwt.sign({ sub: user.id, isAdmin: !!user.is_admin }, EFFECTIVE_JWT_SECRET, { expiresIn: "30d" });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    req.user = { id: payload.sub, isAdmin: !!payload.isAdmin };
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin access required" });
  next();
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: !!row.is_admin,
    createdAt: row.created_at,
  };
}

// ---------- Auth ----------
app.post("/api/auth/register", ah(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();
  const password = String(req.body.password || "");
  if (!email || !name || password.length < 6) {
    return res.status(400).json({ error: "email, name, and a password of at least 6 characters are required" });
  }

  const existing = await query("SELECT id FROM orbit_users WHERE email = ?", [email]);
  if (existing[0]) return res.status(409).json({ error: "An account with that email already exists" });

  const id = newId("usr");
  const passwordHash = await bcrypt.hash(password, 10);
  const createdAt = new Date().toISOString();
  const isAdmin = email === OWNER_EMAIL ? 1 : 0;

  await run(
    "INSERT INTO orbit_users (id, email, name, password_hash, is_admin, deleted_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
    [id, email, name, passwordHash, isAdmin, createdAt]
  );
  await run("INSERT INTO orbit_user_data (user_id, data, updated_at) VALUES (?, ?, ?)", [
    id, JSON.stringify({}), createdAt,
  ]);

  const user = { id, email, name, is_admin: isAdmin, created_at: createdAt };
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

app.post("/api/auth/login", ah(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const rows = await query("SELECT * FROM orbit_users WHERE email = ?", [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "Invalid email or password" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password" });

  let restored = false;
  if (user.deleted_at) {
    const daysSince = (Date.now() - new Date(user.deleted_at).getTime()) / 86400000;
    if (daysSince <= ACCOUNT_RECOVERY_DAYS) {
      await run("UPDATE orbit_users SET deleted_at = NULL WHERE id = ?", [user.id]);
      restored = true;
    } else {
      // Recovery window has passed -- the account is permanently gone. Clean up
      // and respond exactly as if no such account existed.
      await run("DELETE FROM orbit_feedback WHERE user_id = ?", [user.id]);
      await run("DELETE FROM orbit_user_data WHERE user_id = ?", [user.id]);
      await run("DELETE FROM orbit_users WHERE id = ?", [user.id]);
      return res.status(401).json({ error: "Invalid email or password" });
    }
  }

  res.json({ token: signToken(user), user: publicUser(user), restored });
}));

// Verifies a second account's (or the current account's own) credentials without
// changing which session is logged in. Used by "Link account" in Settings and by
// the password-confirmation step before deleting a journal/gallery photo.
app.post("/api/auth/verify", ah(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const rows = await query("SELECT * FROM orbit_users WHERE email = ?", [email]);
  const user = rows[0];
  if (!user || user.deleted_at) return res.status(401).json({ error: "Invalid email or password" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password" });
  res.json({ user: publicUser(user) });
}));

// ---------- Per-user app data ----------
app.get("/api/me", requireAuth, ah(async (req, res) => {
  const rows = await query("SELECT * FROM orbit_users WHERE id = ?", [req.user.id]);
  const user = rows[0];
  if (!user || user.deleted_at) return res.status(401).json({ error: "Account not found" });
  const dataRows = await query("SELECT data FROM orbit_user_data WHERE user_id = ?", [req.user.id]);
  const data = dataRows[0] ? JSON.parse(dataRows[0].data) : {};
  res.json({ user: publicUser(user), data });
}));

app.put("/api/me/data", requireAuth, ah(async (req, res) => {
  const data = req.body.data || {};
  await run(
    `INSERT INTO orbit_user_data (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [req.user.id, JSON.stringify(data), new Date().toISOString()]
  );
  res.json({ ok: true });
}));

// Soft-delete: keeps the data around for ACCOUNT_RECOVERY_DAYS so signing back in
// (see /api/auth/login above) restores everything.
app.delete("/api/me", requireAuth, ah(async (req, res) => {
  if (req.body && req.body.data) {
    await run(
      `INSERT INTO orbit_user_data (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      [req.user.id, JSON.stringify(req.body.data), new Date().toISOString()]
    );
  }
  await run("UPDATE orbit_users SET deleted_at = ? WHERE id = ?", [new Date().toISOString(), req.user.id]);
  res.json({ ok: true });
}));

// ---------- Feedback / complaint bar ----------
app.post("/api/feedback", requireAuth, ah(async (req, res) => {
  const message = String(req.body.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required" });
  const rows = await query("SELECT * FROM orbit_users WHERE id = ?", [req.user.id]);
  const user = rows[0];
  await run(
    "INSERT INTO orbit_feedback (id, user_id, name, email, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [newId("fb"), req.user.id, user ? user.name : "", user ? user.email : "", message, new Date().toISOString()]
  );
  res.status(201).json({ ok: true });
}));

// ---------- Admin ----------
app.get("/api/admin/users", requireAuth, requireAdmin, ah(async (req, res) => {
  const rows = await query("SELECT * FROM orbit_users ORDER BY created_at DESC");
  res.json({ users: rows.map((u) => ({ ...publicUser(u), deleted: !!u.deleted_at })) });
}));

app.get("/api/admin/feedback", requireAuth, requireAdmin, ah(async (req, res) => {
  const rows = await query("SELECT * FROM orbit_feedback ORDER BY created_at DESC");
  res.json({ feedback: rows.map((f) => ({ name: f.name, email: f.email, message: f.message, createdAt: f.created_at })) });
}));

app.get("/health", (req, res) => res.json({ ok: true }));

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
  console.warn("No index.html found in ./public or the repo root -- this deployment will only serve the API.");
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
