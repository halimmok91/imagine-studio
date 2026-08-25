// Vercel serverless function: proxies /api/* to https://imaginer.mirava.studio
// CommonJS for compatibility with Vercel's default Node runtime.

module.exports = async function handler(req, res) {
  const UPSTREAM = "https://imaginer.mirava.studio";
  const url = UPSTREAM + req.url;
  const headers = {};
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers["authorization"]) headers["authorization"] = req.headers["authorization"];
  // Read body (Node IncomingMessage) into a buffer
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Content-Type": upstream.headers.get("content-type") || "application/json",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "Proxy error: " + e.message }));
  }
};
