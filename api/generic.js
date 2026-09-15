// Shoutrrr "generic" compatible endpoint.
//
// Shoutrrr generic service POSTs to any webhook URL. Depending on config it sends:
//   1. No template  -> Content-Type: text/plain, body = raw message string
//   2. template=json -> Content-Type: application/json, body = {"title": "...", "message": "..."}
//      - key names can be customized via shoutrrr's `titlekey`/`messagekey` props
//      - extra fields via `$name=value` show up as extra JSON keys
//      - non-reserved shoutrrr query vars (e.g. `chat_id`) are forwarded as query string
//
// So this endpoint accepts all of those shapes and forwards to Telegram sendMessage.
//
// Example shoutrrr URLs (replace <app> and <chat_id>):
//
//   Plain text (no template), chat via forwarded query var:
//     generic://<app>/api/generic?chat_id=<chat_id>
//
//   JSON template, chat via forwarded query var:
//     generic://<app>/api/generic?template=json&chat_id=<chat_id>
//
//   JSON template, chat via extra JSON data field ($ becomes a JSON key):
//     generic://<app>/api/generic?template=json&$chat_id=<chat_id>
//
//   With a proxy secret (recommended, matches PROXY_SECRET env):
//     generic://<app>/api/generic?template=json&chat_id=<chat_id>&secret=<proxy_secret>
//     ...or send header via shoutrrr `@` prefix (becomes an HTTP header):
//     generic://<app>/api/generic?template=json&chat_id=<chat_id>&@x-proxy-secret=<proxy_secret>
//
//   Custom message/title keys? Tell shoutrrr what keys to send with, and (if they differ
//   from "message"/"title") tell THIS endpoint what to read via escaped query vars
//   (shoutrrr strips the leading "_" and forwards the rest):
//     generic://<app>/api/generic?template=json&messagekey=alert_message&titlekey=alert_title&_messagekey=alert_message&_titlekey=alert_title&chat_id=<chat_id>
//
// Env vars (same as /api/send):
//   TELEGRAM_BOT_TOKEN - required
//   PROXY_SECRET       - optional but recommended, client must send it
//   DEFAULT_CHAT_ID    - optional, used when neither query nor body has a chat id

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Content-Type, X-Proxy-Secret"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(obj));
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && !req.readable) {
      if (Buffer.isBuffer(req.body)) return resolve(req.body);
      if (typeof req.body === "string") return resolve(Buffer.from(req.body));
      if (typeof req.body === "object") {
        try {
          return resolve(Buffer.from(JSON.stringify(req.body)));
        } catch {
          return resolve(Buffer.alloc(0));
        }
      }
      return resolve(Buffer.alloc(0));
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Case-insensitive lookup on a flat object: returns the value for the first
// matching key, or undefined.
function pickKey(obj, names) {
  if (!obj || typeof obj !== "object") return undefined;
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = k;
  for (const n of names) {
    const hit = lower[String(n).toLowerCase()];
    if (hit !== undefined) {
      const v = obj[hit];
      if (v !== undefined && v !== null && String(v) !== "") return v;
    }
  }
  return undefined;
}

// First non-empty string value in obj, skipping keys in skipLower (a Set of
// lowercased key names). Used as a last-resort message guess.
function firstStringValue(obj, skipLower) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of Object.keys(obj)) {
    if (skipLower && skipLower.has(k.toLowerCase())) continue;
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
}

