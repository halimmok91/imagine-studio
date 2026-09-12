"use strict";

const $ = s => document.querySelector(s);
const REAL_BASE = "https://imaginer.mirava.studio";
const LS = { key: "imagine.apiKey", keys: "imagine.apiKeys", base: "imagine.baseUrl", model: "imagine.model", hist: "imagine.history", batch: "imagine.batch", delay: "imagine.delay", seq: "imagine.seq", sort: "imagine.sort", promptHistory: "imagine.promptHistory" };
const MAX_PROMPT = 5000;
// Reference uploads expire server-side; re-upload any ref older than this before generating.
const REF_MAX_AGE_MS = 45000;

// ---- Local image store (IndexedDB) -----------------------------------------
// We mirror every generated image as a Blob in IndexedDB keyed by the gallery
// record's gid. Local copies survive CDN URL expiry and let the gallery render
// instantly without hitting the network. Without this, every "Link expired"
// card is permanently invisible.
const IMG_DB = "imagineStudio", IMG_STORE = "imgs", KV_STORE = "kv";
let imgDbPromise = null;
function imgDb() {
  if (imgDbPromise) return imgDbPromise;
  imgDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IMG_DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IMG_STORE)) db.createObjectStore(IMG_STORE, { keyPath: "gid" });
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE, { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return imgDbPromise;
}
// Mirror small KV (history/prompts/keys) into IDB so a localStorage wipe
// doesn't lose the gallery. We write best-effort; failures are silent.
async function kvPut(key, value) {
  try {
    const db = await imgDb();
    await new Promise((res) => {
      const tx = db.transaction(KV_STORE, "readwrite");
      tx.objectStore(KV_STORE).put({ k: key, v: value, ts: Date.now() });
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch (e) {}
}
async function kvGet(key) {
  try {
    const db = await imgDb();
    return await new Promise((res) => {
      const tx = db.transaction(KV_STORE, "readonly");
      const r = tx.objectStore(KV_STORE).get(key);
      r.onsuccess = () => res(r.result ? r.result.v : null);
      r.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
async function kvList() {
  try {
    const db = await imgDb();
    return await new Promise((res) => {
      const tx = db.transaction(KV_STORE, "readonly");
      const r = tx.objectStore(KV_STORE).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    });
  } catch (e) { return []; }
}
async function imgPut(gid, blob) {
  try {
    const db = await imgDb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(IMG_STORE, "readwrite");
      tx.objectStore(IMG_STORE).put({ gid, blob, ts: Date.now() });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* quota / private mode — fall back silently */ }
}
async function imgGet(gid) {
  try {
    const db = await imgDb();
    return await new Promise((res) => {
      const tx = db.transaction(IMG_STORE, "readonly");
      const r = tx.objectStore(IMG_STORE).get(gid);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
async function imgDel(gid) {
  try {
    const db = await imgDb();
    await new Promise((res) => {
      const tx = db.transaction(IMG_STORE, "readwrite");
      tx.objectStore(IMG_STORE).delete(gid);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch (e) {}
}
async function imgClear() {
  try {
    const db = await imgDb();
    await new Promise((res) => {
      const tx = db.transaction(IMG_STORE, "readwrite");
      tx.objectStore(IMG_STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch (e) {}
}
// Fetch a CDN URL and store its bytes locally. Non-blocking — caller decides
// what to do on failure. Returns the blob on success.
//
// Goes through our own /img-proxy endpoint because direct `fetch()` from the
// browser triggers CORB for cross-origin images — the proxy strips the
// cross-origin concern by fetching server-side, then handing us a same-origin
// response we can blob() normally.
async function cacheRemoteUrl(gid, url) {
  if (!gid || !url) return null;
  try {
    const proxyUrl = "/img-proxy?u=" + encodeURIComponent(url);
    const r = await fetch(proxyUrl);
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!blob || !blob.size) return null;
    await imgPut(gid, blob);
    return blob;
  } catch (e) { return null; }
}

// Resilient image-byte fetch for the save paths. The old save chain routed
// ONLY through /img-proxy and gave up silently on the first failure — a slow
// or rate-limited CDN meant "some images not auto-saved" and a hard
// "image unreachable" on manual save. Here we retry with backoff and try the
// direct URL as a fallback (the <img> tag loads it fine; CORS is the only
// thing that might block the browser fetch, so the proxy stays first choice).
// Every attempt is timeout-guarded (12s) so a stalled connection can't hang
// the whole chain — total worst case is bounded, and every failure surfaces
// through the caller's error toast instead of dying silently.
async function fetchImageBlob(gid, url, attempts = 3) {
  if (!url) return null;
  const TMO = 12000;
  const tries = [
    () => fetch("/img-proxy?u=" + encodeURIComponent(url), { signal: AbortSignal.timeout(TMO) }),
    () => fetch(url, { mode: "cors", signal: AbortSignal.timeout(TMO) }),
  ];
  for (let a = 0; a < attempts; a++) {
    for (const go of tries) {
      try {
        const r = await go();
        if (!r.ok) continue;
        const blob = await r.blob();
        if (blob && blob.size) {
          // best-effort cache into IDB so future saves/offline are instant
          if (gid) { try { await imgPut(gid, blob); } catch (e) {} }
          return blob;
        }
      } catch (e) { /* timeout/CORS/network — try next route */ }
    }
    if (a < attempts - 1) await new Promise(res => setTimeout(res, 700 * (a + 1)));
  }
  return null;
}

// Header values must be ISO-8859-1 — prompts routinely contain "…", curly
// quotes, dashes, CJK, emoji etc., which made fetch throw "String contains
// non ISO-8859-1 code point" and every save fail. Base64-encode the UTF-8
// meta JSON so the header is always pure ASCII. (Server side decodes it.)
function b64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

// Save a blob to disk via /save-image. Returns {ok, path} or {ok:false, error}.
// Used by auto-save and the per-card "Save" action.
async function saveBlobToDisk(blob, meta) {
  if (!blob) return { ok: false, error: "no blob" };
  try {
    const folder = (state.settings.saveFolder || "").trim();
    const ext = (blob.type && /jpe?g/i.test(blob.type)) ? "jpg" : "png";
    const url = "/save-image" + (folder ? `?folder=${encodeURIComponent(folder)}` : "");
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream", "x-image-meta": b64Utf8(JSON.stringify({ ...(meta || {}), ext })) },
      body: blob
    });
    const j = await r.json();
    return j;
  } catch (e) { return { ok: false, error: e.message }; }
}

const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  reuse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v6h6M20 20v-6h-6M5.1 15a8 8 0 0 0 13.2 2M18.9 9A8 8 0 0 0 5.7 7"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5v14h14V8l-3-3H5Zm4 0v4h6V5M9 13h6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7h12Z"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>'
};

const st = slugs => slugs.map(s => ({ slug: s }));
const FULL_STYLES = ["dynamic", "creative", "fashion", "portrait", "portrait-cinematic", "portrait-fashion", "illustration", "3d-render", "acrylic", "game-concept", "graphic-design-2d", "graphic-design-3d", "pro-b-w-photography", "pro-color-photography", "pro-film-photography", "ray-traced", "stock-photo", "watercolor"];
const GPT2_STYLES = ["dynamic", "creative", "fashion", "illustration", "3d-render", "acrylic", "game-concept", "graphic-design-2d", "graphic-design-3d", "pro-b-w-photography", "pro-color-photography", "pro-film-photography", "ray-traced", "stock-photo", "watercolor"];
const GPT25_STYLES = ["dynamic", "cinematic", "creative", "fashion", "portrait", "portrait-cinematic", "portrait-fashion", "illustration", "3d-render", "acrylic", "game-concept", "graphic-design-2d", "graphic-design-3d", "pro-b-w-photography", "pro-color-photography", "pro-film-photography", "ray-traced", "stock-photo", "vibrant", "watercolor"];
const LUCID_STYLES = ["dynamic", "creative", "fashion", "portrait", "cinematic", "cinematic-close-up", "bokeh", "film", "food", "hdr", "long-exposure", "macro", "minimalist", "monochrome", "moody", "neutral", "retro", "stock-photo", "unprocessed", "vibrant"];
const SHORT_STYLES = ["dynamic", "creative", "fashion", "cinematic", "portrait", "stock-photo", "vibrant"];

const FALLBACK_MODELS = [
  { id: "nano-banana-2", display_name: "Nano Banana 2", enabled: true, supports_reference_images: true, max_reference_images: 6, qualities: ["1K", "2K", "4K"], ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], styles: st(FULL_STYLES) },
  { id: "gpt-image-2.5-sunburst", display_name: "GPT Image 2.5 Sunburst", enabled: true, supports_reference_images: true, max_reference_images: 6, qualities: ["low", "More Better"], ratios: ["1:1", "2:3", "3:2", "16:9", "9:16"], styles: st(GPT25_STYLES) },
  { id: "gpt-image-2.5-flare", display_name: "GPT Image 2.5 Flare", enabled: true, supports_reference_images: true, max_reference_images: 6, qualities: ["low", "More Better"], ratios: ["1:1", "2:3", "3:2", "16:9", "9:16"], styles: st(GPT25_STYLES) },
  { id: "gpt-image-2", display_name: "GPT Image 2", enabled: true, supports_reference_images: true, max_reference_images: 6, qualities: ["low", "medium"], ratios: ["1:1", "2:3", "3:2", "16:9", "9:16"], styles: st(GPT2_STYLES) },
  { id: "flux-pro-2.0", display_name: "Flux 2.0 Pro", enabled: true, supports_reference_images: true, max_reference_images: 4, qualities: [], ratios: ["1:1", "2:3", "3:2", "16:9", "9:16"], styles: st(FULL_STYLES) },
  { id: "seedream-4.5", display_name: "Seedream 4.5", enabled: true, supports_reference_images: true, max_reference_images: 6, qualities: [], ratios: ["1:1", "2:3", "4:5", "16:9", "21:9", "2:1"], styles: st(SHORT_STYLES) }
];

// Only these models are shown in the app.
const ALLOWED_MODELS = new Set(["nano-banana-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2", "flux-pro-2.0", "seedream-4.5"]);

// GPT Image 2.5 guardrails: 1 image per generation + 10s between generations.
const GPT25_IDS = new Set(["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]);
const GPT25_COOLDOWN_MS = 10000;
let gpt25CooldownUntil = 0;
let gpt25CooldownTimer = null;
let gpt25Busy = false;
function isGPT25(id) { return !!id && GPT25_IDS.has(id); }
function gpt25RemainingMs() { return Math.max(0, gpt25CooldownUntil - Date.now()); }
// Refresh the Generate button for the cooldown. Never fights the in-flight
// "busy" state — generate() owns the button while sending.
function refreshCooldownUI() {
  const btn = $("#btnGenerate");
  const label = $("#genLabel");
  if (!btn || !label) return;
  if (btn.classList.contains("busy")) return;
  const remaining = gpt25RemainingMs();
  const locked = state.model && isGPT25(state.model.id) && remaining > 0;
  btn.disabled = !!locked;
  label.textContent = locked ? `Wait ${Math.ceil(remaining / 1000)}s` : "Generate";
  if (remaining <= 0 && gpt25CooldownTimer) { clearInterval(gpt25CooldownTimer); gpt25CooldownTimer = null; }
}
function startGPT25Cooldown() {
  gpt25CooldownUntil = Date.now() + GPT25_COOLDOWN_MS;
  if (gpt25CooldownTimer) clearInterval(gpt25CooldownTimer);
  refreshCooldownUI();
  gpt25CooldownTimer = setInterval(refreshCooldownUI, 500);
}

const state = {
  settings: { apiKeys: [], baseUrl: REAL_BASE, autoSave: true, saveFolder: "" },
  models: [],
  model: null,
  sel: { ratio: "1:1", quality: null, style: "", mode: "" },
  batch: 1,
  delayMs: 0,
  seq: false,
  refs: [],
  jobs: new Map(),
  history: [],
  gallerySearch: "",
  galleryTags: [],
  refSeq: 0,
  keyIdx: 0,
  sort: "newest"
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function prettySlug(slug) {
  const fixed = String(slug).replace(/\bb-w\b/g, "bw");
  const FIX = { bw: "B&W", "3d": "3D", "2d": "2D", hdr: "HDR" };
  return fixed.split("-").map(w => FIX[w] || w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function ratioBox(r) {
  const [a, b] = r.split(":").map(Number);
  const s = Math.min(28 / a, 18 / b);
  return `width:${Math.max(a * s, 5).toFixed(1)}px;height:${Math.max(b * s, 5).toFixed(1)}px`;
}

function arNum(ratio) {
  if (!ratio) return 1;
  const [a, b] = ratio.split(":").map(Number);
  return a && b ? a / b : 1;
}

// Round-robin: returns next API key (cycling), or "" if none set.
function nextKey() {
  const keys = state.settings.apiKeys || [];
  if (!keys.length) return { key: "", idx: -1 };
  // Resume rotation from where we left off (persisted), default 0.
  if (typeof state.keyIdx !== "number" || isNaN(state.keyIdx)) state.keyIdx = 0;
  const idx = state.keyIdx % keys.length;
  state.keyIdx = (state.keyIdx + 1) % keys.length;
  try { localStorage.setItem("imagine.keyIdx", String(state.keyIdx)); } catch (e) {}
  return { key: keys[idx], idx };
}

function keyIdxOf(key) {
  if (key === undefined || key === null) return -1;
  // key can be an object {key, idx} from nextKey, or a raw string
  if (typeof key === "object") return key.idx;
  // Use the LAST occurrence so duplicate keys map to their real (later) position.
  const idx = (state.settings.apiKeys || []).lastIndexOf(key);
  return idx;
}

// ---- Request log ----
const reqLog = [];
function logReq(method, path, keyIdx, status, extra) {
  const t = new Date();
  const ts = t.toTimeString().slice(0, 8);
  const keyLabel = keyIdx >= 0 ? `k${keyIdx + 1}` : "none";
  reqLog.push({ ts, method, path, key: keyLabel, status, extra: extra || "" });
  if (reqLog.length > 500) reqLog.shift();
  renderReqLog();
}
function renderReqLog() {
  const box = $("#reqLogBody");
  if (!box) return;
  const logEl = $("#reqLog");
  if (logEl) logEl.hidden = reqLog.length === 0;
  const countEl = $("#reqLogCount");
  if (countEl) countEl.textContent = reqLog.length;
  box.innerHTML = "";
  reqLog.forEach(r => {
    const cls = r.status < 300 ? "rl-ok" : (r.status === 429 ? "rl-warn" : "rl-err");
    const row = document.createElement("div");
    row.className = `rl-row ${cls}`;
    row.innerHTML = `<span class="rl-time">${r.ts}</span><span class="rl-method">${r.method}</span><span class="rl-key">${esc(r.key)}</span><span class="rl-status">${r.status}</span><span class="rl-path">${esc(r.path)}${r.extra ? " · " + esc(r.extra) : ""}</span>`;
    box.appendChild(row);
  });
  box.scrollTop = box.scrollHeight;
}
$("#btnClearLog")?.addEventListener("click", () => { reqLog.length = 0; renderReqLog(); });

async function api(path, opts = {}) {
  const base = state.settings.baseUrl.replace(/\/+$/, "");
  const headers = { ...(opts.headers || {}) };
  // Explicit key (for parallel batch) wins; otherwise rotate round-robin.
  let keyObj;
  if (opts._key !== undefined) {
    keyObj = { key: opts._key, idx: opts._keyIdx !== undefined ? opts._keyIdx : keyIdxOf(opts._key) };
  } else keyObj = nextKey();
  const key = keyObj ? keyObj.key : "";
  if (key) headers.Authorization = `Bearer ${key}`;
  const { _key, _keyIdx, ...fetchOpts } = opts;
  let res;
  try {
    res = await fetch(base + path, { ...fetchOpts, headers });
  } catch (e) {
    logReq(opts.method || "GET", path, keyObj && keyObj.idx, 0, "network error");
    throw new ApiError(0, "Network error — check your connection or API base URL.");
  }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  const errDetail = (!res.ok && (data.error || data.message)) ? String(data.error || data.message).slice(0, 80) : "";
  logReq(opts.method || "GET", path, keyObj && keyObj.idx, res.status, errDetail);
  if (!res.ok) {
    const msg = data.error || data.message || `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data;
}

function setConn(mode) {
  const el = $("#connStatus");
  el.classList.remove("is-live", "is-off");
  const label = el.querySelector(".conn-label");
  if (mode === "live") { el.classList.add("is-live"); label.textContent = "Live"; }
  else if (mode === "off") { el.classList.add("is-off"); label.textContent = "Offline"; }
  else if (mode === "nokey") { label.textContent = "No key"; }
  else label.textContent = "Idle";
}

// `ms` controls how long the toast stays up. Several call sites already passed a
// third argument (export/re-import summaries) that used to be dropped silently.
function toast(msg, type = "info", ms = 4200) {
  const t = document.createElement("div");
  t.className = `toast t-${type}`;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 320);
  }, Math.max(600, ms));
}

function apiErrorToast(e) {
  if (e.status === 401) { toast("Invalid or missing API key.", "error"); openSettings(); }
  else if (e.status === 402) toast("Insufficient credits or no active subscription.", "error");
  else if (e.status === 403) toast("This model requires a higher plan tier.", "error");
  else if (e.status === 429) toast("Rate limit reached — slow down a little.", "error");
  else toast(e.message || "Something went wrong.", "error");
}

async function loadModels() {
  if (!state.settings.apiKeys.length) { setConn("nokey"); openSettings(); return; }
  try {
    const data = await api("/api/public/v1/models");
    const list = (data.models || []).filter(m => m.enabled !== false && m.id && ALLOWED_MODELS.has(m.id));
    if (!list.length) throw new ApiError(500, "No models available.");
    state.models = list;
    setConn("live");
  } catch (e) {
    if (e.status === 401) { setConn("off"); apiErrorToast(e); return; }
    state.models = FALLBACK_MODELS.filter(m => ALLOWED_MODELS.has(m.id));
    setConn(e.status === 0 ? "off" : "live");
    if (e.status !== 401) toast(`Could not fetch models (${e.message}). Using offline catalogue.`, "error");
  }
  populateModels();
}

function populateModels() {
  const sel = $("#modelSelect");
  sel.innerHTML = "";
  state.models.forEach(m => {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.display_name || m.id;
    sel.appendChild(o);
  });
  const saved = localStorage.getItem(LS.model);
  const pick = state.models.find(m => m.id === saved) ? saved : state.models[0].id;
  sel.value = pick;
  applyModel();
}

function currentModel() {
  return state.models.find(m => m.id === $("#modelSelect").value) || state.models[0];
}

function applyModel() {
  const m = currentModel();
  state.model = m;
  localStorage.setItem(LS.model, m.id);

  const prev = state.sel;
  state.sel = {
    ratio: m.ratios.includes(prev.ratio) ? prev.ratio : (m.ratios.includes("1:1") ? "1:1" : m.ratios[0]),
    quality: m.qualities && m.qualities.length ? (m.qualities.includes(prev.quality) ? prev.quality : m.qualities[0]) : null,
    style: "",
    mode: ""
  };

  const refsOk = !!m.supports_reference_images;
  $("#refsPanel").hidden = !refsOk;
  if (refsOk) {
    const max = m.max_reference_images || 6;
    if (state.refs.length > max) {
      state.refs.slice(max).forEach(r => URL.revokeObjectURL(r.url));
      state.refs = state.refs.slice(0, max);
      toast(`Trimmed references to fit ${m.display_name} (max ${max}).`, "info");
    }
    syncRefUI();
  }

  $("#modelHint").textContent = refsOk ? `up to ${m.max_reference_images || 6} refs` : "no references";
  // GPT Image 2.5 is single-image only: force batch 1 when selected.
  if (isGPT25(m.id) && state.batch !== 1) {
    state.batch = 1;
    try { localStorage.setItem(LS.batch, "1"); } catch (e) {}
  }
  renderOptionGroups();
  syncBatchUI();
  refreshCooldownUI();
}

function renderOptionGroups() {
  const m = state.model;
  renderChips($("#ratioChips"), m.ratios.map(r => ({ value: r, label: r, shape: ratioBox(r) })), state.sel.ratio, v => { state.sel.ratio = v; });

  const qp = $("#qualityPanel");
  if (m.qualities && m.qualities.length) {
    qp.hidden = false;
    renderChips($("#qualityChips"), m.qualities.map(q => ({ value: q, label: q })), state.sel.quality, v => { state.sel.quality = v; });
  } else qp.hidden = true;

  const modes = m.modes || [];
  const mp = $("#modePanel");
  if (modes.length) {
    mp.hidden = false;
    renderChips($("#modeChips"), [{ value: "", label: "Standard" }, ...modes.map(x => ({ value: x, label: prettySlug(x) }))], state.sel.mode, v => { state.sel.mode = v; });
  } else mp.hidden = true;

  const sp = $("#stylePanel");
  const styles = m.styles || [];
  if (styles.length) {
    sp.hidden = false;
    const opts = [{ value: "", label: "Default" }];
    if (styles.some(s => s.slug === "none")) opts.push({ value: "none", label: "None" });
    styles.forEach(s => opts.push({ value: s.slug, label: s.name || prettySlug(s.slug) }));
    renderChips($("#styleChips"), opts, state.sel.style, v => { state.sel.style = v; });
  } else sp.hidden = true;
}

function renderChips(container, items, activeVal, onPick) {
  container.innerHTML = "";
  items.forEach(o => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (o.value === activeVal ? " active" : "");
    if (o.shape) b.innerHTML = `<span class="shape" style="${o.shape}"></span>${esc(o.label)}`;
    else b.textContent = o.label;
    b.addEventListener("click", () => {
      container.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      b.classList.add("active");
      onPick(o.value);
    });
    container.appendChild(b);
  });
}

function syncBatchUI() {
  // GPT Image 2.5 is locked to 1 image per generation.
  const locked1 = state.model && isGPT25(state.model.id);
  const n = locked1 ? 1 : Math.max(1, Math.min(4, state.batch || 1));
  if (locked1) state.batch = 1;
  document.querySelectorAll("#batchChips .chip").forEach(c => {
    const v = parseInt(c.dataset.batch, 10);
    c.classList.toggle("active", v === n);
    c.disabled = !!locked1 && v !== 1;
    c.title = (locked1 && v !== 1) ? "GPT Image 2.5 allows 1 image per generation" : "";
  });
  localStorage.setItem(LS.batch, String(n));
  const d = $("#delayInput");
  if (d) d.value = state.delayMs || 0;
  const sq = $("#seqToggle");
  if (sq) sq.checked = !!state.seq;
  // When batch is 2+, queue is auto-forced (account allows ~1 concurrent); reflect that.
  const hint = $("#batchModeHint");
  if (hint) hint.textContent = locked1 ? "1 image only · 10s cooldown" : (n >= 2 ? "Queue auto-enabled (2+ images)" : (state.seq ? "Queue on" : "Parallel"));
  if (sq) sq.disabled = n >= 2;
}

// The account allows only ~1 concurrent generation (server: "Concurrency limit
// exceeded"). So any batch of 2+ must run one at a time; only batch 1 can run solo.
function shouldQueue(n) {
  return n >= 2 || !!state.seq;
}

document.querySelectorAll("#batchChips .chip").forEach(c => {
  c.addEventListener("click", () => {
    const want = parseInt(c.dataset.batch, 10) || 1;
    if (state.model && isGPT25(state.model.id) && want !== 1) {
      toast("GPT Image 2.5 allows 1 image per generation.", "info");
      return;
    }
    state.batch = want;
    syncBatchUI();
  });
});

$("#delayInput")?.addEventListener("input", e => {
  const v = parseInt(e.target.value, 10);
  state.delayMs = (v >= 0 && v <= 60000) ? v : 0;
  localStorage.setItem(LS.delay, String(state.delayMs));
});

$("#seqToggle")?.addEventListener("change", e => {
  state.seq = e.target.checked;
  localStorage.setItem(LS.seq, state.seq ? "1" : "0");
});

function syncRefUI() {
  const m = state.model;
  const max = (m && m.supports_reference_images) ? (m.max_reference_images || 6) : 6;
  $("#refCountLabel").textContent = `${state.refs.length} / ${max}`;
  $("#dropzone").classList.toggle("disabled", state.refs.length >= max);
  const box = $("#refThumbs");
  box.innerHTML = "";
  state.refs.forEach((r, i) => {
    const d = document.createElement("div");
    d.className = `ref-thumb st-${r.status}`;
    d.title = esc(r.name) + (r.error ? ` — ${esc(r.error)}` : "");
    d.innerHTML = `<img src="${r.url}" alt=""><button type="button" class="ref-rm" aria-label="Remove">&times;</button>${r.status === "uploading" ? '<span class="ref-spin"></span>' : ""}`;
    d.querySelector(".ref-rm").addEventListener("click", () => removeRef(i));
    box.appendChild(d);
  });
}

function removeRef(i) {
  const r = state.refs[i];
  if (r) URL.revokeObjectURL(r.url);
  state.refs.splice(i, 1);
  syncRefUI();
}

function addFiles(files) {
  const m = state.model;
  if (!m || !m.supports_reference_images) return;
  const max = m.max_reference_images || 6;
  let room = max - state.refs.length;
  const imgs = [...files].filter(f => f.type.startsWith("image/"));
  if (!imgs.length) return;
  for (const f of imgs) {
    if (room <= 0) { toast(`${m.display_name} accepts up to ${max} references.`, "info"); break; }
    if (f.size > 10 * 1024 * 1024) { toast(`"${f.name}" exceeds 10 MB.`, "error"); continue; }
    const entry = { localId: ++state.refSeq, url: URL.createObjectURL(f), file: f, name: f.name, status: "uploading", imageId: null, uploadedAt: 0, error: "" };
    state.refs.push(entry);
    room--;
    uploadRef(entry, f);
  }
  syncRefUI();
}

async function uploadRef(entry, file) {
  try {
    const fd = new FormData();
    fd.append("image", file);
    const base = state.settings.baseUrl.replace(/\/+$/, "");
    const keyObj = nextKey();
    const key = keyObj.key;
    const res = await fetch(base + "/api/public/v1/upload", {
      method: "POST",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Upload failed (${res.status})`);
    entry.imageId = data.image_id;
    entry.status = "ready";
    entry.uploadedAt = Date.now();
  } catch (e) {
    entry.status = "error";
    entry.error = e.message;
    toast(`Reference upload failed: ${e.message}`, "error");
  }
  if (state.refs.includes(entry)) syncRefUI();
}

function readyRefIds() {
  return state.refs.filter(r => r.status === "ready").map(r => r.imageId);
}

// Re-upload refs. When `key` is passed, re-upload ALL refs with that key (to
// guarantee the ref is scoped to the same key that will generate), regardless of
// age. Without a key, only stale (older than REF_MAX_AGE_MS) refs are re-uploaded.
// Returns true if all refs are valid afterwards.
async function refreshRefs(key) {
  const stale = key
    ? state.refs.filter(r => r.status === "ready" && r.file)
    : state.refs.filter(r => r.status === "ready" && r.file && (Date.now() - (r.uploadedAt || 0) > REF_MAX_AGE_MS));
  if (!stale.length) return true;
  await Promise.all(stale.map(async r => {
    r.status = "uploading";
    r.error = "";
    syncRefUI();
    try {
      const fd = new FormData();
      fd.append("image", r.file);
      const base = state.settings.baseUrl.replace(/\/+$/, "");
      // Use the provided key (job's pinned key) if given, else rotate.
      const useKey = key || nextKey().key;
      const res = await fetch(base + "/api/public/v1/upload", {
        method: "POST",
        headers: useKey ? { Authorization: `Bearer ${useKey}` } : {},
        body: fd
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || `Upload failed (${res.status})`);
      r.imageId = data.image_id;
      r.status = "ready";
      r.uploadedAt = Date.now();
    } catch (e) {
      r.status = "error";
      r.error = e.message;
    }
    if (state.refs.includes(r)) syncRefUI();
  }));
  return state.refs.filter(r => r.status === "ready").length === state.refs.filter(r => r.file).length;
}

function syncChar() {
  $("#charCount").textContent = `${$("#promptInput").value.length} / ${MAX_PROMPT}`;
}

function refreshEmpty() {
  $("#emptyState").hidden = $("#gallery").children.length > 0;
  const n = $("#gallery").querySelectorAll(".card.done").length;
  $("#galleryCount").textContent = n ? `· ${n}` : "";
}

// Rebuild the gallery from history in the chosen sort order (preserving active jobs).
function renderGallery() {
  const gallery = $("#gallery");
  // Defensive cleanup: drop any skeleton/err card that has no data-job at all
  // (legacy orphans from earlier buggy sessions) and any whose job no longer exists.
  [...gallery.querySelectorAll(".card.skeleton, .card.err")].forEach(c => {
    const jid = c.dataset.job;
    if (!jid || !state.jobs.has(jid)) c.remove();
  });
  // Keep only skeletons whose job is still live; drop orphaned ghost skeletons.
  // A real skeleton always has data-job (set in buildSkeleton), so a missing jid
  // is itself evidence of an orphan — drop it instead of preserving it.
  const active = [...gallery.querySelectorAll(".card.skeleton, .card.err")].filter(c => {
    const jid = c.dataset.job;
    return jid && state.jobs.has(jid);
  });
  // Remove only done/expired cards (the ones derived from history), keep active jobs.
  // Revoke each card's blob: URL first — renderGallery runs on every sort change
  // and search keystroke, so dropping cards without revoking leaked one object
  // URL per locally-cached image every time.
  [...gallery.querySelectorAll(".card.done, .card.expired")].forEach(c => {
    if (c._revokeLocal) { try { c._revokeLocal(); } catch (e) {} }
    c.remove();
  });
  // Apply search + tag filters to history
  const q = (state.gallerySearch || "").trim().toLowerCase();
  const activeTags = state.galleryTags || [];  // array of tag strings (all must match)
  const filtered = state.history.filter(rec => {
    if (q && !(rec.prompt || "").toLowerCase().includes(q) && !(rec.model || "").toLowerCase().includes(q)) return false;
    if (activeTags.length && !activeTags.every(t => (rec.tags || []).includes(t))) return false;
    return true;
  });
  const frag = document.createDocumentFragment();
  const sorted = [...filtered].sort((a, b) => state.sort === "oldest" ? a.ts - b.ts : b.ts - a.ts);
  sorted.forEach(rec => {
    try {
      const card = buildDoneCard(rec);
      renderCardTags(card, rec);
      frag.appendChild(card);
    } catch (e) {
      // One bad record should never break the whole gallery. Log + skip it.
      console.warn("Skipping bad gallery record", rec?.gid || rec, e);
    }
  });
  // Active jobs stay on top (they're in progress).
  active.forEach(c => frag.appendChild(c));
  gallery.appendChild(frag);
  const countEl = $("#galleryCount");
  if (countEl) countEl.textContent = filtered.length === state.history.length
    ? ` · ${state.history.length}`
    : ` · ${filtered.length} of ${state.history.length}`;
  refreshEmpty();
}

// Render tag chips inside a card's [data-tags] container.
function renderCardTags(card, rec) {
  const container = card.querySelector("[data-tags]");
  if (!container) return;
  container.innerHTML = "";
  (rec.tags || []).forEach(t => {
    const tag = document.createElement("span");
    tag.className = "card-tag";
    tag.textContent = `#${t}`;
    tag.title = `Click to filter by #${t}`;
    tag.addEventListener("click", e => {
      e.stopPropagation();
      state.galleryTags = Array.from(new Set([...(state.galleryTags || []), t]));
      renderGallery();
      saveFilterState();
    });
    container.appendChild(tag);
  });
}

function buildSkeleton(job) {
  const el = document.createElement("article");
  el.className = "card skeleton";
  el.dataset.job = job.id;
  el.dataset.kind = "skeleton";
  el.style.setProperty("--ar", arNum(job.params.ratio));
  el.innerHTML = `<div class="sk-shimmer"></div>
    <div class="sk-info"><div class="sk-pct">0%</div><div class="sk-status">Composing</div></div>
    <div class="sk-bar"><span></span></div>`;
  return el;
}

function updateSkeleton(job, statusText) {
  const el = $("#gallery").querySelector(`[data-job="${job.id}"]`);
  if (!el) return;
  el.querySelector(".sk-pct").textContent = `${job.progress}%`;
  el.querySelector(".sk-bar span").style.width = `${job.progress}%`;
  // Show the actual server status if available, so user sees what's happening
  const rawStatus = job.status || "";
  const displayStatus = statusText ||
    (rawStatus === "polling" ? "Refining" :
     rawStatus === "processing" ? "Processing" :
     rawStatus === "queued" ? "Queued" :
     rawStatus === "pending" ? "Pending" :
     rawStatus ? rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1) : "Composing");
  el.querySelector(".sk-status").textContent = displayStatus;
}

function buildDoneCard(rec) {
  const el = document.createElement("article");
  el.className = "card done";
  el.dataset.kind = "done";
  if (rec.gid) el.dataset.gid = rec.gid;
  el._rec = rec;
  // Fresh cards (just generated) load eagerly — old history items can be lazy.
  const fresh = (Date.now() - (rec.ts || 0)) < 30000;
  // High-priority fetch for fresh cards, so the browser starts the download immediately.
  const fetchAttr = fresh ? 'fetchpriority="high"' : "";
  const loadingAttr = fresh ? "" : 'loading="lazy"';
  // Local blob (if cached) takes priority over CDN — instant render, no network.
  // Guard against malformed blobs (defensive — IDB corruption shouldn't happen
  // but verify before assuming so the gallery never gets stuck empty).
  let local = null, localUrl = "";
  if (rec._localBlob instanceof Blob) {
    try { localUrl = URL.createObjectURL(rec._localBlob); local = rec._localBlob; }
    catch (e) { local = null; localUrl = ""; }
  }
  // Try CDN-side thumbnail (Tencent COS image processing). Falls back to full URL
  // on error — for CDNs that don't support the param, the user just sees the full
  // image (no worse than before). For CDNs that do, gallery load is ~10x faster.
  const fullUrl = esc(rec.url);
  const thumbUrl = local ? "" : makeThumbUrl(rec.url, 512);
  const initialSrc = local ? localUrl : esc(thumbUrl);
  el.innerHTML = `
    <img alt="" ${loadingAttr} ${fetchAttr} decoding="async" src="${initialSrc}" data-full="${fullUrl}"${local ? ' data-local="1"' : ""}>
    <div class="card-veil"></div>
    <div class="card-actions">
      <button class="mini-btn" data-action="expand" title="View">${ICONS.expand}</button>
      <button class="mini-btn" data-action="copy-prompt" title="Copy prompt" aria-label="Copy prompt">${ICONS.copy}</button>
      <button class="mini-btn" data-action="reuse" title="Reuse prompt" aria-label="Reuse prompt">${ICONS.reuse}</button>
      <button class="mini-btn" data-action="savedisk" title="Save to disk">${ICONS.save}</button>
      <button class="mini-btn" data-action="download" title="Download">${ICONS.download}</button>
      <button class="mini-btn" data-action="delete" title="Remove">${ICONS.trash}</button>
    </div>
    <div class="card-meta">
      <p class="card-prompt">${esc(rec.prompt)}</p>
      <div class="card-row">
        <span class="tag gold">${esc(rec.model)}</span>
        <span class="tag dim-tag">${rec.w ? `${rec.w}×${rec.h}` : "···"}</span>
        ${rec.extra ? `<span class="tag">${esc(rec.extra)}</span>` : ""}
        <button class="tag tag-btn" data-action="addtag" title="Add tag">+ tag</button>
      </div>
      <div class="card-tags" data-tags></div>
    </div>`;
  if (local) {
    // Local blob: skip the network entirely. Mark as loaded immediately; the
    // decode happens inside URL.createObjectURL above. If the blob is corrupt
    // we still get an `error` event below.
    requestAnimationFrame(() => {
      const img = el.querySelector("img");
      if (img.complete && img.naturalWidth) {
        img.classList.add("loaded");
        if (!rec.w && img.naturalWidth) {
          rec.w = img.naturalWidth; rec.h = img.naturalHeight;
          el.querySelector(".dim-tag").textContent = `${rec.w}×${rec.h}`;
          saveHistory();
        }
      } else {
        img.addEventListener("load", () => {
          img.classList.add("loaded");
          if (!rec.w && img.naturalWidth) {
            rec.w = img.naturalWidth; rec.h = img.naturalHeight;
            el.querySelector(".dim-tag").textContent = `${rec.w}×${rec.h}`;
            saveHistory();
          }
        }, { once: true });
      }
    });
    // Free the object URL when the card is removed from the DOM.
    el._revokeLocal = () => { try { URL.revokeObjectURL(localUrl); } catch (e) {} };
    return el;
  }
  const img = el.querySelector("img");
  img.addEventListener("load", () => {
    img.classList.add("loaded");
    if (!rec.w && img.naturalWidth) {
      rec.w = img.naturalWidth;
      rec.h = img.naturalHeight;
      el.querySelector(".dim-tag").textContent = `${rec.w}×${rec.h}`;
      saveHistory();
    }
  });
  // If the thumb URL fails (CDN doesn't support the param), retry with the full URL.
  let attempts = 0;
  img.addEventListener("error", () => {
    attempts++;
    if (attempts === 1) { img.dataset.fallback = "1"; img.src = rec.url; return; }
    if (attempts === 2) {
      // Second failure (full URL also unreachable). Mark as expired and stop reloading.
      markExpired(el);
    }
  });
  // Safety net: if neither load nor error fires (stalled network, blob: URL quirk,
  // CSP-blocked event, or lazy-loaded image that hasn't entered the viewport yet),
  // mark the card as stalled so users see "Loading…" instead of an invisible card.
  // But CRITICALLY: if the image does eventually load, clear the stall flag.
  // Otherwise lazy-loaded images below the fold always show "Loading…" text on
  // top of the loaded image — which is the exact bug we're fixing.
  let imgResolved = false;
  const markStalled = () => { if (!imgResolved && !img.classList.contains("loaded") && el.dataset.kind === "done") el.dataset.loadStalled = "1"; };
  const clearStalled = () => { imgResolved = true; delete el.dataset.loadStalled; };
  img.addEventListener("load", clearStalled, { once: true });
  img.addEventListener("error", clearStalled, { once: true });
  setTimeout(markStalled, 3000);
  return el;
}

// Try CDN-side thumbnail transformation. If the CDN doesn't support it, the browser's
// <img> error event fires and we fall back to the full URL.
function makeThumbUrl(url, width) {
  if (!url) return url;
  // Tencent COS image processing — most CDNs from this provider accept it
  try {
    const u = new URL(url);
    // Strip any existing image-processing params
    u.searchParams.delete("imageMogr2");
    u.searchParams.delete("imageView2");
    u.searchParams.delete("x-oss-process");
    // Append COS thumbnail param (preserves aspect ratio)
    u.searchParams.set("imageMogr2", `thumbnail/${width}x`);
    return u.toString();
  } catch (e) {
    return url;
  }
}

function markExpired(el) {
  if (el.dataset.kind !== "done") return;
  const rec = el._rec || {};
  el.classList.remove("done");
  el.classList.add("expired");
  el.dataset.kind = "expired";
  // Preserve the card-actions trash icon (same delete affordance as a normal
  // card) so users can hover and click to remove, plus the centered "Reuse
  // prompt" / "Delete" buttons below.
  el.innerHTML = `<div class="card-actions">
      <button class="mini-btn" data-action="delete" title="Remove">${ICONS.trash}</button>
    </div>
    <div class="err-body">
      <div class="err-title">Link expired</div>
      <div class="err-msg">The hosted copy is gone or unreachable.</div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="text-btn" data-action="reuse">Reuse prompt</button>
        <button class="text-btn" data-action="delete" title="Remove from history">Delete</button>
      </div>
    </div>`;
}

function buildErrorCard(job, message) {
  const el = document.createElement("article");
  el.className = "card err";
  el.dataset.job = job.id;
  el.dataset.kind = "err";
  el.style.setProperty("--ar", arNum(job.params.ratio));
  const tag = keyTag(job.key);
  el.innerHTML = `<div class="err-body">
    <div class="err-title">Generation failed</div>
    <div class="err-msg">${esc(message)}</div>
    <div class="err-key">key ${esc(tag)}</div>
    <div style="display:flex;gap:8px">
      <button class="text-btn" data-action="retry">Retry</button>
      <button class="text-btn" data-action="delete">Dismiss</button>
    </div>
  </div>`;
  return el;
}

async function generate() {
  const prompt = $("#promptInput").value.trim();
  if (!state.settings.apiKeys.length) { openSettings(); return; }
  if (!prompt) { toast("Write a prompt first.", "info"); $("#promptInput").focus(); return; }
  if (state.refs.some(r => r.status === "uploading")) { toast("Still uploading references — one moment.", "info"); return; }
  // Record prompt in history (most-recent first, deduped, max 30)
  if (!state.promptHistory) state.promptHistory = loadPromptHistory();
  state.promptHistory = [prompt, ...state.promptHistory.filter(p => p !== prompt)].slice(0, 30);
  savePromptHistory();

  const m = state.model;
  // GPT Image 2.5: one at a time + 10s after each finishes
  // (per model, so other models stay usable).
  if (isGPT25(m.id)) {
    if (gpt25Busy) {
      toast("A GPT Image 2.5 image is still generating — hold on.", "info");
      return;
    }
    const remaining = gpt25RemainingMs();
    if (remaining > 0) {
      toast(`GPT Image 2.5 needs a breather — try again in ${Math.ceil(remaining / 1000)}s.`, "info");
      return;
    }
  }
  const n = isGPT25(m.id) ? 1 : Math.max(1, Math.min(4, state.batch || 1));
  // Re-upload stale references first so queued/retried jobs don't hit "expired".
  const refsOk = await refreshRefs();
  if (!refsOk) { toast("Some reference images failed to (re)upload — check them.", "error"); return; }
  // Mark in-flight only once we're really sending (after all validations pass).
  if (isGPT25(m.id)) gpt25Busy = true;
  const ids = readyRefIds();
  const params = {
    prompt,
    model: m.id,
    ratio: state.sel.ratio,
    quality: state.sel.quality || null,
    style: state.sel.style || null,
    mode: state.sel.mode || null,
    refIds: ids
  };

  const btn = $("#btnGenerate");
  btn.disabled = true;
  btn.classList.add("busy");
  $("#genLabel").textContent = isGPT25(m.id) ? "Generating…" : (n > 1 ? `Sending ${n}` : "Sending");
  try {
    const delay = Math.max(0, state.delayMs || 0);
    if (isGPT25(m.id)) {
      // Single-image: wait for it to finish, THEN start the 10s cooldown.
      // The button stays busy for the whole generation so a second request
      // can't slip through while the first is still running.
      await startJob(params, 0);
    } else if (shouldQueue(n)) {
      // Sequential: start next job only after previous one finishes.
      for (let i = 0; i < n; i++) {
        await startJob(params, i);
        // Re-fresh refs between jobs so later jobs don't use expired uploads.
        if (i < n - 1 && state.refs.some(r => r.file)) {
          const ok = await refreshRefs();
          if (ok) {
            const newIds = readyRefIds();
            if (newIds.length) params.refIds = newIds;
          }
        }
        if (i < n - 1 && delay > 0) await new Promise(r => setTimeout(r, delay));
      }
    } else {
      // Parallel (fire-and-forget; each manages its own card), optional stagger.
      for (let i = 0; i < n; i++) {
        startJob(params, i);
        if (i < n - 1 && delay > 0) await new Promise(r => setTimeout(r, delay));
      }
    }
  } catch (e) {
    // startJob handles its own failure cards; nothing extra needed here.
  } finally {
    btn.classList.remove("busy");
    // GPT 2.5 cooldown starts AFTER the image is done (success or fail), so
    // the 10s runs from completion, not from send time.
    if (isGPT25(m.id)) { gpt25Busy = false; startGPT25Cooldown(); }
    else { btn.disabled = false; $("#genLabel").textContent = "Generate"; }
  }
}

function keyTag(key) {
  return key ? key.slice(0, 8) : "none";
}

async function startJob(params, idx) {
  const keyObj = nextKey();
  const job = {
    id: "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    gid: null,
    params,
    key: keyObj.key,   // pin this job to its own key (round-robin)
    keyIdx: keyObj.idx,
    progress: 0,
    peakProgress: 0,    // for time-based stuck detection (regression detection)
    start: Date.now(),
    lastChangeAt: Date.now(),   // for time-based stuck detection in pollJob
    retries: 0,
    cancelled: false,
    done: null       // resolved when job finishes (success or fail) — used by seq mode
  };
  job.done = new Promise(res => { job._resolve = res; });
  state.jobs.set(job.id, job);
  const skel = buildSkeleton(job);
  // Tag the skeleton with the key position + tag so we can see which key each job used
  skel.setAttribute("data-key", (job.keyIdx >= 0 ? `k${job.keyIdx + 1}` : "none") + " · " + keyTag(job.key));
  $("#gallery").prepend(skel);
  refreshEmpty();

  const body = { model_id: params.model, prompt: params.prompt };
  if (params.ratio) body.ratio = params.ratio;
  if (params.quality) body.quality = params.quality;
  if (params.mode) body.mode = params.mode;
  if (params.style) body.style = params.style;

  const hasRefs = params.refIds.length && state.refs.some(r => r.file);

  // Upload refs fresh right before each generate attempt, so the ref TTL doesn't
  // expire during 429 backoff waits. Sets body.ref_image_ids.
  async function uploadRefsForAttempt() {
    if (!hasRefs) { if (params.refIds.length) body.ref_image_ids = params.refIds; return true; }
    updateSkeleton(job, "Uploading refs…");
    const ok = await refreshRefs(job.key);
    if (!ok) return false;
    const freshIds = readyRefIds();
    body.ref_image_ids = freshIds.length ? freshIds : params.refIds;
    return true;
  }

  if (!(await uploadRefsForAttempt())) {
    failJob(job, "Reference upload failed.");
    await job.done;
    return;
  }

  const MAX_RETRIES = 5;
  let refRetried = false;   // only re-upload refs once per job on expiry
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (job.cancelled || !state.jobs.has(job.id)) break;
    try {
      const data = await api("/api/public/v1/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        _key: job.key,
        _keyIdx: job.keyIdx
      });
      job.gid = data.generation_id;
      job.progress = 5;
      updateSkeleton(job);
      pollJob(job);
      break;
    } catch (e) {
      if (e.status === 429 && attempt < MAX_RETRIES && !job.cancelled) {
        job.retries = attempt + 1;
        const backoff = 2000 * (attempt + 1);  // 2s, 4s, 6s, 8s, 10s
        updateSkeleton(job, `429 retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, backoff));
        // Re-upload refs fresh after the wait — the old upload likely expired.
        if (hasRefs && !(await uploadRefsForAttempt())) {
          failJob(job, "Reference upload failed during retry.");
          break;
        }
        continue;
      }
      // Reference images expired server-side: re-upload them and retry ONCE.
      if (!refRetried && isRefExpiredError(e.message) && !job.cancelled && state.refs.some(r => r.file)) {
        refRetried = true;
        job.retries = attempt + 1;
        updateSkeleton(job, "Re-uploading refs…");
        const ok = await refreshRefs(job.key);
        if (ok) {
          const newIds = readyRefIds();
          if (newIds.length) body.ref_image_ids = newIds;
          await new Promise(r => setTimeout(r, 800));
          continue;
        }
      }
      failJob(job, e.message + (e.status ? ` (HTTP ${e.status})` : ""));
      apiErrorToast(e);
      break;
    }
  }
  // Safety: if the loop exited without resolving the job, fail it so it never hangs.
  if (state.jobs.has(job.id) && !job.cancelled && !job.gid) {
    failJob(job, "Generation failed after retries.");
  }
  // Wait for the job to reach a terminal state before returning (seq mode).
  await job.done;
}

// Heuristic for server-side reference-image expiry errors.
function isRefExpiredError(msg) {
  if (!msg) return false;
  const s = String(msg).toLowerCase();
  return s.includes("expired") || s.includes("ref") && (s.includes("invalid") || s.includes("not found") || s.includes("missing"));
}

function pollJob(job) {
  setTimeout(async () => {
    if (job.cancelled || !state.jobs.has(job.id)) return;
    if (Date.now() - job.start > 600000) { failJob(job, "Timed out after 10 minutes."); return; }
    try {
      const data = await api(`/api/public/v1/generate/${job.gid}`, { _key: job.key, _keyIdx: job.keyIdx });
      if (job.cancelled || !state.jobs.has(job.id)) return;
      const prevStatus = job.status;
      const prevProgress = job.progress;
      job.status = data.status;
      // Server sometimes reports progress:0 even for jobs that are valid and queued.
      // We optimistically set progress:5 after create (meaning we have a real gid),
      // so don't let the server's initial 0 overwrite our >0 progress.
      if (typeof data.progress === "number") {
        if (data.progress === 0 && job.progress > 0) {
          // Ignore the server's 0% — keep our optimistic value
        } else {
          job.progress = data.progress;
        }
      }
      // Track peak progress. If the server reports progress that drops below the
      // peak we've already seen, the generation was cancelled/restarted server-side.
      if (typeof job.progress === "number") {
        if (job.peakProgress == null || job.progress > job.peakProgress) {
          job.peakProgress = job.progress;
        }
      }
      // Time-based stuck detection: tracks wall-clock time since the last *forward* change.
      // Catches: (a) totally frozen (same status+progress every poll),
      // (b) creeping/bouncing (status/progress oscillating but never reaching new highs),
      // (c) regressions (progress drops back from 75% to 0% — server cancelled the job).
      // Threshold: 90s since the peak stopped moving. Generations can legitimately
      // plateau 30-60s mid-process at 4K/5K resolution; 90s gives those room to
      // complete while catching real hangs.
      // A change "counts" only if it doesn't regress the peak.
      if ((job.status !== prevStatus || job.progress !== prevProgress) &&
          (job.peakProgress == null || job.progress === job.peakProgress)) {
        job.lastChangeAt = Date.now();
      }
      const sinceChange = job.lastChangeAt ? Date.now() - job.lastChangeAt : 0;
      // Show "taking longer than usual" hint at 45s of no change.
      if (sinceChange > 45000 && sinceChange < 46000) {
        updateSkeleton(job, "Server is taking longer than usual...");
      }
      // Hard fail at 90s of no forward progress.
      if (sinceChange > 90000) {
        const stuckSec = Math.round(sinceChange / 1000);
        const regressed = job.peakProgress != null && job.progress < job.peakProgress;
        const msg = regressed
          ? `Server reset the generation after reaching ${job.peakProgress}% (now at ${job.progress}%). Likely rate-limited or cancelled server-side.`
          : `Generation stuck at ${job.progress || 0}% for ${stuckSec}s. The server isn't progressing this request.`;
        failJob(job, msg);
        return;
      }
      const urls = data.result_urls || data.urls || [];
      if (data.status === "completed" || data.status === "success") finishJob(job, urls);
      else if (data.status === "failed" || data.status === "cancelled") {
        failJob(job, data.error || "The generation was cancelled.");
      } else {
        updateSkeleton(job);
        pollJob(job);
      }
    } catch (e) {
      const status = e.status;
      const msg = e.message || "Poll failed.";
      // Server says the generation no longer exists / was cancelled / etc.
      if (status === 400 || status === 404 || status === 410) {
        failJob(job, msg + (status ? ` (HTTP ${status})` : ""));
        return;
      }
      if (job.retries < 5) {
        job.retries++;
        const backoff = 1500 * job.retries;   // 1.5s, 3s, 4.5s, 6s, 7.5s
        updateSkeleton(job, `Polling… retry ${job.retries}/5 (HTTP ${status || "err"})`);
        await new Promise(r => setTimeout(r, backoff));
        if (!job.cancelled && state.jobs.has(job.id)) pollJob(job);
      } else {
        failJob(job, msg + ` (HTTP ${status || "err"} after 5 retries)`);
      }
    }
  }, 800);
}

function finishJob(job, urls) {
  const old = $("#gallery").querySelector(`[data-job="${job.id}"]`);
  if (!old || !urls.length) { if (!urls.length) failJob(job, "Finished without an image."); return; }
  const rec = {
    gid: job.gid,
    url: urls[0],
    model: job.params.model,
    prompt: job.params.prompt,
    ratio: job.params.ratio,
    quality: job.params.quality,
    style: job.params.style,
    mode: job.params.mode,
    w: 0,
    h: 0,
    ts: Date.now(),
    extra: urls.length > 1 ? `+${urls.length - 1}` : "",
    tags: []  // user-added labels (e.g. ["hero", "instagram"])
  };
  state.jobs.delete(job.id);
  job._resolve && job._resolve();
  // Remove this job's skeleton card so it doesn't linger as a ghost.
  const sk = $("#gallery").querySelector(`[data-job="${job.id}"]`);
  if (sk) sk.remove();
  state.history.unshift(rec);
  trimHistory();
  saveHistory();
  // Fire-and-forget: cache the bytes locally so this image survives CDN expiry.
  // We don't await — the user sees the card instantly from the CDN, and the
  // local copy quietly becomes available for next time (and for offline use).
  (async () => {
    const blob = await cacheRemoteUrl(rec.gid, rec.url);
    if (blob) {
      rec._localBlob = blob;
      // Update the in-DOM card to use the blob (frees the network slot).
      const card = $("#gallery").querySelector(`[data-gid="${rec.gid}"]`);
      if (card) {
        try {
          const newUrl = URL.createObjectURL(blob);
          const img = card.querySelector("img");
          if (img) {
            img.dataset.local = "1";
            img.dataset.fallback = "1";  // skip the CDN error fallback chain
            img.src = newUrl;
            img.addEventListener("load", () => {
              img.classList.add("loaded");
              delete card.dataset.loadStalled;  // clear stalled overlay once blob loads
            }, { once: true });
          }
          // Register the revoke hook so renderGallery/removeCard can free this
          // URL later; previously this one URL outlived its card.
          const prevRevoke = card._revokeLocal;
          card._revokeLocal = () => {
            if (prevRevoke) { try { prevRevoke(); } catch (e) {} }
            try { URL.revokeObjectURL(newUrl); } catch (e) {}
          };
        } catch (e) {}
      }
      // Auto-save to disk if user opted in. Uses the local blob (no re-fetch).
      if (state.settings.autoSave) {
        rec._savePromise = saveBlobToDisk(blob, {
          gid: rec.gid, ts: rec.ts, prompt: rec.prompt, model: rec.model,
          ratio: rec.ratio, quality: rec.quality, style: rec.style,
          mode: rec.mode, tags: rec.tags || []
        }).then((r) => {
          if (r && r.ok) {
            rec.diskPath = r.path;
            saveHistory();
            toast(`Saved → ${r.path.split(/[\\/]/).slice(-2).join("/")}`, "info", 1800);
          } else if (r && r.error) {
            toast(`Auto-save failed: ${r.error}`, "error");
          }
          return r;
        }).catch(() => null).finally(() => { delete rec._savePromise; });
      }
    }
  })();
  // Auto-save is decoupled from the IDB cache above: the cache path quietly
  // no-ops on CDN hiccups (returns null → whole block, save included, skipped).
  // Run an independent resilient save so every generated image reaches disk
  // even when the proxy/cache fetch fails.
  if (state.settings.autoSave) {
    (async () => {
      // Small delay so the cache path (if healthy) usually wins; avoids double-save.
      await new Promise(r => setTimeout(r, 1200));
      if (rec.diskPath) return;   // cache-path save already succeeded
      const blob2 = rec._localBlob || await fetchImageBlob(rec.gid, rec.url);
      if (!blob2) { toast(`Auto-save: couldn't fetch image for "${(rec.prompt||"").slice(0,40)}…"`, "error"); return; }
      if (rec.diskPath) return;   // won the race while fetching
      const r = await saveBlobToDisk(blob2, {
        gid: rec.gid, ts: rec.ts, prompt: rec.prompt, model: rec.model,
        ratio: rec.ratio, quality: rec.quality, style: rec.style,
        mode: rec.mode, tags: rec.tags || []
      });
      if (r && r.ok) {
        rec.diskPath = r.path;
        saveHistory();
        toast(`Saved → ${r.path.split(/[\\/]/).slice(-2).join("/")}`, "info", 1800);
      } else if (r && r.error) {
        toast(`Auto-save failed: ${r.error}`, "error");
      }
    })();
  }
  // Fast path: insert the new card at the top instead of rebuilding the whole gallery.
  // A full re-render is only needed on sort changes or page load.
  const gallery = $("#gallery");
  const card = buildDoneCard(rec);
  gallery.insertBefore(card, gallery.firstChild);
  refreshEmpty();
}

function failJob(job, message) {
  const old = $("#gallery").querySelector(`[data-job="${job.id}"]`);
  state.jobs.delete(job.id);
  job._resolve && job._resolve();
  if (!old) return;
  old.replaceWith(buildErrorCard(job, message));
  refreshEmpty();
}

async function removeCard(card) {
  const jid = card.dataset.job;
  const job = state.jobs.get(jid);
  if (job) { job.cancelled = true; job._resolve && job._resolve(); }
  state.jobs.delete(jid);
  const rec = card._rec;
  if (rec?.gid) {
    // A user can delete immediately after generation; wait for auto-save so it
    // cannot recreate the files after this deletion completes.
    if (rec._savePromise) await rec._savePromise;
    const folder = (state.settings.saveFolder || "").trim();
    const qs = new URLSearchParams({ gid: rec.gid });
    if (folder) qs.set("folder", folder);
    if (rec.diskPath) qs.set("path", rec.diskPath);
    try {
      const response = await fetch(`/delete-saved?${qs}`, { method: "POST" });
      const body = await response.text();
      let result = null;
      try { result = JSON.parse(body); } catch (e) {}
      if (!response.ok || !result?.ok) {
        const detail = result?.error || body.trim() || response.statusText || "unknown server response";
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }
      if (result.deleted) toast("Deleted image and metadata from disk.", "success");
    } catch (e) {
      toast(`Could not delete saved files: ${e.message}`, "error");
      return;
    }
  }
  // Free any blob URL before we drop the card, and delete its IDB copy so we
  // don't leak storage.
  if (card._revokeLocal) { try { card._revokeLocal(); } catch (e) {} }
  const gid = card.dataset.gid;
  if (gid) {
    const i = state.history.findIndex(h => h.gid === gid);
    if (i >= 0) { state.history.splice(i, 1); saveHistory(); }
    imgDel(gid);
  }
  card.remove();
  refreshEmpty();
}

// Edit a finished image (browser-native download via anchor)
async function downloadImage(card) {
  const rec = card._rec || {};
  const url = rec.url || card.dataset.url;
  if (!url) return;
  const name = `imagine_${rec.model || "image"}_${new Date(rec.ts || Date.now()).toISOString().replace(/[:.]/g, "-")}.png`;
  try {
    const blob = await fetch(url).then(r => { if (!r.ok) throw new Error(); return r.blob(); });
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
    toast("Image downloaded.", "success");
  } catch (e) {
    window.open(url, "_blank");
  }
}

// Save a single card to disk via the user's chosen folder. Uses the local
// IDB blob if present (instant, no network); otherwise re-fetches via proxy.
async function saveCardToDisk(card) {
  const rec = card._rec || {};
  if (!rec.gid) { toast("Cannot save: missing record.", "error"); return; }
  let blob = rec._localBlob || null;
  if (!blob) blob = await fetchImageBlob(rec.gid, rec.url);   // resilient: retries + direct fallback
  if (!blob) { toast("Cannot save: image unreachable (link may have expired).", "error"); return; }
  const r = await saveBlobToDisk(blob, {
    gid: rec.gid, ts: rec.ts, prompt: rec.prompt, model: rec.model,
    ratio: rec.ratio, quality: rec.quality, style: rec.style,
    mode: rec.mode, tags: rec.tags || []
  });
  if (r && r.ok) {
    rec.diskPath = r.path;
    saveHistory();
    toast(`Saved → ${r.path.split(/[\\/]/).slice(-2).join("/")}`, "success");
  }
  else toast(`Save failed: ${r && r.error || "unknown"}`, "error");
}

// Bulk-export every locally-cached card to disk. Goes silently in the
// background; reports a single summary toast at the end.
async function exportAllToDisk() {
  const total = state.history.length;
  if (!total) { toast("Gallery is empty.", "info"); return; }
  let saved = 0, skipped = 0, failed = 0;
  toast(`Exporting ${total} images…`, "info", 2000);
  for (const rec of state.history) {
    try {
      if (!rec.gid) { skipped++; continue; }
      let blob = rec._localBlob || null;
      if (!blob) blob = await fetchImageBlob(rec.gid, rec.url);
      if (!blob) { skipped++; continue; }
      const r = await saveBlobToDisk(blob, {
        gid: rec.gid, ts: rec.ts, prompt: rec.prompt, model: rec.model,
        ratio: rec.ratio, quality: rec.quality, style: rec.style,
        mode: rec.mode, tags: rec.tags || []
      });
      if (r && r.ok) saved++; else failed++;
    } catch (e) { failed++; }
  }
  toast(`Export done — ${saved} saved, ${skipped} skipped, ${failed} failed`, saved ? "success" : "error", 3000);
}

function fillAndGenerate(p) {
  $("#promptInput").value = p.prompt || "";
  syncChar();
  if (p.model && state.models.some(m => m.id === p.model)) $("#modelSelect").value = p.model;
  applyModel();
  const m = state.model;
  state.sel.ratio = m.ratios.includes(p.ratio) ? p.ratio : state.sel.ratio;
  if (m.qualities && m.qualities.length) state.sel.quality = m.qualities.includes(p.quality) ? p.quality : m.qualities[0];
  state.sel.style = (m.styles || []).some(s => s.slug === p.style) ? p.style : "";
  state.sel.mode = (m.modes || []).includes(p.mode) ? p.mode : "";
  renderOptionGroups();
  generate();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function reusePrompt(rec) {
  const input = $("#promptInput");
  input.value = rec?.prompt || "";
  syncChar();
  input.focus();
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  toast("Prompt loaded — edit it or generate again.", "success");
}

async function copyPrompt(rec) {
  const promptText = rec?.prompt || "";
  if (!promptText) { toast("This image has no saved prompt.", "error"); return; }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(promptText);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = promptText;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      if (!document.execCommand("copy")) throw new Error("Copy unavailable");
      textarea.remove();
    }
    toast("Prompt copied to clipboard.", "success");
  } catch (e) {
    toast("Could not copy the prompt.", "error");
  }
}

$("#gallery").addEventListener("click", e => {
  const card = e.target.closest(".card");
  if (!card) return;
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (card.dataset.kind === "done" && (!action || action === "expand")) { openLightbox(card); return; }
  if (action === "download") downloadImage(card);
  else if (action === "copy-prompt") copyPrompt(card._rec);
  else if (action === "savedisk") saveCardToDisk(card);
  else if (action === "delete") removeCard(card);
  else if (action === "retry") {
    const job = state.jobs.get(card.dataset.job);
    if (job) { removeCard(card); fillAndGenerate(job.params); }
    else removeCard(card);
  } else if (action === "reuse") {
    const rec = card._rec;
    if (rec) reusePrompt(rec);
  } else if (action === "addtag") {
    const rec = card._rec;
    if (!rec) return;
    const tag = prompt("Tag this image (e.g. hero, instagram, product):", "");
    if (!tag) return;
    const t = tag.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!t) return;
    rec.tags = rec.tags || [];
    if (!rec.tags.includes(t)) {
      rec.tags.push(t);
      saveHistory();
      renderCardTags(card, rec);
    }
  }
});

// Search input
$("#gallerySearch")?.addEventListener("input", e => {
  state.gallerySearch = e.target.value;
  renderGallery();
  saveFilterState();
});

const MAX_HISTORY = 120;
// Truncating state.history alone orphaned the dropped records' IndexedDB blobs
// forever (imgDel only ran on explicit card deletion), so the store grew without
// bound. Drop the blobs for whatever falls off the end.
function trimHistory() {
  if (state.history.length <= MAX_HISTORY) return;
  const dropped = state.history.splice(MAX_HISTORY);
  dropped.forEach(rec => { if (rec && rec.gid) imgDel(rec.gid); });
}

let saveHistoryTimer = null;
function historyJson() {
  // Blob values cannot be represented in JSON, and persisting the hydration
  // flag makes the next page load skip IndexedDB even though the Blob became
  // a plain `{}`. Keep those two fields session-only.
  return JSON.stringify(state.history, (key, value) =>
    key === "_localBlob" || key === "_localHydrated" || key === "_savePromise" ? undefined : value
  );
}
function saveHistory() {
  // Debounce: batch rapid calls (e.g., 50 images loading at once) into one write.
  clearTimeout(saveHistoryTimer);
  saveHistoryTimer = setTimeout(() => {
    let payload = "[]";
    try { payload = historyJson(); localStorage.setItem(LS.hist, payload); } catch (e) {}
    // Mirror to IDB so a localStorage wipe can still be recovered.
    try { kvPut("history", payload); } catch (e) {}
  }, 500);
}

// Persist gallery filter (search + tags) so refresh doesn't reset it.
let saveFilterTimer = null;
function saveFilterState() {
  clearTimeout(saveFilterTimer);
  saveFilterTimer = setTimeout(() => {
    try {
      localStorage.setItem("imagine.gallerySearch", state.gallerySearch || "");
      localStorage.setItem("imagine.galleryTags", JSON.stringify(state.galleryTags || []));
    } catch (e) {}
  }, 300);
}

// ---- Prompt history (last 30 prompts, most-recent first) ----
function loadPromptHistory() {
  try { return JSON.parse(localStorage.getItem(LS.promptHistory) || "[]"); }
  catch (e) { return []; }
}
function savePromptHistory() {
  try { localStorage.setItem(LS.promptHistory, JSON.stringify(state.promptHistory || [])); }
  catch (e) {}
  try { kvPut("promptHistory", JSON.stringify(state.promptHistory || [])); } catch (e) {}
}
function renderPromptHistory() {
  const wrap = $("#promptHistory");
  if (!wrap) return;
  wrap.innerHTML = "";
  const items = state.promptHistory || [];
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "prompt-history-empty";
    empty.textContent = "No recent prompts yet";
    wrap.appendChild(empty);
  } else {
    items.forEach(p => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "prompt-history-item";
      b.textContent = p;
      b.title = p;
      b.addEventListener("click", () => {
        $("#promptInput").value = p;
        syncChar();
        closePromptHistory();
        $("#promptInput").focus();
      });
      wrap.appendChild(b);
    });
    const clr = document.createElement("button");
    clr.type = "button";
    clr.className = "prompt-history-clear";
    clr.textContent = "Clear history";
    clr.addEventListener("click", () => {
      if (!state.promptHistory.length) return;
      if (!confirm("Clear all saved prompts? This empties the ▾ dropdown. Your gallery is unaffected, but you'll lose the ability to re-run past prompts in one click. Continue?")) return;
      state.promptHistory = [];
      savePromptHistory();
      renderPromptHistory();
    });
    wrap.appendChild(clr);
  }
}
function openPromptHistory() {
  renderPromptHistory();
  $("#promptHistory").hidden = false;
  $("#promptHistoryBtn").classList.add("open");
}
function closePromptHistory() {
  $("#promptHistory").hidden = true;
  $("#promptHistoryBtn").classList.remove("open");
}
$("#promptHistoryBtn")?.addEventListener("click", e => {
  e.stopPropagation();
  const wrap = $("#promptHistory");
  if (wrap.hidden) openPromptHistory(); else closePromptHistory();
});
document.addEventListener("click", e => {
  if (!e.target.closest(".prompt-row")) closePromptHistory();
});

function renderHistory() {
  try { state.history = JSON.parse(localStorage.getItem(LS.hist) || "[]"); } catch (e) { state.history = []; }
  // Older versions accidentally serialized these runtime-only properties.
  // In particular `_localHydrated: true` survived while the Blob did not,
  // causing every later startup to skip local restoration permanently.
  state.history.forEach(rec => {
    delete rec._localBlob;
    delete rec._localHydrated;
  });
  renderGallery();
  // Async: attach any IndexedDB-cached blobs so locally-cached cards show
  // instantly without re-fetching the (possibly dead) CDN URL.
  hydrateLocalBlobs();
}

// For every history record, look up a cached blob in IDB and re-render the card.
// Skips any record that has already been hydrated this session.
async function hydrateLocalBlobs() {
  const gallery = $("#gallery");
  for (const rec of state.history) {
    // Only a real in-memory Blob means hydration is complete. Never trust a
    // persisted boolean from an older build.
    if (!rec.gid || rec._localBlob instanceof Blob) continue;
    const entry = await imgGet(rec.gid);
    if (!entry || !(entry.blob instanceof Blob)) continue;
    rec._localBlob = entry.blob;
    rec._localHydrated = true;
    // If a card is already on screen for this gid, swap its src to the blob.
    let card = gallery.querySelector(`[data-gid="${rec.gid}"]`);
    // markExpired() replaces the entire card body, including its <img>. Such a
    // card cannot be revived by assigning img.src; rebuild it from the record.
    if (card && (!card.querySelector("img") || card.dataset.kind !== "done")) {
      const replacement = buildDoneCard(rec);
      renderCardTags(replacement, rec);
      // Free the outgoing card's blob URL — replaceWith drops it from the DOM
      // without any teardown of its own.
      if (card._revokeLocal) { try { card._revokeLocal(); } catch (e) {} }
      card.replaceWith(replacement);
      card = replacement;
    }
    if (card && !card.querySelector("img")?.dataset.local) {
      try {
        const url = URL.createObjectURL(entry.blob);
        const img = card.querySelector("img");
        if (img) {
          img.src = url;
          img.dataset.local = "1";
          img.addEventListener("load", () => {
            img.classList.add("loaded");
            delete card.dataset.loadStalled;  // clear any stalled overlay from the CDN attempt
          }, { once: true });
          img.addEventListener("error", () => {
            delete card.dataset.loadStalled;
          }, { once: true });
        }
        const prevRevoke = card._revokeLocal;
        card._revokeLocal = () => {
          if (prevRevoke) { try { prevRevoke(); } catch (e) {} }
          try { URL.revokeObjectURL(url); } catch (e) {}
        };
        card.classList.remove("expired");
        card.dataset.kind = "done";
        card.classList.add("done");
        delete card.dataset.loadStalled;
      } catch (e) {}
    }
  }
}

let lbItems = [];
let lbIdx = 0;

function openLightbox(card) {
  lbItems = [...$("#gallery").querySelectorAll(".card.done")];
  lbIdx = Math.max(0, lbItems.indexOf(card));
  $("#lightbox").hidden = false;
  renderLightbox();
}

function renderLightbox() {
  const card = lbItems[lbIdx];
  if (!card) { closeLightbox(); return; }
  const rec = card._rec || {};
  const img = $("#lightboxImg");
  img.src = card.querySelector("img")?.src || rec.url || "";
  $("#lightboxCap").innerHTML = `
    <div class="lb-cap-row">
      <span class="lb-cap-text">${esc(rec.prompt || "")}</span>
      <span class="tag gold">${esc(rec.model || "")}</span>
      <button class="mini-btn" data-action="download" title="Download">${ICONS.download}</button>
      <button class="mini-btn" data-action="delete" title="Remove">${ICONS.trash}</button>
    </div>`;
  $("#lightboxCounter").textContent = `${lbIdx + 1} / ${lbItems.length}`;
}

function closeLightbox() {
  $("#lightbox").hidden = true;
  $("#lightboxImg").src = "";
}

$(".lb-prev").addEventListener("click", () => { lbIdx = (lbIdx - 1 + lbItems.length) % lbItems.length; renderLightbox(); });
$(".lb-next").addEventListener("click", () => { lbIdx = (lbIdx + 1) % lbItems.length; renderLightbox(); });
$(".lb-close").addEventListener("click", closeLightbox);
$("#lightbox").addEventListener("click", e => {
  if (e.target === e.currentTarget) { closeLightbox(); return; }
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  const card = lbItems[lbIdx];
  if (!card) return;
  if (action === "download") downloadImage(card);
  else if (action === "delete") { closeLightbox(); removeCard(card); }
});

function openSettings() {
  $("#apiKeysInput").value = (state.settings.apiKeys || []).join("\n");
  $("#baseUrlInput").value = state.settings.baseUrl;
  $("#autoSaveToggle").checked = !!state.settings.autoSave;
  $("#saveFolderInput").value = state.settings.saveFolder || "";
  $("#settingsOverlay").hidden = false;
  $("#apiKeysInput").focus();
  // Probe the folder right away so the user sees status without clicking.
  setTimeout(() => checkSaveFolder($("#saveFolderInput").value.trim()), 50);
}

function closeSettings() {
  $("#settingsOverlay").hidden = true;
}

// Probe a folder via /list-saved and show status inline.
async function checkSaveFolder(folder) {
  const status = $("#saveFolderStatus");
  if (!status) return;
  const target = folder || (state.settings.saveFolder || "");
  if (!target) { status.textContent = "Using default (%USERPROFILE%\\Pictures\\Imagine Studio\\). Set a folder to override."; status.className = "field-status"; return; }
  status.textContent = "Checking…"; status.className = "field-status";
  try {
    const url = `/list-saved?folder=${encodeURIComponent(target)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!j.ok) { status.textContent = `Error: ${j.error}`; status.className = "field-status err"; return; }
    if (j.exists) {
      status.textContent = `Folder ready — ${j.count} item${j.count === 1 ? "" : "s"} saved so far.`;
      status.className = "field-status ok";
    } else {
      status.textContent = "Folder does not exist yet — will be created on first save.";
      status.className = "field-status";
    }
  } catch (e) {
    status.textContent = `Could not reach server: ${e.message}`;
    status.className = "field-status err";
  }
}

// Open the user's save folder in File Explorer via the local server.
// The server runs `explorer.exe <path>` so the actual OS file manager opens.
async function revealSavedFolder() {
  let folder = $("#saveFolderInput").value.trim();
  if (!folder) {
    // Empty input → use the default and write it back so the user sees what we used.
    folder = (state.settings.saveFolder || "").trim();
  }
  // Append today's date subfolder, matching where files actually land.
  const today = new Date().toISOString().slice(0, 10);
  const target = folder ? (folder.endsWith(today) ? folder : (folder + (folder.endsWith("\\") || folder.endsWith("/") ? "" : "\\") + today)) : "";
  const url = "/open-folder" + (target ? `?folder=${encodeURIComponent(target)}` : "");
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.ok) { /* explorer opened */ }
    else toast(`Open failed: ${j.error}`, "error");
  } catch (e) { toast(`Open failed: ${e.message}`, "error"); }
  // Always refresh the status line too.
  await checkSaveFolder(target || folder);
}

// Wire the Open button + folder probe when input changes
$("#btnOpenSavedFolder")?.addEventListener("click", () => revealSavedFolder());
$("#saveFolderInput")?.addEventListener("change", e => checkSaveFolder(e.target.value.trim()));
$("#autoSaveToggle")?.addEventListener("change", e => {
  if (e.target.checked) checkSaveFolder($("#saveFolderInput").value.trim());
});

$("#btnSettings").addEventListener("click", openSettings);
$("#btnCloseSettings").addEventListener("click", closeSettings);
$("#settingsOverlay").addEventListener("click", e => { if (e.target === e.currentTarget) closeSettings(); });

$("#btnTestKeys").addEventListener("click", async e => {
  const btn = e.currentTarget;
  const raw = $("#apiKeysInput").value.split("\n").map(s => s.trim()).filter(Boolean);
  const box = $("#keyTestResults");
  box.hidden = false;
  box.innerHTML = "";
  if (!raw.length) { box.innerHTML = '<div class="ktr-row ktr-bad">No keys entered.</div>'; return; }
  btn.textContent = "Testing…";
  btn.disabled = true;
  const base = (state.settings.baseUrl || REAL_BASE).replace(/\/+$/, "");
  let ok = 0, bad = 0;
  for (let i = 0; i < raw.length; i++) {
    const row = document.createElement("div");
    row.className = "ktr-row";
    row.innerHTML = `<span class="ktr-key">${esc(raw[i].slice(0, 8))}…</span><span class="ktr-status">…</span>`;
    box.appendChild(row);
    try {
      const res = await fetch(base + "/api/public/v1/models", { headers: { Authorization: `Bearer ${raw[i]}` } });
      const data = await res.json().catch(() => ({}));
      const statusEl = row.querySelector(".ktr-status");
      if (res.ok) {
        ok++;
        row.classList.add("ktr-ok");
        statusEl.textContent = "OK";
      } else if (res.status === 429) {
        bad++;
        row.classList.add("ktr-warn");
        statusEl.textContent = "RATE-LIMITED";
      } else if (res.status === 401) {
        bad++;
        row.classList.add("ktr-bad");
        statusEl.textContent = "INVALID";
      } else {
        bad++;
        row.classList.add("ktr-bad");
        statusEl.textContent = `ERR ${res.status}`;
      }
    } catch (err) {
      bad++;
      row.classList.add("ktr-bad");
      row.querySelector(".ktr-status").textContent = "NET ERR";
    }
  }
  const summary = document.createElement("div");
  summary.className = "ktr-row";
  summary.innerHTML = `<span class="ktr-key">Summary</span><span class="ktr-status ${ok === raw.length ? "ktr-ok" : "ktr-warn"}">${ok}/${raw.length} OK</span>`;
  box.appendChild(summary);
  btn.textContent = "Test all keys";
  btn.disabled = false;
});

$("#btnSaveSettings").addEventListener("click", () => {
  const raw = $("#apiKeysInput").value.split("\n").map(s => s.trim()).filter(Boolean);
  state.settings.apiKeys = raw;
  state.keyIdx = 0;
  state.settings.baseUrl = $("#baseUrlInput").value.trim() || REAL_BASE;
  state.settings.autoSave = !!$("#autoSaveToggle").checked;
  state.settings.saveFolder = $("#saveFolderInput").value.trim();
  localStorage.setItem(LS.keys, JSON.stringify(raw));
  localStorage.setItem(LS.base, state.settings.baseUrl);
  localStorage.setItem("imagine.autoSave", state.settings.autoSave ? "1" : "0");
  localStorage.setItem("imagine.saveFolder", state.settings.saveFolder || "");
  // Mirror to IDB for recoverability.
  kvPut("apiKeys", JSON.stringify(raw));
  kvPut("baseUrl", state.settings.baseUrl);
  kvPut("autoSave", state.settings.autoSave ? "1" : "0");
  kvPut("saveFolder", state.settings.saveFolder || "");
  closeSettings();
  toast(`Settings saved — ${raw.length} API key${raw.length === 1 ? "" : "s"} in rotation.`, "success");
  loadModels();
});

$("#btnTestConn").addEventListener("click", async e => {
  const btn = e.currentTarget;
  const prev = state.settings;
  const raw = $("#apiKeysInput").value.split("\n").map(s => s.trim()).filter(Boolean);
  state.settings = {
    apiKeys: raw,
    baseUrl: $("#baseUrlInput").value.trim() || REAL_BASE
  };
  state.keyIdx = 0;
  btn.textContent = "Testing…";
  btn.disabled = true;
  try {
    const data = await api("/api/public/v1/models");
    toast(`Connected — ${(data.models || []).length} models available (${raw.length} key${raw.length === 1 ? "" : "s"}).`, "success");
  } catch (err) {
    toast(`Connection failed: ${err.message}`, "error");
  } finally {
    state.settings = prev;
    btn.textContent = "Test connection";
    btn.disabled = false;
  }
});

$("#btnExportAll")?.addEventListener("click", exportAllToDisk);

// Scan the user's save folder and rebuild state.history + IDB blobs from
// the .json sidecars. This is the recovery path for users whose localStorage
// got wiped but whose auto-save was on — every image they ever generated
// (with sidecar) is sitting in <Pictures>/Imagine Studio/<date>/.
async function reimportFromDisk() {
  toast(`Scanning save folder…`, "info");
  const folder = (state.settings.saveFolder || "").trim();
  const url = "/scan-saved" + (folder ? `?folder=${encodeURIComponent(folder)}` : "");
  let r, j;
  try { r = await fetch(url); j = await r.json(); }
  catch (e) { toast(`Scan failed: ${e.message}`, "error"); return; }
  if (!j.ok) { toast(`Scan failed: ${j.error || "unknown"}`, "error"); return; }
  if (!j.items || !j.items.length) { toast("No images found in the save folder.", "info"); return; }
  let added = 0, updated = 0;
  const existingByGid = new Map(state.history.map(r => [r.gid, r]));
  for (const it of j.items) {
    const meta = it.meta || {};
    // Use meta.gid if present, else derive a stable id from filename.
    let gid = meta.gid || it.name.replace(/\.(png|jpg|jpeg|webp)$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!gid) continue;
    // Keep a same-origin disk URL as a durable fallback. `file://` URLs are
    // blocked from an http:// page, whereas this endpoint remains readable
    // even when the browser cache/IndexedDB has been cleared.
    const localImageUrl = "/import-image?path=" + encodeURIComponent(it.path);
    const rec = {
      gid,
      url: localImageUrl,
      model: meta.model || "imported",
      prompt: meta.prompt || "",
      ratio: meta.ratio || "",
      quality: meta.quality || "",
      style: meta.style || "",
      mode: meta.mode || "",
      w: 0, h: 0,
      ts: meta.ts || 0,  // 0 = uninitialized; sort will still group them at the top
      extra: "",
      tags: meta.tags || [],
      _imported: true,
      diskPath: it.path
    };
    let targetRec = rec;
    if (existingByGid.has(gid)) {
      targetRec = existingByGid.get(gid);
      // Preserve any newer metadata; only overwrite fields we have.
      Object.assign(targetRec, rec);
      updated++;
    } else {
      state.history.unshift(rec);
      existingByGid.set(gid, rec);
      added++;
    }
    // Cache the image bytes locally so the gallery can render it.
    try {
      const blob = await fetch(localImageUrl).then(r => r.ok ? r.blob() : null);
      if (blob) {
        await imgPut(gid, blob);
        // Attach to the object actually stored in state.history. The previous
        // implementation attached to the temporary `rec` even for updates.
        targetRec._localBlob = blob;
        targetRec._localHydrated = true;
      }
    } catch (e) {}
  }
  saveHistory();
  renderGallery();
  hydrateLocalBlobs();
  toast(`Re-import done — ${added} added, ${updated} updated.`, added + updated ? "success" : "info", 3000);
}
$("#btnReimport")?.addEventListener("click", reimportFromDisk);

$("#btnClearAll").addEventListener("click", () => {
  if (!state.history.length) return;
  // First guard: simple confirm.
  if (!confirm("Remove all images from the gallery?")) return;
  // Second guard: stronger warning that explains recovery options. Auto-save
  // users have a re-import path; otherwise it's effectively permanent.
  const autoSave = state.settings.autoSave;
  const msg = autoSave
    ? "Auto-save is on — files exist on disk. This wipes the gallery view only. Use 'Re-import' to restore. Continue?"
    : "Auto-save is OFF. This wipes the gallery view AND any cached images. Cards will be re-fetched from the CDN if URLs still work, OR show 'Link expired' if not. Continue?";
  if (!confirm(msg)) return;
  state.jobs.forEach(j => { j.cancelled = true; j._resolve && j._resolve(); });
  state.jobs.clear();
  $("#gallery").innerHTML = "";
  state.history = [];
  saveHistory();
  imgClear();
  refreshEmpty();
});

$("#dropzone").addEventListener("click", () => $("#refInput").click());
$("#dropzone").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#refInput").click(); } });
$("#refInput").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
["dragover", "dragenter"].forEach(ev => $("#dropzone").addEventListener(ev, e => { e.preventDefault(); $("#dropzone").classList.add("dragover"); }));
["dragleave", "drop"].forEach(ev => $("#dropzone").addEventListener(ev, e => { e.preventDefault(); $("#dropzone").classList.remove("dragover"); }));
$("#dropzone").addEventListener("drop", e => addFiles(e.dataTransfer.files));

document.addEventListener("paste", e => {
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === "file").map(i => i.getAsFile()).filter(Boolean);
  if (files.length && state.model?.supports_reference_images) { addFiles(files); toast("Pasted image added as reference.", "success"); }
});

$("#modelSelect").addEventListener("change", applyModel);
$("#btnGenerate").addEventListener("click", generate);
$("#promptInput").addEventListener("input", syncChar);

// ---- Guided prompt builder (from the `nano-banana-prompting` skill) ----
// Mirrors the skill's 3-step flow: Type/Subject → technique-specific follow-ups → assembled prompt.
// State: { type, subject, subjectDesc, era, aspect, dynamic: {key:val,...} }
const GUIDE = {
  type: "",
  subject: "",
  subjectDesc: "",
  era: "",
  aspect: "",
  dynamic: {}
};

// Dynamic follow-up chips shown on Step 2, based on Step 1 type choice.
// Mirrors the skill's "Technique-Specific Questions" (Photography / Reference / Text / Educational).
const GUIDE_DYNAMIC = {
  photo: {
    label: "Lighting & vibe",
    chips: [
      { id: "lighting", name: "Lighting", key: "lighting", vals: ["golden hour", "studio softbox", "direct flash", "overcast diffused", "neon night", "dramatic chiaroscuro"] },
      { id: "vibe", name: "Vibe", key: "vibe", vals: ["candid", "cinematic", "nostalgic", "moody", "dreamy", "editorial"] }
    ]
  },
  illustration: {
    label: "Art style",
    chips: [
      { id: "style", name: "Art style", key: "style", vals: ["watercolor", "ink line art", "cel-shaded", "risograph", "3D render", "oil painting"] },
      { id: "vibe", name: "Vibe", key: "vibe", vals: ["playful", "dark fantasy", "minimalist", "vintage storybook", "sci-fi", "fairy-tale"] }
    ]
  },
  product: {
    label: "Shot details",
    chips: [
      { id: "bg", name: "Background", key: "bg", vals: ["pure white studio", "seamless sweep", "marble surface", "lifestyle in-use", "outdoor natural"] },
      { id: "light", name: "Lighting", key: "light", vals: ["softbox soft", "hard key with shadows", "golden hour", "rim light separation", "reflective glossy"] }
    ]
  },
  infographic: {
    label: "Infographic style",
    chips: [
      { id: "type", name: "Type", key: "itype", vals: ["labeled diagram", "flowchart", "comparison matrix", "anatomical breakdown", "step-by-step process"] },
      { id: "vibe", name: "Style", key: "ivibe", vals: ["flat vector", "isometric", "hand-drawn notebook", "scientific textbook", "playful children's book"] }
    ]
  },
  ui: {
    label: "UI style",
    chips: [
      { id: "device", name: "Device", key: "device", vals: ["phone screen", "desktop browser", "tablet", "watch face", "tv screen"] },
      { id: "vibe", name: "Vibe", key: "vibe", vals: ["glassmorphism dark", "neumorphic light", "brutalist", "sketch wireframe", "Apple-style minimal"] }
    ]
  },
  editorial: {
    label: "Editorial details",
    chips: [
      { id: "text", name: "Text content", key: "textcontent", vals: ["title + subtitle", "cover with date + barcode", "pull quote", "headline + body copy"] },
      { id: "font", name: "Font style", key: "font", vals: ["serif elegant", "bold sans-serif", "handwritten", "retro 70s", "modern condensed"] }
    ]
  }
};

function setGuideStep(n) {
  document.querySelectorAll(".guide-step").forEach(s => s.hidden = parseInt(s.dataset.step) !== n);
  document.querySelectorAll(".guide-step-ind").forEach(i => i.classList.toggle("active", parseInt(i.dataset.stepInd) === n));
  if (n === 3) renderGuidePreview();
}

function renderGuideDynamicChips() {
  const wrap = $("#guideDynamic");
  const label = $("[data-dynamic-label]");
  wrap.innerHTML = "";
  GUIDE.dynamic = {};
  const cfg = GUIDE_DYNAMIC[GUIDE.type];
  if (!cfg) return;
  label.textContent = cfg.label;
  cfg.chips.forEach(group => {
    const row = document.createElement("div");
    row.style.marginTop = "6px";
    row.innerHTML = `<div class="guide-label" style="margin-bottom:5px">${group.name}</div>`;
    const chips = document.createElement("div");
    chips.className = "chip-row";
    chips.dataset.gDynamicKey = group.key;
    group.vals.forEach(v => {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "chip";
      c.dataset.gval = v;
      c.textContent = v;
      chips.appendChild(c);
    });
    row.appendChild(chips);
    wrap.appendChild(row);
  });
}

// Build the prompt using the skill's techniques (YAML-style for control, narrative for product shots).
function buildGuidedPrompt() {
  const subject = (GUIDE.subjectDesc || "").trim() || `${GUIDE.subject || "a subject"}`;
  const era = GUIDE.era || "modern";
  const aspect = GUIDE.aspect;
  const d = GUIDE.dynamic;
  const pieces = [];

  // ---- Type-specific scaffolding ----
  if (GUIDE.type === "photo") {
    const lighting = d.lighting || "natural soft light";
    const vibe = d.vibe || "candid";
    pieces.push(`Photograph ${subject}, ${vibe} mood, ${lighting}.`);
    const eraMap = { modern: "modern DSLR, sharp digital clarity", "2000s": "early-2000s digital camera aesthetic with subtle grain and retro highlights", "1990s": "1990s film photography, direct flash, dim ambient", vintage: "vintage film stock, soft grain, muted tones" };
    pieces.push(`Camera: ${eraMap[era]}.`);
    pieces.push(`Focus on the subject's eyes; natural skin texture, no plastic smoothing.`);
    pieces.push(`Color grading: ${vibe === "cinematic" ? "filmic contrast with teal-orange split tone" : vibe === "moody" ? "low-key, deep shadows" : "clean, balanced, lightly warm"}.`);
  } else if (GUIDE.type === "illustration") {
    pieces.push(`An illustration of ${subject}.`);
    pieces.push(`Art style: ${d.style || "watercolor"}, ${d.vibe || "playful"} tone.`);
    pieces.push(`Hand-drawn feel, rich detail, clean composition.`);
  } else if (GUIDE.type === "product") {
    pieces.push(`Premium product photograph of ${subject}.`);
    pieces.push(`Background: ${d.bg || "pure white studio"}. Lighting: ${d.light || "softbox soft"}.`);
    pieces.push(`Hero shot, 50mm lens, f/4, sharp focus on the product with gentle background falloff.`);
    pieces.push(`Photorealistic, clean, premium brand feel, balanced negative space, 8K.`);
  } else if (GUIDE.type === "infographic") {
    pieces.push(`An educational infographic explaining ${subject}.`);
    pieces.push(`Type: ${d.itype || "labeled diagram"}. Visual style: ${d.ivibe || "flat vector"}.`);
    pieces.push(`Clear labels, arrows showing flow, suitable for a high-school audience.`);
  } else if (GUIDE.type === "ui") {
    pieces.push(`A polished UI mockup of ${subject}.`);
    pieces.push(`Device: ${d.device || "phone screen"}. Visual style: ${d.vibe || "glassmorphism dark"}.`);
    pieces.push(`Modern, clean, with realistic shadows and depth, no real brand logos.`);
  } else if (GUIDE.type === "editorial") {
    const textPart = d.textcontent || "a magazine cover";
    const fontPart = d.font || "serif elegant";
    pieces.push(`A photorealistic magazine cover on a glossy paper, displayed on a white shelf against a wall.`);
    pieces.push(`Cover text: "${textPart}". Font: ${fontPart}, filling the cover.`);
    pieces.push(`Include issue number, today's date, and a barcode in the corner.`);
  } else {
    pieces.push(`A detailed image of ${subject}.`);
  }

  // Aspect ratio
  if (aspect) pieces.push(`Aspect ratio: ${aspect}.`);
  // Negative-prompt friendly closing
  pieces.push(`No watermarks, no text artifacts, no extra fingers.`);
  return pieces.join(" ");
}

function renderGuidePreview() {
  const preview = $("#guidePreview");
  if (!GUIDE.type && !GUIDE.subject && !GUIDE.subjectDesc) {
    preview.textContent = "Pick a type and subject to begin.";
    preview.classList.add("empty");
    return;
  }
  preview.classList.remove("empty");
  preview.textContent = buildGuidedPrompt();
}

function setGuideMode(on) {
  $("#promptInput").hidden = on;
  $(".prompt-tip").hidden = on;
  $("#promptGuide").hidden = !on;
  document.querySelectorAll(".mode-pill").forEach(p => p.classList.toggle("active", p.dataset.mode === (on ? "guide" : "free")));
  if (on) setGuideStep(1);
}

// Mode pills
document.querySelectorAll(".mode-pill").forEach(p => {
  p.addEventListener("click", () => setGuideMode(p.dataset.mode === "guide"));
});

// Step 1 chips (type, subject)
document.querySelectorAll('[data-ggroup="type"] .chip, [data-ggroup="subject"] .chip').forEach(c => {
  c.addEventListener("click", () => {
    const group = c.parentElement.dataset.ggroup;
    const val = c.dataset.gval;
    const same = (group === "type" ? GUIDE.type : GUIDE.subject) === val;
    if (group === "type") GUIDE.type = same ? "" : val;
    else GUIDE.subject = same ? "" : val;
    c.parentElement.querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x.dataset.gval === val && !same));
    if (group === "type" && GUIDE.type) renderGuideDynamicChips();
  });
});
// Step 2 chips (era, aspect, dynamic)
document.addEventListener("click", e => {
  const c = e.target.closest('[data-ggroup="era"] .chip, [data-ggroup="aspect"] .chip, [data-ggroup="dynamic"] .chip');
  if (!c) return;
  const group = c.parentElement.dataset.ggroup;
  const val = c.dataset.gval;
  const key = c.parentElement.dataset.gDynamicKey || group;
  const same = key === "era" ? GUIDE.era === val : key === "aspect" ? GUIDE.aspect === val : GUIDE.dynamic[key] === val;
  if (key === "era") GUIDE.era = same ? "" : val;
  else if (key === "aspect") GUIDE.aspect = same ? "" : val;
  else GUIDE.dynamic[key] = same ? "" : val;
  c.parentElement.querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x.dataset.gval === val && !same));
});
// Subject description input
$("#guideSubject")?.addEventListener("input", e => { GUIDE.subjectDesc = e.target.value; });
// Step nav
$("#guideUse")?.addEventListener("click", () => {
  const text = buildGuidedPrompt();
  $("#promptInput").value = text;
  setGuideMode(false);
  syncChar();
  toast("Prompt loaded. Hit Generate.", "success");
  $("#promptInput").focus();
});
$("#guideBack")?.addEventListener("click", () => {
  const cur = document.querySelector(".guide-step:not([hidden])");
  const n = cur ? Math.max(1, parseInt(cur.dataset.step) - 1) : 1;
  setGuideStep(n);
});
$("#guideReset")?.addEventListener("click", () => {
  GUIDE.type = ""; GUIDE.subject = ""; GUIDE.subjectDesc = ""; GUIDE.era = ""; GUIDE.aspect = ""; GUIDE.dynamic = {};
  document.querySelectorAll('[data-ggroup] .chip').forEach(c => c.classList.remove("active"));
  $("#guideSubject").value = "";
  $("#guideDynamic").innerHTML = "";
  setGuideStep(1);
});
document.querySelectorAll(".guide-step-ind").forEach(ind => {
  ind.addEventListener("click", () => setGuideStep(parseInt(ind.dataset.stepInd)));
});

$("#sortSelect")?.addEventListener("change", e => {
  state.sort = e.target.value === "oldest" ? "oldest" : "newest";
  try { localStorage.setItem(LS.sort, state.sort); } catch (err) {}
  renderGallery();
});

// ---- Draggable composer resizer ----
(function initResizer() {
  const resizer = $("#resizer");
  const layout = $(".layout");
  if (!resizer || !layout) return;
  const MIN_W = 260, MAX_W = 700;
  // Restore saved width.
  let saved = 0;
  try { saved = parseInt(localStorage.getItem("imagine.composerW") || "0", 10) || 0; } catch (e) {}
  if (saved >= MIN_W && saved <= MAX_W) layout.style.setProperty("--composer-w", saved + "px");

  let dragging = false;
  resizer.addEventListener("mousedown", e => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    const rect = layout.getBoundingClientRect();
    let w = e.clientX - rect.left;
    w = Math.max(MIN_W, Math.min(MAX_W, w));
    layout.style.setProperty("--composer-w", w + "px");
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const w = parseInt(getComputedStyle(layout).getPropertyValue("--composer-w"), 10) || 344;
    try { localStorage.setItem("imagine.composerW", String(w)); } catch (e) {}
  });
})();

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); generate(); return; }
  if (e.key === "Escape") {
    if (!$("#lightbox").hidden) closeLightbox();
    else if (!$("#settingsOverlay").hidden) closeSettings();
    return;
  }
  if ($("#lightbox").hidden) return;
  if (e.key === "ArrowLeft") $(".lb-prev").click();
  if (e.key === "ArrowRight") $(".lb-next").click();
});

(function init() {
  // If localStorage appears wiped but IDB has backups, restore from IDB.
  // Silent if IDB is empty too. Runs before any UI mount so the rest of
  // init sees the right values.
  (async () => {
    try {
      const idbHist = await kvGet("history");
      const lsHist = (() => { try { return JSON.parse(localStorage.getItem(LS.hist) || "[]"); } catch(e) { return null; } })();
      if ((!lsHist || lsHist.length === 0) && idbHist) {
        const restored = (() => { try { return JSON.parse(idbHist); } catch(e) { return []; } })();
        if (Array.isArray(restored) && restored.length) {
          state.history = restored;
          renderGallery();
          console.log(`[init] Restored ${restored.length} gallery records from IDB backup.`);
        }
      }
      const idbPrompts = await kvGet("promptHistory");
      if (idbPrompts && (!state.promptHistory || state.promptHistory.length === 0)) {
        try {
          const restored = JSON.parse(idbPrompts);
          if (Array.isArray(restored) && restored.length) {
            state.promptHistory = restored;
            savePromptHistory();
            console.log(`[init] Restored ${restored.length} prompts from IDB backup.`);
          }
        } catch (e) {}
      }
    } catch (e) {}
  })();
  // Legacy single-key fallback: if old imagine.apiKey exists, migrate it.
  let keys = [];
  try { keys = JSON.parse(localStorage.getItem(LS.keys) || "[]"); } catch (e) { keys = []; }
  if (!Array.isArray(keys)) keys = [];
  const legacy = localStorage.getItem(LS.key);
  if (!keys.length && legacy) keys = [legacy];
  state.settings.apiKeys = keys.filter(Boolean);
  state.settings.baseUrl = localStorage.getItem(LS.base) || REAL_BASE;
  try { state.settings.autoSave = localStorage.getItem("imagine.autoSave") !== "0"; } catch (e) { state.settings.autoSave = true; }
  try { state.settings.saveFolder = localStorage.getItem("imagine.saveFolder") || ""; } catch (e) { state.settings.saveFolder = ""; }
  try { state.keyIdx = parseInt(localStorage.getItem("imagine.keyIdx") || "0", 10) || 0; } catch (e) { state.keyIdx = 0; }
  try { state.batch = Math.max(1, Math.min(4, parseInt(localStorage.getItem(LS.batch) || "1", 10) || 1)); } catch (e) { state.batch = 1; }
  try { state.delayMs = Math.max(0, Math.min(60000, parseInt(localStorage.getItem(LS.delay) || "0", 10) || 0)); } catch (e) { state.delayMs = 0; }
  try { state.seq = localStorage.getItem(LS.seq) === "1"; } catch (e) { state.seq = false; }
  try { state.sort = localStorage.getItem(LS.sort) === "oldest" ? "oldest" : "newest"; } catch (e) { state.sort = "newest"; }
  // Restore prompt history (the list that powers the ▾ dropdown)
  state.promptHistory = loadPromptHistory();
  // Restore gallery filter state
  try { state.gallerySearch = localStorage.getItem("imagine.gallerySearch") || ""; } catch (e) { state.gallerySearch = ""; }
  try { state.galleryTags = JSON.parse(localStorage.getItem("imagine.galleryTags") || "[]"); } catch (e) { state.galleryTags = []; }
  const searchInput = $("#gallerySearch");
  if (searchInput) searchInput.value = state.gallerySearch;
  const sortSel = $("#sortSelect");
  if (sortSel) sortSel.value = state.sort;
  syncChar();
  renderHistory();
  syncBatchUI();
  // Defer model loading so the gallery renders immediately — don't block on network.
  // Models will load in the background; the UI is usable right away.
  setTimeout(() => loadModels(), 0);
})();
