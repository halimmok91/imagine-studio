"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

// Prefer the user's CWD (where they double-clicked the .exe from) so static
// files like index.html live alongside the binary and packagers can ship
// loose assets next to it. Fall back to __dirname for `node server.js` dev
// (where CWD might be the repo root, but the files exist in the repo).
const cwdFiles = fs.existsSync(path.join(process.cwd(), "index.html")) ? process.cwd() : null;
const dirFiles = fs.existsSync(path.join(__dirname, "index.html")) ? __dirname : null;
const ROOT = cwdFiles || dirFiles || __dirname;
// Debug-info written to disk so we can diagnose "UI messed up" reports from
// single-file .exe launches. Useful because users see the console briefly
// then it disappears; this file stays.
try {
  fs.appendFileSync(path.join(process.env.TEMP || "/tmp", "imagine-studio-boot.log"),
    `[${new Date().toISOString()}] root=${ROOT}\n` +
    `  cwd=${process.cwd()}\n` +
    `  __dirname=${__dirname}\n` +
    `  cwdHasIndex=${fs.existsSync(path.join(process.cwd(), "index.html"))}\n` +
    `  dirHasIndex=${fs.existsSync(path.join(__dirname, "index.html"))}\n` +
    `  cwdHasApp=${fs.existsSync(path.join(process.cwd(), "app.js"))}\n` +
    `  dirHasApp=${fs.existsSync(path.join(__dirname, "app.js"))}\n`
  );
} catch (e) {}
// Auto-pick port: try PORT env var (default 8989, reserved for Imagine Studio).
// If 8989 is busy we scan upward by 1 (after a loopback pre-check that catches
// the Windows dual-bind shadowing bug).
const REQUESTED_PORT = parseInt(process.env.PORT || "8989", 10);
// Bind address. Loopback-only by default (desktop .exe); hosts like Render
// require 0.0.0.0, set via HOST env var (see render.yaml).
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM = "https://imaginer.mirava.studio";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2"
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

const HOME = process.env.USERPROFILE || process.env.HOME || "";
const DEFAULT_SAVE_ROOT = path.join(HOME, "Pictures", "Imagine Studio");
// Largest accepted /save-image body. Generated PNGs at 4K sit well under this;
// the cap only exists so an unbounded stream can't be buffered into memory.
const MAX_SAVE_BYTES = 64 * 1024 * 1024;

// Every disk-writing endpoint funnels folder input through here. `deleteSaved`,
// `openFolder` and `importImage` already constrained their paths to the user's
// home; `saveImage` did not, which let any page on the machine (CORS is open)
// write a file anywhere the account could. Same rule for all of them now.
function resolveSaveFolder(requested) {
  const folder = (requested || "").trim() || DEFAULT_SAVE_ROOT;
  if (folder.includes("..")) throw new Error("invalid folder");
  const norm = path.resolve(folder);
  // Bare drive roots (C:\) and filesystem roots are never valid save targets.
  if (/^[a-zA-Z]:[\\/]?$/.test(folder) || norm === path.parse(norm).root) throw new Error("invalid folder");
  // When HOME is unresolvable we cannot enforce containment; fall back to the
  // default root rather than trusting the caller.
  if (!HOME) return path.resolve(DEFAULT_SAVE_ROOT);
  const home = path.resolve(HOME);
  const rel = path.relative(home, norm);
  if (rel && (rel.startsWith("..") || path.isAbsolute(rel))) throw new Error("folder must be under user home");
  return norm;
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split("?")[0]);
  } catch (e) {
    res.writeHead(400); return res.end("Bad request");
  }
  // "/" is the landing screen; the studio itself lives at "/app". Keeping
  // index.html as the app means every existing relative asset path in it
  // (app.js, styles.css, vendor/) still resolves unchanged.
  if (pathname === "/") pathname = "/landing.html";
  else if (pathname === "/app" || pathname === "/app/") pathname = "/index.html";
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(file, (err, stat) => {
    if (!err && stat.isDirectory()) return servePath(path.join(file, "index.html"), res);
    if (err) return servePath(file, res);
    servePath(file, res);
  });
}

