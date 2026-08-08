# Orbit backend — FIXED

## What was actually broken

**The main bug:** `public/index.html` contained an instructional code comment
that included the literal text `</script>`. Browsers end a `<script>` block
the instant they see that exact character sequence — even inside a comment,
even inside a string. That comment cut off **99% of your app's JavaScript**
on every single page load. Nothing after it ever ran, including the code
that hides the loading screen and shows the login page. That's why it sat
on the spinning Orbit animation forever, both on GitHub Pages and on Render.

This is fixed in this version — the comment no longer contains that
sequence, and the loading-screen animation has also been switched off
entirely (as requested), so if anything ever goes wrong again you'll see
the actual page/error instead of an endless spinner masking it.

**Two smaller issues, also fixed:**
- `EACCES: permission denied, mkdir '/data'` — the server now tries your
  configured `DATA_DIR`, and if it can't write there for any reason, it
  automatically falls back to a local folder instead of crashing.
- `{"error":"Not found"}` on your Render URL — the server now looks for
  `index.html` in **either** `/public` or the repo root, so it works
  regardless of which one you upload to GitHub. This zip includes both, so
  either way it just works.

---

## What's in this folder

- `server.js` — the API (Express + `sql.js`, no native compilation needed)
- `package.json` — dependencies
- `index.html` — the app, fixed (at the repo root)
- `public/index.html` — the same fixed file, also placed in `public/` (in
  case you prefer that layout — server.js checks both)
- `.env.example`, `.gitignore`

---

## How to deploy this fix

### 1. Replace the files in your GitHub repo

For each of these three files, do the same thing: open the file on GitHub,
delete it, then upload the new version from this zip.

- `server.js`
- `package.json`
- `index.html`

(You can also add `public/index.html` if you want, but it's not required —
either location works now.)

**Steps for each file:**
1. Go to your `ORBIT-` repo on github.com
2. Click the file name
3. Click the trash icon (top right) → **Commit changes**
4. Back on the repo main page: **Add file** → **Upload files**
5. Drag in the new version from this zip → **Commit changes**

### 2. Redeploy on Render

1. Go to render.com → your **orbit** service
2. Click **Manual Deploy** → **Deploy latest commit** (or just **Redeploy**)
3. Watch the logs until it says **"Your service is live"**

### 3. Check your environment variables are still all there

In Render → **Environment**, confirm you still have all of these:

| Key | Value |
|---|---|
| `JWT_SECRET` | your long random string |
| `ADMIN_EMAIL` | `admin@orbit.local` |
| `ADMIN_PASSWORD` | your admin password |
| `ADMIN_NAME` | `Orbit Owner` |
| `NODE_ENV` | `production` |
| `CORS_ORIGIN` | `https://primeweb28r-collab.github.io` |
| `DATA_DIR` | `/data` (fine to leave as-is now — it'll self-heal if this ever isn't writable) |

### 4. Test it

- Visit your Render URL directly (e.g. `https://orbit-t0ap.onrender.com`) —
  it should now show the login page immediately, no spinner.
- Visit your GitHub Pages URL (`https://primeweb28r-collab.github.io/ORBIT-`)
  — same thing, login page should appear right away.
- Register an account, add a habit, refresh the page, confirm it's still
  there.

If either URL still doesn't work after this, open DevTools (F12) →
**Console** tab and send me a screenshot of any red errors — that'll tell
us exactly what's left.
