export default async function handler(req, res) {
  const UPSTREAM = "https://imaginer.mirava.studio";
  const url = UPSTREAM + req.url;
  const headers = {};
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers["authorization"]) headers["authorization"] = req.headers["authorization"];
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const out = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    };
    const ct = upstream.headers.get("content-type");
    if (ct) out["Content-Type"] = ct;
    res.writeHead(upstream.status, out);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "Proxy error: " + e.message }));
  }
}

export const config = { api: { bodyParser: false } };