function servePath(file, res) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const ext = path.extname(file).toLowerCase();
    // App files must always revalidate: without this, browsers heuristically
    // cache app.js and keep running OLD code after an exe rebuild (user saw
    // "still not auto saving" with stale JS). Vendor libs are immutable.
    const noCache = ext === ".html" || ext === ".js" || ext === ".css";
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (noCache) headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    try {
      fs.appendFileSync(path.join(process.env.TEMP || "/tmp", "imagine-studio-boot.log"),
        `  [serve] ${ext} ${data.length}B\n`);
    } catch (e) {}
    res.end(data);
  });
}

async function proxy(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = {};
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers["authorization"]) headers["authorization"] = req.headers["authorization"];
  try {
    const up = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: body.length ? body : undefined });
    const buf = Buffer.from(await up.arrayBuffer());
    const outHeaders = { ...CORS };
    const ct = up.headers.get("content-type");
    if (ct) outHeaders["content-type"] = ct;
    console.log(`[proxy] ${req.method} ${req.url} -> ${up.status}`);
    res.writeHead(up.status, outHeaders);
    res.end(buf);
  } catch (e) {
    console.error(`[proxy] ${req.method} ${req.url} -> upstream error: ${e.message}`);
    res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Proxy could not reach upstream: " + e.message }));
  }
}

// Local image proxy: fetches an arbitrary image URL server-side and streams the
// bytes back. Used by the gallery to copy remote CDN images into IndexedDB
// without triggering CORB (cross-origin fetch in JS is blocked for many CDNs).
// GET /img-proxy?u=<url-encoded image URL>
async function imgProxy(req, res) {
  try {
    const url = new URL(req.url, "http://x").searchParams.get("u");
    if (!url || !/^https?:\/\//i.test(url)) {
      res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "missing ?u=https://..." }));
    }
    // Hard 20s timeout: without this, a stalled CDN connection hangs the fetch
    // forever (undici has no default timeout) — the browser waits, the save
    // chain silently dies, and nothing is logged. Timeout turns the hang into
    // a fast 502 the UI can see and retry.
    const up = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 ImagineStudio" },
      signal: AbortSignal.timeout(20000)
    });
    if (!up.ok) {
      res.writeHead(up.status, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: `upstream ${up.status}` }));
    }
    const ct = up.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await up.arrayBuffer());
    console.log(`[img-proxy] ${url.slice(0, 80)} -> ${up.status} ${buf.length}B`);
    res.writeHead(200, { ...CORS, "Content-Type": ct, "Cache-Control": "public, max-age=86400" });
    res.end(buf);
  } catch (e) {
    console.error(`[img-proxy] error: ${e.message}`);
    res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// maxHeaderSize: default 16KB is fine for short prompts, but base64 of a
// 5000-char prompt (plus emoji/CJK inflating it ~4x) can approach the cap and
// Node would drop the connection with a 431 before saveImage ever runs.
const server = http.createServer({ maxHeaderSize: 65536 }, (req, res) => {
  // Log every incoming request so we can diagnose "asset 404'd" reports.
  try {
    fs.appendFileSync(path.join(process.env.TEMP || "/tmp", "imagine-studio-boot.log"),
      `  [req] ${req.method} ${req.url}\n`);
  } catch (e) {}
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.url.startsWith("/api/")) return proxy(req, res);
  if (req.url.startsWith("/img-proxy")) return imgProxy(req, res);
  if (req.url.startsWith("/save-image")) return saveImage(req, res);
  if (req.url.startsWith("/delete-saved")) return deleteSaved(req, res);
  if (req.url.startsWith("/list-saved")) return listSaved(req, res);
  if (req.url.startsWith("/scan-saved")) return scanSaved(req, res);
  if (req.url.startsWith("/import-image")) return importImage(req, res);
  if (req.url.startsWith("/open-folder")) return openFolder(req, res);
  serveStatic(req, res);
});

