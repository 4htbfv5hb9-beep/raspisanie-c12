const ADMIN_TELEGRAM_ID = 924301242;
const STATE_KEY = "c12:shared-state";
const SUBSCRIBERS_KEY = "c12:subscribers";
const MAX_INIT_DATA_AGE_SECONDS = 300;
const MAX_BODY_BYTES = 100_000;

const GROUP_STUDENTS = [
  "Адиятов Амир Артурович",
  "Баталов Данил Айратович",
  "Батеева Виктория Руслановна",
  "Борисова Мария Артемовна",
  "Габитова Зульфия Ильдаровна",
  "Динисламова Резеда Шарифовна",
  "Хабибрахманов Таир Рустемович",
  "Ишмурзина Найля Азатовна",
  "Казин Расуль Залилович",
  "Касимов Гайсар Гайнанович",
  "Мухарямова Александра Денисовна",
  "Низамутдинова Маргарита Рафисовна",
  "Николаев Арсений Леонидович",
  "Родина Арина Артемовна",
  "Рублев Илья Владимирович",
  "Суфьянова Вилена Ильмировна",
  "Швевель Милена Фёдоровна",
  "Бобков Макар Сергеевич",
  "Васильева Арина Александровна",
  "Гафиятуллин Денис Рафисович",
  "Дронь Валерий Юрьевич",
  "Ерыкалин Кирилл Анатольевич",
  "Ишмуратов Радмир Русланович",
  "Камаев Савелий Константинович",
  "Клименко Кирилл Сергеевич",
  "Мусин Тимур Артурович",
  "Русеков Роман Евгеньевич",
  "Сайфуллин Амир Рамилевич",
  "Сенькин Артем Павлович",
  "Сукбаев Мирон Артурович",
  "Уразгулова Камилла Айнуровна",
  "Фаизов Вильдан Артурович",
  "Мухаматдяров Глеб Константинович",
  "Пучков Григорий Константинович"
];

