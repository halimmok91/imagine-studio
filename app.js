"use strict";

const $ = s => document.querySelector(s);
const REAL_BASE = "https://imaginer.mirava.studio";
const LS = { key: "imagine.apiKey", keys: "imagine.apiKeys", base: "imagine.baseUrl", model: "imagine.model", hist: "imagine.history", batch: "imagine.batch", delay: "imagine.delay", seq: "imagine.seq", sort: "imagine.sort", promptHistory: "imagine.promptHistory" };
const MAX_PROMPT = 2000;
// Reference uploads expire server-side; re-upload any ref older than this before generating.
const REF_MAX_AGE_MS = 45000;

const ICONS = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7h12Z"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>'
};

const st = slugs => slugs.map(s => ({ slug: s }));
const FULL_STYLES = ["dynamic", "creative", "fashion", "portrait", "portrait-cinematic", "portrait-fashion", "illustration", "3d-render", "acrylic", "game-concept", "graphic-design-2d", "graphic-design-3d", "pro-b-w-photography", "pro-color-photography", "pro-film-photography", "ray-traced", "stock-photo", "watercolor"];
const GPT2_STYLES = ["dynamic", "creative", "fashion", "illustration", "3d-render", "acrylic", "game-concept", "graphic-design-2d", "graphic-design-3d", "pro-b-w-photography", "pro-color-photography", "pro-film-photography", "ray-traced", "stock-photo", "watercolor"];
const LUCID_STYLES = ["dynamic", "creative", "fashion", "portrait", "cinematic", "cinematic-close-up", "bokeh", "film", "food", "hdr", "long-exposure", "macro", "minimalist", "monochrome", "moody", "neutral", "retro", "stock-photo", "unprocessed", "vibrant"];
const SHORT_STYLES = ["dynamic", "creative", "fashion", "cinematic", "portrait", "stock-photo", "vibrant"];

const FALLBACK_MODELS = [
  { id: "nano-banana-2", display_name: "Nano Banana 2", enabled: true, supports_reference_images: true, max_reference_images: 6, qualities: ["1K", "2K", "4K"], ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], styles: st(FULL_STYLES) },
  { id: "gpt-image-2", display_name: "GPT Image 2", enabled: true, supports_reference_images: true, max_reference_images: 6, qualities: ["low", "medium"], ratios: ["1:1", "2:3", "3:2", "16:9", "9:16"], styles: st(GPT2_STYLES) },
  { id: "flux-pro-2.0", display_name: "Flux 2.0 Pro", enabled: true, supports_reference_images: true, max_reference_images: 4, qualities: [], ratios: ["1:1", "2:3", "3:2", "16:9", "9:16"], styles: st(FULL_STYLES) },
  { id: "seedream-4.5", display_name: "Seedream 4.5", enabled: true, supports_reference_images: true, max_reference_images: 6, qualities: [], ratios: ["1:1", "2:3", "4:5", "16:9", "21:9", "2:1"], styles: st(SHORT_STYLES) }
];

// Only these models are shown in the app.
const ALLOWED_MODELS = new Set(["nano-banana-2", "gpt-image-2", "flux-pro-2.0", "seedream-4.5"]);

const state = {
  settings: { apiKeys: [], baseUrl: REAL_BASE },
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

function toast(msg, type = "info") {
  const t = document.createElement("div");
  t.className = `toast t-${type}`;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 320);
  }, 4200);
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
  renderOptionGroups();
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
  const n = Math.max(1, Math.min(4, state.batch || 1));
  document.querySelectorAll("#batchChips .chip").forEach(c => {
    c.classList.toggle("active", parseInt(c.dataset.batch, 10) === n);
  });
  localStorage.setItem(LS.batch, String(n));
  const d = $("#delayInput");
  if (d) d.value = state.delayMs || 0;
  const sq = $("#seqToggle");
  if (sq) sq.checked = !!state.seq;
  // When batch is 2+, queue is auto-forced (account allows ~1 concurrent); reflect that.
  const hint = $("#batchModeHint");
  if (hint) hint.textContent = n >= 2 ? "Queue auto-enabled (2+ images)" : (state.seq ? "Queue on" : "Parallel");
  if (sq) sq.disabled = n >= 2;
}

// The account allows only ~1 concurrent generation (server: "Concurrency limit
// exceeded"). So any batch of 2+ must run one at a time; only batch 1 can run solo.
function shouldQueue(n) {
  return n >= 2 || !!state.seq;
}

