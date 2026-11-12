const ADMIN_TELEGRAM_ID = 924301242;
const STATE_KEY = "c12:shared-state";
const MAX_INIT_DATA_AGE_SECONDS = 300;
const MAX_BODY_BYTES = 100_000;

const DEFAULT_STATE = {
  scheduleOverrides: {},
  dutyOverrides: {},
  updatedAt: null
};

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  ));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyTelegramInitData(initData, botToken) {
  if (typeof initData !== "string" || !botToken) return null;

  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash");
  if (!suppliedHash) return null;
  params.delete("hash");

  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const checkString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secretKey = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  const expectedHash = hex(await hmac(secretKey, checkString));

  if (!constantTimeEqual(expectedHash, suppliedHash.toLowerCase())) return null;

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || now - authDate > MAX_INIT_DATA_AGE_SECONDS || authDate > now + 30) {
    return null;
  }

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Vary": "Origin"
        }
      });
    }

    if (!env.C12_DATA) return json({ error: "KV binding C12_DATA is missing" }, 500, origin);

    if (request.method === "GET") {
      const state = await env.C12_DATA.get(STATE_KEY, "json");
      return json(state || DEFAULT_STATE, 200, origin);
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413, origin);

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: "Invalid JSON" }, 400, origin);
    }

    const user = await verifyTelegramInitData(body.initData, env.BOT_TOKEN);
    if (!user || Number(user.id) !== ADMIN_TELEGRAM_ID) {
      return json({ error: "Access denied" }, 403, origin);
    }

    const state = body.state;
    if (
      !isPlainObject(state) ||
      !isPlainObject(state.scheduleOverrides) ||
      !isPlainObject(state.dutyOverrides)
    ) {
      return json({ error: "Invalid state format" }, 400, origin);
    }

    const saved = {
      scheduleOverrides: state.scheduleOverrides,
      dutyOverrides: state.dutyOverrides,
      updatedAt: new Date().toISOString()
    };

    await env.C12_DATA.put(STATE_KEY, JSON.stringify(saved));
    return json({ success: true, updatedAt: saved.updatedAt }, 200, origin);
  }
};
