const ADMIN_TELEGRAM_ID = 924301242;
const STATE_KEY = "c12:shared-state";
const SUBSCRIBERS_KEY = "c12:subscribers";
const C33_SUBSCRIBERS_KEY = "c33:subscribers";
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

const GROUP_STUDENTS_C33 = [
  "Буренкова София Владимировна","Валиева Камилла Азаматовна","Ежова Анастасия Юрьевна","Искужин Тимур Ринатович","Куцык Артём Александрович","Миронова Анастасия Андреевна","Пономарев Кирилл Константинович","Сарваров Раиль Ринатович","Сираев Амир Раилевич","Суфиянов Айрат Русланович","Туктагулов Рифат Маратович","Хасанова Азалия Раилевна","Шарифуллина Алина Рустемовна","Эрсез Тимур Мустафович","Варанкина Мирра Глебовна","Вильданова Риана Рустамовна","Гарипов Артур Азатович","Давлетшин Галиаскар Динисламович","Дударев Никита Григорьевич","Еникеев Даниил Дмитриевич","Закиров Артем Тимурович","Идрисов Альберт Артурович","Котенко Назар Максимович","Максютов Тимур Рафисович","Прокопьева Валерия Евгеньевна","Рафиков Тимур Альбертович","Талипов Алмаз Ринатович","Шарафеев Ринат Рифатович"
];
const GAME_GROUPS = { C12: GROUP_STUDENTS, C33: GROUP_STUDENTS_C33 };

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