document.querySelectorAll("#batchChips .chip").forEach(c => {
  c.addEventListener("click", () => {
    state.batch = parseInt(c.dataset.batch, 10) || 1;
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
  [...gallery.querySelectorAll(".card.done, .card.expired")].forEach(c => c.remove());
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
    const card = buildDoneCard(rec);
    renderCardTags(card, rec);
    frag.appendChild(card);
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
  const loadingAttr = fresh ? "" : "loading=\"lazy\"";
  // Try CDN-side thumbnail (Tencent COS image processing). Falls back to full URL
  // on error — for CDNs that don't support the param, the user just sees the full
  // image (no worse than before). For CDNs that do, gallery load is ~10x faster.
  const fullUrl = esc(rec.url);
  const thumbUrl = makeThumbUrl(rec.url, 512);
  el.innerHTML = `
    <img alt="" ${loadingAttr} ${fetchAttr} decoding="async" src="${esc(thumbUrl)}" data-full="${fullUrl}">
    <div class="card-veil"></div>
    <div class="card-actions">
      <button class="mini-btn" data-action="expand" title="View">${ICONS.expand}</button>
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
  img.addEventListener("error", () => {
    if (img.dataset.fallback === "1") {
      markExpired(el);
      return;
    }
    img.dataset.fallback = "1";
    img.src = rec.url;
  }, { once: true });
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
  el.innerHTML = `<div class="err-body">
    <div class="err-title">Link expired</div>
    <div class="err-msg">The hosted copy is gone or unreachable.</div>
    <button class="text-btn" data-action="reuse">Reuse prompt</button>
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
  const n = Math.max(1, Math.min(4, state.batch || 1));
  // Re-upload stale references first so queued/retried jobs don't hit "expired".
  const refsOk = await refreshRefs();
  if (!refsOk) { toast("Some reference images failed to (re)upload — check them.", "error"); return; }
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
  $("#genLabel").textContent = n > 1 ? `Sending ${n}` : "Sending";
  try {
    const delay = Math.max(0, state.delayMs || 0);
    if (shouldQueue(n)) {
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
    btn.disabled = false;
    btn.classList.remove("busy");
    $("#genLabel").textContent = "Generate";
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
  if (state.history.length > 120) state.history.length = 120;
  saveHistory();
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

function removeCard(card) {
  const jid = card.dataset.job;
  const job = state.jobs.get(jid);
  if (job) { job.cancelled = true; job._resolve && job._resolve(); }
  state.jobs.delete(jid);
  const gid = card.dataset.gid;
  if (gid) {
    const i = state.history.findIndex(h => h.gid === gid);
    if (i >= 0) { state.history.splice(i, 1); saveHistory(); }
  }
  card.remove();
  refreshEmpty();
}

// Edit a finished image: copy the prompt into the textarea, fetch the image
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

$("#gallery").addEventListener("click", e => {
  const card = e.target.closest(".card");
  if (!card) return;
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (card.dataset.kind === "done" && (!action || action === "expand")) { openLightbox(card); return; }
  if (action === "download") downloadImage(card);
  else if (action === "delete") removeCard(card);
  else if (action === "retry") {
    const job = state.jobs.get(card.dataset.job);
    if (job) { removeCard(card); fillAndGenerate(job.params); }
    else removeCard(card);
  } else if (action === "reuse") {
    const rec = card._rec;
    if (rec) fillAndGenerate(rec);
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

let saveHistoryTimer = null;
function saveHistory() {
  // Debounce: batch rapid calls (e.g., 50 images loading at once) into one write.
  clearTimeout(saveHistoryTimer);
  saveHistoryTimer = setTimeout(() => {
    try { localStorage.setItem(LS.hist, JSON.stringify(state.history)); } catch (e) {}
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
  renderGallery();
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
  $("#settingsOverlay").hidden = false;
  $("#apiKeysInput").focus();
}

function closeSettings() {
  $("#settingsOverlay").hidden = true;
}

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
  localStorage.setItem(LS.keys, JSON.stringify(raw));
  localStorage.setItem(LS.base, state.settings.baseUrl);
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

$("#btnClearAll").addEventListener("click", () => {
  if (!$("#gallery").children.length) return;
  if (!confirm("Remove all images from the gallery? Hosted originals will remain until their links expire.")) return;
  state.jobs.forEach(j => { j.cancelled = true; j._resolve && j._resolve(); });
  state.jobs.clear();
  $("#gallery").innerHTML = "";
  state.history = [];
  saveHistory();
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
  // Legacy single-key fallback: if old imagine.apiKey exists, migrate it.
  let keys = [];
  try { keys = JSON.parse(localStorage.getItem(LS.keys) || "[]"); } catch (e) { keys = []; }
  if (!Array.isArray(keys)) keys = [];
  const legacy = localStorage.getItem(LS.key);
  if (!keys.length && legacy) keys = [legacy];
  state.settings.apiKeys = keys.filter(Boolean);
  state.settings.baseUrl = localStorage.getItem(LS.base) || REAL_BASE;
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
