"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8787;
const UPSTREAM = "https://imaginer.mirava.studio";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json"
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split("?")[0]);
  } catch (e) {
    res.writeHead(400); return res.end("Bad request");
  }
  if (pathname === "/") pathname = "/index.html";
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
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
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

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.url.startsWith("/api/")) return proxy(req, res);
  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  IMAGINE Studio");
  console.log(`  Local server + API proxy running at http://localhost:${PORT}`);
  console.log("");
  console.log(`  Static files : ${ROOT}`);
  console.log(`  API proxy    : ${UPSTREAM}/api/*`);
  console.log("");
  console.log("  In the app's Settings, set API base URL to \"/\" to route");
  console.log("  through this proxy (avoids any browser CORS restrictions).");
  console.log("");
});