async function verifyTelegramInitData(initData, botToken, maxAgeSeconds = MAX_INIT_DATA_AGE_SECONDS) {
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
  if (!Number.isFinite(authDate) || now - authDate > maxAgeSeconds || authDate > now + 30) return null;
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

async function sendText(env, chatId, text, parseMode = null) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
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
      "🔴 *РАСПИСАНИЕ ГАПОУ БАСКА*\n\n" +
      "Добро пожаловать! 👋\n\n" +
      "Рад видеть тебя в официальном боте расписания групп на 2026–2027 учебный год.\n\n" +
      "Здесь ты можешь:\n\n" +
      "📅 Смотреть расписание занятий.\n\n" +
      "🗓 Узнавать расписание на сегодня.\n\n" +
      "🔔 Проверять время звонков.\n\n" +
      "📢 Смотреть актуальные замены.\n\n" +
      "Всё необходимое для учёбы — в одном месте.",
      "Markdown");
  } else if (command === "/start33") {
    const subscribers = await env.C12_DATA.get(C33_SUBSCRIBERS_KEY, "json") || [];
    if (!subscribers.includes(chatId)) subscribers.push(chatId);
    await env.C12_DATA.put(C33_SUBSCRIBERS_KEY, JSON.stringify(subscribers));
    await sendText(env, chatId, "🔔 Ты подписан(а) на уведомления С-33. Для отключения отправь /stop33.");
  } else if (command === "/stop33") {
    const subscribers = await env.C12_DATA.get(C33_SUBSCRIBERS_KEY, "json") || [];
    await env.C12_DATA.put(C33_SUBSCRIBERS_KEY, JSON.stringify(subscribers.filter(id => id !== chatId)));
    await sendText(env, chatId, "Уведомления С-33 отключены. Для подписки снова отправь /start33.");
  } else if (command === "/stop") {
    const subscribers = await env.C12_DATA.get(SUBSCRIBERS_KEY, "json") || [];
    await env.C12_DATA.put(SUBSCRIBERS_KEY, JSON.stringify(subscribers.filter(id => id !== chatId)));
    await sendText(env, chatId, "Уведомления отключены. Чтобы снова подписаться, отправь /start.");
  } else if (command === "/stats") {
    if (Number(message.from.id) !== ADMIN_TELEGRAM_ID) {
      await sendText(env, chatId, "⛔ Эта команда доступна только администратору.");
      return;
    }
    const subscribers = await env.C12_DATA.get(SUBSCRIBERS_KEY, "json") || [];
    await sendText(env, chatId,
      `📊 Статистика бота\n\n🔔 Подписано на уведомления: ${subscribers.length} человек`);
  } else if (command === "/status") {
    const subscribers = await env.C12_DATA.get(SUBSCRIBERS_KEY, "json") || [];
    await sendText(env, chatId, subscribers.includes(chatId)
      ? "✅ Ты подписан(а) на уведомления С-12."
      : "Подписки нет. Отправь /start, чтобы получать уведомления.");
  } else if (text === "📋 Список группы" || command === "/list") {
    await sendText(env, chatId, groupListMessage());
  } else if (command === "/help") {
    await sendText(env, chatId,
      "Привет! Я бот расписания ГАПОУ БАСКА\n\n" +
      "/start — подписаться на уведомления\n\n" +
      "/stop — отписаться\n\n" +
      "/status — проверить подписку");
  } else {
    await sendText(env, chatId,
      "Привет! Я бот расписания ГАПОУ БАСКА\n\n" +
      "/start — подписаться на уведомления\n\n" +
      "/stop — отписаться\n\n" +
      "/status — проверить подписку");
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
        if (url.pathname === "/internal/sync-replacements") {
          const body = await request.json();
          if (!["С-12", "С-33"].includes(body.group) ||
              typeof body.date !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(body.date) ||
              !Array.isArray(body.entries) || body.entries.length > 100) {
            return json({ ok: false, error: "Invalid replacements payload" }, 400, origin);
          }
          const entries = body.entries.filter(item =>
            item && item.date === body.date && item.group === body.group &&
            Number.isInteger(item.pair) && item.pair >= 1 && item.pair <= 12 &&
            ["subject", "teacher", "room"].every(key => item[key] == null || (typeof item[key] === "string" && item[key].length <= 120))
          );
          const key = body.group === "С-33" ? "c33:replacements" : "c12:replacements";
          const saved = { date: body.date, group: body.group, entries, updatedAt: new Date().toISOString() };
          await env.C12_DATA.put(key, JSON.stringify(saved));
          return json({ ok: true, count: entries.length, updatedAt: saved.updatedAt }, 200, origin);
        }
        if (url.pathname === "/internal/notify") {
          const body = await request.json();
          if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000) {
            return json({ ok: false, error: "Invalid message" }, 400, origin);
          }
          const group = body.group || "C12";
          if (group !== "C12" && group !== "C33") return json({ ok: false, error: "Invalid group" }, 400, origin);
          const key = group === "C33" ? C33_SUBSCRIBERS_KEY : SUBSCRIBERS_KEY;
          const subscribers = await env.C12_DATA.get(key, "json") || [];
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

    if (url.pathname === "/games") {
      const group = url.searchParams.get("group") || "C12";
      if (!Object.hasOwn(GAME_GROUPS, group)) return json({ error: "Неизвестная группа" }, 400, origin);
      const students = GAME_GROUPS[group];
      if (request.method === "GET") {
        const data = await env.C12_DATA.get("c12:games", "json") || { profiles: {}, claimed: {}, scores: {} };
        const leaderboard = students.map(student => ({
          student,
          score: Number(data.scores?.[group + ":" + student] ?? (group === "C12" ? data.scores?.[student] : 0) ?? 0)
        })).filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score || a.student.localeCompare(b.student, "ru"));
        return json({ ok: true, group, leaderboard }, 200, origin);
      }
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
      const raw = await request.text();
      if (raw.length > 10000) return json({ error: "Request too large" }, 413, origin);
      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400, origin); }
      const user = await verifyTelegramInitData(body.initData, env.BOT_TOKEN, 86400);
      if (!user || !Number.isSafeInteger(Number(user.id))) return json({ error: "Открой приложение через Telegram и попробуй снова" }, 401, origin);
      const selectedGroup = body.group || group;
      if (!Object.hasOwn(GAME_GROUPS, selectedGroup)) return json({ error: "Неизвестная группа" }, 400, origin);
      const selectedStudents = GAME_GROUPS[selectedGroup];
      const data = await env.C12_DATA.get("c12:games", "json") || { profiles: {}, claimed: {}, scores: {} };
      data.profiles ||= {}; data.claimed ||= {}; data.scores ||= {};
      const telegramId = String(user.id);
      let profiles = data.profiles[telegramId];
      if (typeof profiles === "string") profiles = { C12: profiles };
      else if (profiles && profiles.student && profiles.group) profiles = { [profiles.group]: profiles.student };
      profiles ||= {};
      const profile = profiles[selectedGroup] || null;
      if (body.action === "register") {
        if (profile) return json({ ok: true, student: profile, group: selectedGroup }, 200, origin);
        const student = selectedStudents.find(name => name === body.student);
        if (!student) return json({ error: "Выбери фамилию из списка выбранной группы" }, 400, origin);
        const claimKey = selectedGroup + ":" + student;
        const existingClaim = data.claimed[claimKey] || (selectedGroup === "C12" ? data.claimed[student] : null);
        if (existingClaim && existingClaim !== telegramId) {
          return json({ error: "Этот профиль уже привязан к другому Telegram-аккаунту. Обратись к старосте." }, 409, origin);
        }
        profiles[selectedGroup] = student;
        data.profiles[telegramId] = profiles;
        data.claimed[claimKey] = telegramId;
        const scoreKey = selectedGroup + ":" + student;
        data.scores[scoreKey] ??= selectedGroup === "C12" ? (data.scores[student] || 0) : 0;
        await env.C12_DATA.put("c12:games", JSON.stringify(data));
        return json({ ok: true, student, group: selectedGroup }, 200, origin);
      }
      if (body.action === "whoami") return json({ ok: true, student: profile, group: profile ? selectedGroup : null }, 200, origin);
      if (!profile) return json({ error: "Сначала выбери своё имя в этой группе" }, 403, origin);
      const scoreKey = selectedGroup + ":" + profile;
      if (body.action === "score") {
        const limits = { memory: 60, darts: 100, karate: 100 };
        const game = body.game;
        const points = Number(body.points);
        if (!Object.hasOwn(limits, game) || !Number.isInteger(points) || points < 0 || points > limits[game]) {
          return json({ error: "Некорректный результат игры" }, 400, origin);
        }
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Yekaterinburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        data.daily ||= {};
        const dailyKey = telegramId + ":" + day;
        const used = data.daily[dailyKey] || 0;
        if (used + points > 500) return json({ error: "Дневной лимит — 500 баллов. Попробуй завтра!" }, 429, origin);
        data.daily[dailyKey] = used + points;
        data.scores[scoreKey] = (data.scores[scoreKey] || 0) + points;
        await env.C12_DATA.put("c12:games", JSON.stringify(data));
        return json({ ok: true, student: profile, group: selectedGroup, added: points, total: data.scores[scoreKey] }, 200, origin);
      }
      return json({ error: "Unknown action" }, 400, origin);
    }

    if (url.pathname === "/replacements" && request.method === "GET") {
      const [c12, c33] = await Promise.all([
        env.C12_DATA.get("c12:replacements", "json"),
        env.C12_DATA.get("c33:replacements", "json")
      ]);
      return json({ ok: true, groups: { C12: c12, C33: c33 } }, 200, origin);
    }

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