// Try the requested port, scan upward by 1 if EADDRINUSE. Up to 12 attempts
// before giving up. Final port is what we report in the banner.
//
// Windows quirk: a process binding to `127.0.0.1:PORT` and another to
// `0.0.0.0:PORT` are NOT EADDRINUSE — both "succeed" — but a browser hitting
// `http://localhost:PORT` reaches the loopback process, not ours. To avoid
// being silently shadowed by another app on the same port, we pre-check
// `127.0.0.1:PORT` with a probe before letting node try to bind. If the
// probe can connect, we treat the port as busy and try the next one. (Node
// doesn't expose this distinction natively; the probe is the simplest fix.)
function probePort(port, host) {
  return new Promise((resolve) => {
    const sock = require("net").connect({ port, host });
    let done = false;
    const finish = (busy) => { if (!done) { done = true; resolve(busy); } };
    sock.once("connect", () => { sock.destroy(); finish(true); });
    sock.once("error", () => { finish(false); });
    setTimeout(() => { try { sock.destroy(); } catch (e) {} finish(false); }, 400);
  });
}
function tryListen(port, attemptsLeft) {
  // Pre-check loopback explicitly. If something else owns 127.0.0.1:port
  // (e.g. Headroom, another local proxy), a bind to a wider interface would
  // still succeed on Windows and we would be invisible to the browser. We now
  // bind HOST directly (loopback by default), but the probe still gives a
  // clearer message than a bare EADDRINUSE and keeps the port-scan behaviour
  // identical.
  probePort(port, "127.0.0.1").then((loopbackBusy) => {
    if (loopbackBusy) {
      console.log(`  Port ${port} is held on 127.0.0.1 by another process, trying ${port + 1}...`);
      if (attemptsLeft > 0) return tryListen(port + 1, attemptsLeft - 1);
      console.error(`  Could not find a free port starting at ${REQUESTED_PORT}.`);
      return process.exit(1);
    }
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
        console.log(`  Port ${port} busy, trying ${port + 1}...`);
        tryListen(port + 1, attemptsLeft - 1);
      } else {
        console.error(`  Could not bind any port starting at ${REQUESTED_PORT}: ${err.message}`);
        process.exit(1);
      }
    });
    server.listen(port, HOST, () => {
      const actualPort = server.address().port;
      if (actualPort !== REQUESTED_PORT) {
        console.log(`  (Requested ${REQUESTED_PORT} was busy; using ${actualPort} instead)`);
      }
      console.log("");
      console.log("  IMAGINE Studio");
      console.log(`  Local server + API proxy running at http://localhost:${actualPort}`);
      console.log("");
      console.log(`  Static files : ${ROOT}`);
      console.log(`  API proxy    : ${UPSTREAM}/api/*`);
      console.log("");
      console.log("  In the app's Settings, set API base URL to \"/\" to route");
      console.log("  through this proxy (avoids any browser CORS restrictions).");
      console.log("");
      // Auto-open the browser. Best-effort — failures are silent so we don't
      // spam users who launch from a non-interactive shell. Uses actualPort
      // (not REQUESTED_PORT) so users land on whichever port we actually
      // bound to.
      autoOpenBrowser(actualPort);
    });
  });
}
tryListen(REQUESTED_PORT, 12);

