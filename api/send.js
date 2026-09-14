// Secure notification endpoint that hides your bot token.
// Set TELEGRAM_BOT_TOKEN in Vercel env vars, then call:
//
//   POST https://<your-app>.vercel.app/api/send
//   Content-Type: application/json
//   (optional) x-proxy-secret: <PROXY_SECRET>
//
//   { "chat_id": "123456", "text": "hello from vercel" }
//
// Optional: { "method": "sendPhoto", "chat_id": "...", "photo": "...", "caption": "..." }
// Optional query: /api/send?method=sendMessage
//
// Env vars:
//   TELEGRAM_BOT_TOKEN - required (just the token, e.g. "123456:ABC-DEF...")
//   PROXY_SECRET       - optional but recommended, client must send it
//   DEFAULT_CHAT_ID    - optional, used when body has no chat_id

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Content-Type, X-Proxy-Secret"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && !req.readable) {
      if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return resolve(req.body || {});
      try {
        const s = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body);
        return resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        return reject(new Error("Invalid JSON body"));
      }
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, description: "Use POST" }));
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, description: "TELEGRAM_BOT_TOKEN not configured" }));
  }

  const base = `http://${req.headers.host || "localhost"}`;
  const incoming = new URL(req.url || "/", base);

  if (process.env.PROXY_SECRET) {
    const got = req.headers["x-proxy-secret"] || incoming.searchParams.get("secret");
    if (got !== process.env.PROXY_SECRET) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, description: "Invalid proxy secret" }));
    }
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, description: e.message }));
  }

  const method = incoming.searchParams.get("method") || body.method || "sendMessage";
  if (!/^[A-Za-z]+$/.test(method)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, description: "Invalid method" }));
  }

  const { method: _m, secret: _s, ...params } = body;
  if (!params.chat_id && process.env.DEFAULT_CHAT_ID) {
    params.chat_id = process.env.DEFAULT_CHAT_ID;
  }
  if (!params.chat_id) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, description: "chat_id is required" }));
  }

  try {
    const upstream = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/json"
    );
    res.setHeader("Cache-Control", "no-store");
    return res.end(buf);
  } catch (err) {
    console.error("send error:", err);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, description: "Upstream fetch failed" }));
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