const CHAT_KEYS = ["chat_id", "chatid", "chatID", "to", "channel", "target", "chat"];
const MESSAGE_KEYS = [
  "message",
  "text",
  "alert_message",
  "alert",
  "body",
  "content",
  "description",
  "msg",
  "value",
  "data",
];
const TITLE_KEYS = ["title", "alert_title", "subject", "header", "heading", "name", "caption"];
// Telegram sendMessage options we are willing to take from query/body.
const TELEGRAM_OPT_KEYS = [
  "parse_mode",
  "disable_notification",
  "disable_web_page_preview",
  "protect_content",
  "reply_to_message_id",
  "message_thread_id",
];

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return sendJson(res, 500, { ok: false, description: "TELEGRAM_BOT_TOKEN not configured" });
  }

  const base = `http://${req.headers.host || "localhost"}`;
  const incoming = new URL(req.url || "/", base);
  const query = Object.fromEntries(incoming.searchParams.entries());

  if (process.env.PROXY_SECRET) {
    const got = req.headers["x-proxy-secret"] || query.secret;
    if (got !== process.env.PROXY_SECRET) {
      return sendJson(res, 401, { ok: false, description: "Invalid proxy secret" });
    }
  }

  const allowGet = req.method === "GET";
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH" && !allowGet) {
    return sendJson(res, 405, { ok: false, description: "Use POST (or GET with ?message=)" });
  }

  const contentType = String(req.headers["content-type"] || "").toLowerCase();

  let raw = Buffer.alloc(0);
  if (!allowGet) {
    try {
      raw = await getRawBody(req);
    } catch (err) {
      console.error("generic read body error:", err);
      return sendJson(res, 400, { ok: false, description: "Could not read request body" });
    }
  }
  const rawText = raw.toString("utf8");

  // Parse body: try JSON first, then urlencoded, then treat as plain text.
  let bodyObj = null;
  let plainText = "";
  if (!allowGet && rawText) {
    if (contentType.includes("json") || rawText.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed === "object") bodyObj = parsed;
        else plainText = String(parsed);
      } catch {
        // Not JSON despite the hint -> fall through to plain text.
        plainText = rawText;
      }
    } else if (contentType.includes("x-www-form-urlencoded")) {
      bodyObj = Object.fromEntries(new URLSearchParams(rawText).entries());
    } else {
      plainText = rawText;
    }
  }

  // Custom key hints for this endpoint. NOTE: shoutrrr consumes `messagekey`/
  // `titlekey` itself, so to forward a hint here the shoutrrr URL must escape
  // it with "_" (e.g. `&_messagekey=alert_message`).
  const messageKeyHint =
    query.messagekey || query.messageKey || query.msgkey || query.msg_key || null;
  const titleKeyHint = query.titlekey || query.titleKey || null;

  // chat_id: forwarded query var, JSON data field ($chat_id lands here), or default.
  let chatId =
    pickKey(query, CHAT_KEYS) ||
    (bodyObj ? pickKey(bodyObj, CHAT_KEYS) : undefined) ||
    process.env.DEFAULT_CHAT_ID ||
    "";

  let title = "";
  let message = "";

  if (bodyObj) {
    if (messageKeyHint && bodyObj[messageKeyHint] !== undefined) {
      message = String(bodyObj[messageKeyHint]);
    } else {
      const m = pickKey(bodyObj, MESSAGE_KEYS);
      if (m !== undefined) message = String(m);
    }
    if (titleKeyHint && bodyObj[titleKeyHint] !== undefined) {
      title = String(bodyObj[titleKeyHint]);
    } else {
      const t = pickKey(bodyObj, TITLE_KEYS);
      // Avoid double-counting when title and message resolved from the same key.
      if (t !== undefined && String(t) !== message) title = String(t);
    }
    // Last resort: first string value that isn't a routing/option key.
    if (!message && !title) {
      const skip = new Set([
        ...CHAT_KEYS.map((k) => k.toLowerCase()),
        ...TELEGRAM_OPT_KEYS.map((k) => k.toLowerCase()),
        "secret",
        "method",
      ]);
      const guess = firstStringValue(bodyObj, skip);
      if (guess !== undefined) message = String(guess);
    }
    // Query ?title= still works as a title override for JSON payloads.
    if (!title && query.title) title = String(query.title);
    // GET-style ?message=/ ?text= fallback when body had no usable text.
    if (!message) {
      const qm = pickKey(query, MESSAGE_KEYS);
      if (qm !== undefined) message = String(qm);
    }
  } else if (plainText) {
    message = plainText;
    title = query.title ? String(query.title) : "";
  } else {
    // Empty body (or GET): read everything from the query string.
    const qm = pickKey(query, MESSAGE_KEYS);
    if (qm !== undefined) message = String(qm);
    if (query.title) title = String(query.title);
  }

  message = String(message || "").trim();
  title = String(title || "").trim();
  chatId = String(chatId || "").trim();

  // The shoutrrr `title` prop arrives inside the JSON payload (not forwarded),
  // so an empty title here just means "no title was sent" - that's fine.
  const text = title && message ? `${title}\n${message}` : message || title;
  if (!text) {
    return sendJson(res, 400, {
      ok: false,
      description:
        "No message found. With template=json send {\"message\":\"...\"} (optional \"title\"); without a template POST raw text. Provide chat_id via ?chat_id=, a $chat_id data field, or DEFAULT_CHAT_ID.",
    });
  }
  if (!chatId) {
    return sendJson(res, 400, {
      ok: false,
      description:
        "chat_id is required. Provide it via ?chat_id= query (forwarded by shoutrrr), a $chat_id data field in template=json mode, or set DEFAULT_CHAT_ID.",
    });
  }

  const params = { chat_id: chatId, text };
  // Pass through common Telegram options from query or JSON body (query wins).
  const optSource = { ...(bodyObj || {}), ...query };
  for (const k of TELEGRAM_OPT_KEYS) {
    const v = pickKey(optSource, [k]);
    if (v !== undefined && v !== "") params[k] = v;
  }

  try {
    const upstream = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(buf);
  } catch (err) {
    console.error("generic error:", err);
    return sendJson(res, 502, { ok: false, description: "Upstream fetch failed" });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