const DUTY_ANCHOR_DATE = "2026-11-12";
const DUTY_ANCHOR_INDEX = GROUP_STUDENTS.indexOf("Николаев Арсений Леонидович");

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
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
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
  if (!Number.isFinite(authDate) || now - authDate > MAX_INIT_DATA_AGE_SECONDS || authDate > now + 30) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch { return null; }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram API ${method} failed`);
  return result.result;
}

async function sendText(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [[{ text: "📋 Список группы" }]],
      resize_keyboard: true,
      is_persistent: true
    }
  });
}

function yekaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Yekaterinburg",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const result = {};
  for (const p of parts) if (p.type !== "literal") result[p.type] = p.value;
  return result;
}

function dutyForDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1, day));
  const anchor = new Date(Date.UTC(2026, 10, 12));
  if (target < anchor || target.getUTCDay() === 0) return null;
  let schoolDays = 0;
  for (let d = new Date(anchor); d < target; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0) schoolDays++;
  }
  return GROUP_STUDENTS[(DUTY_ANCHOR_INDEX + schoolDays) % GROUP_STUDENTS.length];
}

function groupListMessage() {
  const p = yekaDateParts();
  const date = `${p.year}-${p.month}-${p.day}`;
  const duty = dutyForDate(date);
  const lines = ["📋 Список группы С-12", ""];
  GROUP_STUDENTS.forEach((student, i) => {
    lines.push(`${i + 1}. ${student}${student === duty ? " ⭐ ДЕЖУРНЫЙ" : ""}`);
  });
  lines.push("", duty ? `👤 Дежурный на сегодня: ${duty}` : "Сегодня воскресенье — дежурства нет.");
  return lines.join("\n");
}

async function handleTelegramUpdate(update, env) {
  const message = update.message;
  if (!message || !message.chat || message.chat.type !== "private" || !message.from) return;

  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const command = text.split(/\s+/)[0].split("@")[0];

  if (command === "/start") {
    const subscribers = await env.C12_DATA.get(SUBSCRIBERS_KEY, "json") || [];
    if (!subscribers.includes(chatId)) subscribers.push(chatId);
    await env.C12_DATA.put(SUBSCRIBERS_KEY, JSON.stringify(subscribers));
    await sendText(env, chatId,
      "🔔 Готово! Ты подписан(а) на личные уведомления группы С-12.\n\n" +
      "Я буду присылать сообщения о новых заменах и изменениях расписания.\n" +
      "Чтобы отключить уведомления, отправь /stop.");
  } else if (command === "/stop") {
    const subscribers = await env.C12_DATA.get(SUBSCRIBERS_KEY, "json") || [];
    await env.C12_DATA.put(SUBSCRIBERS_KEY, JSON.stringify(subscribers.filter(id => id !== chatId)));
    await sendText(env, chatId, "Уведомления отключены. Чтобы снова подписаться, отправь /start.");
  } else if (command === "/status") {
    const subscribers = await env.C12_DATA.get(SUBSCRIBERS_KEY, "json") || [];
    await sendText(env, chatId, subscribers.includes(chatId)
      ? "✅ Ты подписан(а) на уведомления С-12."
      : "Подписки нет. Отправь /start, чтобы получать уведомления.");
  } else if (text === "📋 Список группы" || command === "/list") {
    await sendText(env, chatId, groupListMessage());
  } else {
    await sendText(env, chatId, "Привет! Я бот расписания С-12.\n\nКоманды:\n/start — подписаться на уведомления\n/stop — отписаться\n/status — проверить подписку\n/list — список группы и дежурный");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    if (url.pathname.startsWith("/internal/")) {
      if (request.method !== "POST" || !env.BOT_TOKEN || !env.C12_DATA) {
        return json({ ok: false }, 404, origin);
      }
      const auth = request.headers.get("Authorization") || "";
      if (!constantTimeEqual(auth, `Bearer ${env.BOT_TOKEN}`)) {
        return json({ ok: false }, 403, origin);
      }
      try {
        if (url.pathname === "/internal/sync-subscribers") {
          const body = await request.json();
          if (!Array.isArray(body.subscribers) || body.subscribers.length > 10000 ||
              !body.subscribers.every(id => Number.isSafeInteger(Number(id)))) {
            return json({ ok: false, error: "Invalid subscribers" }, 400, origin);
          }
          const subscribers = [...new Set(body.subscribers.map(Number))];
          await env.C12_DATA.put(SUBSCRIBERS_KEY, JSON.stringify(subscribers));
          return json({ ok: true, count: subscribers.length }, 200, origin);
        }
        if (url.pathname === "/internal/notify") {
          const body = await request.json();
          if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000) {
            return json({ ok: false, error: "Invalid message" }, 400, origin);
          }
          const subscribers = await env.C12_DATA.get(SUBSCRIBERS_KEY, "json") || [];
          let sent = 0;
          for (const chatId of subscribers) {
            try { await sendText(env, chatId, body.text); sent++; }
            catch (error) { console.error("Notification delivery failed"); }
          }
          return json({ ok: true, sent, total: subscribers.length }, 200, origin);
        }
        if (url.pathname === "/internal/setup-webhook") {
          if (!env.TELEGRAM_WEBHOOK_SECRET) {
            return json({ ok: false, error: "Webhook secret missing" }, 500, origin);
          }
          const webhookUrl = `${url.origin}/telegram/c12-s12-updates`;
          const current = await telegram(env, "getWebhookInfo", {});
          if (current.url !== webhookUrl) {
            await telegram(env, "setWebhook", {
              url: webhookUrl,
              secret_token: env.TELEGRAM_WEBHOOK_SECRET,
              allowed_updates: ["message"],
              drop_pending_updates: false
            });
          }
          await env.C12_DATA.put("c12:webhook:configured", "1");
          return json({ ok: true, configured: true, url: webhookUrl }, 200, origin);
        }
        return json({ ok: false }, 404, origin);
      } catch (error) {
        console.error("Internal request failed");
        return json({ ok: false, error: "Internal operation failed" }, 500, origin);
      }
    }

    if (url.pathname.startsWith("/telegram/")) {
      if (request.method !== "POST" || !env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ ok: false }, 404, origin);
      }
      const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!constantTimeEqual(suppliedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
        return json({ ok: false }, 403, origin);
      }
      if (!env.C12_DATA || !env.BOT_TOKEN) return json({ ok: false, error: "Worker secrets or KV binding missing" }, 500, origin);
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
        return json({ ok: true }, 200, origin);
      } catch (error) {
        return json({ ok: false, error: "Update processing failed" }, 500, origin);
      }
    }

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
    try { body = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON" }, 400, origin); }

    const user = await verifyTelegramInitData(body.initData, env.BOT_TOKEN);
    if (!user || Number(user.id) !== ADMIN_TELEGRAM_ID) return json({ error: "Access denied" }, 403, origin);

    const state = body.state;
    if (!isPlainObject(state) || !isPlainObject(state.scheduleOverrides) || !isPlainObject(state.dutyOverrides)) {
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

// Trigger Cloudflare Workers Git deployment.