// ---- Save image to disk --------------------------------------------------
// Allows the frontend to write generated images (as real files) into a
// user-chosen folder. Used by the auto-save feature and the per-card "Save"
// action. The browser sends multipart-ish via JSON+base64 OR raw bytes; we
// accept either. Returns { ok, path } or { ok:false, error }.
//
// POST /save-image?folder=...
//   Headers: x-image-meta: <json {gid, prompt, model, ratio, ts, ext}>
//   Body:    raw image bytes
async function saveImage(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    // Constrained to the user's home dir (see resolveSaveFolder). Throws for
    // anything outside, which the catch below turns into a JSON error.
    let folder = resolveSaveFolder(url.searchParams.get("folder"));
    // Daily subfolder so a user who generates a lot doesn't get one huge dir.
    const today = new Date().toISOString().slice(0, 10);
    folder = path.join(folder, today);
    fs.mkdirSync(folder, { recursive: true });

    let meta = {};
    try {
      const raw = req.headers["x-image-meta"] || "";
      // New client sends base64(UTF-8 JSON) because header values must be
      // ISO-8859-1 and prompts contain …, curly quotes, CJK, emoji etc.
      // Old clients sent raw JSON — accept both.
      if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0) {
        meta = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      } else {
        meta = JSON.parse(raw);
      }
    } catch (e) { meta = {}; }
    const gid = (meta.gid || Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, "_");
    const ext = meta.ext || "png";
    const filename = `${today}_${gid}.${ext}`;
    const filepath = path.join(folder, filename);

    // Read raw body into a buffer, refusing anything absurdly large so a
    // rogue caller can't balloon our memory with one request.
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > MAX_SAVE_BYTES) throw new Error("image too large");
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error("empty body");
    fs.writeFileSync(filepath, buf);

    // Write sidecar .json with metadata (prompt, model, ts, etc.)
    const sidecar = path.join(folder, `${today}_${gid}.json`);
    fs.writeFileSync(sidecar, JSON.stringify({
      gid, ts: meta.ts || Date.now(), prompt: meta.prompt || "",
      model: meta.model || "", ratio: meta.ratio || "", quality: meta.quality || "",
      style: meta.style || "", mode: meta.mode || "", tags: meta.tags || []
    }, null, 2));

    console.log(`[save-image] wrote ${filepath} (${buf.length}B)`);
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: filepath }));
  } catch (e) {
    console.error(`[save-image] error: ${e.message}`);
    res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// Delete an image saved by this app and its JSON sidecar. The requested image
// must live inside the configured save root and its filename must contain the
// sanitized gallery id, preventing this endpoint from deleting arbitrary files.
// If an older gallery record has no saved path, search the save root by gid.
async function deleteSaved(req, res) {
  try {
    if (req.method !== "POST") {
      res.writeHead(405, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "POST required" }));
    }
    const url = new URL(req.url, "http://x");
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const root = path.resolve(url.searchParams.get("folder") || path.join(home, "Pictures", "Imagine Studio"));
    const gid = (url.searchParams.get("gid") || "").replace(/[^a-zA-Z0-9_-]/g, "_");
    const requestedPath = url.searchParams.get("path") || "";
    if (!gid) throw new Error("missing gallery id");

    const isInsideRoot = p => {
      const rel = path.relative(root, path.resolve(p));
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
    };
    const expectedName = new RegExp(`_${gid.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.(png|jpg|jpeg|webp)$`, "i");
    const images = [];
    if (requestedPath) {
      const target = path.resolve(requestedPath);
      if (!isInsideRoot(target) || !expectedName.test(path.basename(target))) throw new Error("saved path is outside the save folder or does not match this image");
      images.push(target);
    } else if (fs.existsSync(root)) {
      const walk = (dir, depth = 0) => {
        if (depth > 6) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full, depth + 1);
          else if (expectedName.test(ent.name)) images.push(full);
        }
      };
      walk(root);
    }

    let deleted = 0;
    for (const imagePath of images) {
      const sidecar = imagePath.replace(/\.(png|jpg|jpeg|webp)$/i, ".json");
      for (const file of [imagePath, sidecar]) {
        if (fs.existsSync(file)) { fs.unlinkSync(file); deleted++; }
      }
    }
    console.log(`[delete-saved] gid=${gid} deleted=${deleted}`);
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, deleted }));
  } catch (e) {
    console.error(`[delete-saved] error: ${e.message}`);
    res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// Walk the user's save folder recursively and return metadata for every
// .png/.jpg + their .json sidecar. Used by the front-end "Re-import" button
// to rebuild the gallery from disk after a localStorage wipe. We cap the
// total files scanned to 5000 to avoid pathological folders.
async function scanSaved(req, res) {
  const MAX = 5000;
  function walk(dir, depth, out) {
    if (out.length >= MAX || depth > 6) return out;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const ent of entries) {
      if (out.length >= MAX) break;
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) walk(full, depth + 1, out);
        else if (/\.(png|jpg|jpeg|webp)$/i.test(ent.name)) {
          const sidecar = full.replace(/\.(png|jpg|jpeg|webp)$/i, ".json");
          let meta = null;
          try { meta = JSON.parse(fs.readFileSync(sidecar, "utf8")); } catch (e) { meta = null; }
          out.push({ path: full, name: ent.name, dir, meta });
        }
      } catch (e) {}
    }
    return out;
  }
  try {
    const url = new URL(req.url, "http://x");
    let folder = url.searchParams.get("folder");
    if (!folder) {
      const home = process.env.USERPROFILE || process.env.HOME || "";
      folder = path.join(home, "Pictures", "Imagine Studio");
    }
    const out = [];
    if (fs.existsSync(folder)) walk(folder, 0, out);
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, folder, count: out.length, items: out }));
  } catch (e) {
    res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// Open a folder in the OS file manager (Windows only). Used by the Settings
// "Open" button. Path is restricted to the user's save-folder to avoid the
// front-end abusing the server as a generic file-opener. We create the
// folder if it doesn't exist so the user always sees SOMETHING.
async function openFolder(req, res) {
  if (process.platform !== "win32") {
    res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Open in Explorer is Windows-only." }));
  }
  try {
    const url = new URL(req.url, "http://x");
    let folder = url.searchParams.get("folder");
    if (!folder) {
      const home = process.env.USERPROFILE || process.env.HOME || "";
      folder = path.join(home, "Pictures", "Imagine Studio");
    }
    // Whitelist: allow only folders inside the user's home (no /, no
    // absolute pointing at system roots). Anything else -> reject.
    const home = process.env.USERPROFILE || process.env.HOME || "";
    if (!folder || /^[a-zA-Z]:[\\/]?$/i.test(folder) || folder.includes("..")) {
      res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "invalid folder" }));
    }
    const norm = path.resolve(folder);
    if (home && !norm.startsWith(path.resolve(home))) {
      res.writeHead(403, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "folder must be under user home" }));
    }
    fs.mkdirSync(norm, { recursive: true });
    // Open in File Explorer. Use cmd /c start (same trick as the auto-open
    // browser) — it's the most reliable way to detach a child process from
    // a pkg-snapshotted Node, and we don't need a console window.
    const { spawn } = require("child_process");
    console.log(`[open-folder] ${norm}`);
    spawn("cmd", ["/c", "start", "", `explorer`, norm], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, opened: norm }));
  } catch (e) {
    res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// Serve a single image file from disk so the browser can re-import it into
// IDB. We restrict paths to the user's save folder to avoid leaking other files.
async function importImage(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.searchParams.get("path");
    if (!p) { res.writeHead(400, { ...CORS, "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "missing ?path=" })); }
    if (!/\.(png|jpg|jpeg|webp)$/i.test(p)) { res.writeHead(403, { ...CORS, "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "not an image" })); }
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const allowedRoots = [
      path.join(home, "Pictures", "Imagine Studio"),
    ].filter(Boolean);
    const norm = path.resolve(p);
    if (!allowedRoots.some(r => r && norm.startsWith(path.resolve(r)))) {
      res.writeHead(403, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "path outside allowed roots" }));
    }
    const buf = fs.readFileSync(norm);
    const ext = path.extname(norm).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : (ext === ".webp" ? "image/webp" : "image/png");
    res.writeHead(200, { ...CORS, "Content-Type": mime });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// Lightweight folder-listing endpoint so the frontend can verify a folder
// exists / show file count. We deliberately don't expose full directory
// listings for security — only the requested folder + JSON-friendly stats.
async function listSaved(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const folder = url.searchParams.get("folder");
    if (!folder) {
      res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "missing ?folder=" }));
    }
    const exists = fs.existsSync(folder);
    let count = 0;
    if (exists) {
      try { count = fs.readdirSync(folder).length; } catch (e) {}
    }
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, exists, count }));
  } catch (e) {
    res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// Best-effort: spawn the default browser pointed at our server. On Windows
// (the only place this .exe runs) `start` is a shell builtin — spawning it
// through cmd.exe opens the user's default browser without blocking us.
function autoOpenBrowser(port) {
  try {
    if (process.platform !== "win32") return;
    if (process.env.NO_BROWSER === "1") return;  // opt-out via env
    const { spawn } = require("child_process");
    spawn("cmd", ["/c", "start", "", `http://localhost:${port}`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (e) { /* ignore — non-critical */ }
}
