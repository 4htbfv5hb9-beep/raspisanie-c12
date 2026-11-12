import base64
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from bs4 import BeautifulSoup
from cryptography.fernet import Fernet, InvalidToken

BOT_TOKEN = os.environ["BOT_TOKEN"]
STATE_PATH = Path("data/state.enc")
REPLACEMENTS_URL = "https://bask-rb.ru/%D0%B7%D0%B0%D0%BC%D0%B5%D0%BD%D1%8B"
REPLACEMENTS_URL_C33 = "https://bask-rb.ru/%D0%B7%D0%B0%D0%BC%D0%B5%D0%BD%D1%8B-2"
CHECK_INTERVAL_SECONDS = 5 * 60
MAX_TELEGRAM_TEXT = 4000
WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
WEBHOOK_MODE = os.environ.get("WEBHOOK_MODE", "").lower() in ("1", "true", "yes")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("c12-actions")


def cipher() -> Fernet:
    # Derive a stable encryption key from the Telegram bot token.
    key = base64.urlsafe_b64encode(hashlib.sha256(BOT_TOKEN.encode()).digest())
    return Fernet(key)


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {"offset": 0, "subscribers": [], "snapshot": None, "snapshot_c33": None, "last_check": 0}
    try:
        raw = cipher().decrypt(STATE_PATH.read_bytes())
        state = json.loads(raw.decode("utf-8"))
        if not isinstance(state, dict):
            raise ValueError("State file is not a JSON object")
        state.setdefault("offset", 0)
        state.setdefault("subscribers", [])
        state.setdefault("snapshot", None)
        state.setdefault("snapshot_c33", None)
        state.setdefault("last_check", 0)
        return state
    except (InvalidToken, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "Не удалось расшифровать data/state.enc. Не меняйте BOT_TOKEN, "
            "пока не сохранена резервная копия состояния."
        ) from exc


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    encrypted = cipher().encrypt(
        json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    STATE_PATH.write_bytes(encrypted)


def telegram(method: str, payload: dict) -> dict:
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data = urllib.parse.urlencode(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError:
        logger.exception("Telegram API request failed: %s", method)
        raise
    if not result.get("ok"):
        raise RuntimeError(f"Telegram API {method} error: {result}")
    return result["result"]


def send_message(chat_id: int, text: str, reply_markup: dict | None = None) -> None:
    payload = {"chat_id": chat_id, "text": text[:MAX_TELEGRAM_TEXT]}
    if reply_markup is not None:
        payload["reply_markup"] = json.dumps(reply_markup, ensure_ascii=False)
    telegram("sendMessage", payload)

def worker_post(path: str, payload: dict | None = None) -> dict:
    if not WORKER_URL:
        raise RuntimeError("WORKER_URL is not configured")
    data = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(
        f"{WORKER_URL}{path}",
        data=data,
        headers={
            "Authorization": f"Bearer {BOT_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "c12-schedule-bot/1.0 (+https://github.com/4htbfv5hb9-beep/raspisanie-c12)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Log only the response body and status; never print request headers or BOT_TOKEN.
        try:
            response_body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            response_body = "<response body unavailable>"
        logger.error("Cloudflare Worker returned HTTP %s for %s: %s",
                     exc.code, path, response_body)
        raise
    if not result.get("ok"):
        raise RuntimeError(f"Worker operation failed: {result}")
    return result


def sync_subscribers_with_worker(state: dict) -> None:
    result = worker_post("/internal/sync-subscribers", {
        "subscribers": state.get("subscribers", [])
    })
    logger.info("Синхронизировано подписчиков с Cloudflare: %d", result.get("count", 0))


def notify_subscribers(text: str, state: dict, group: str = "C12") -> None:
    if WORKER_URL:
        result = worker_post("/internal/notify", {"text": text[:MAX_TELEGRAM_TEXT], "group": group})
        logger.info("Уведомление отправлено через Cloudflare: %d/%d",
                    result.get("sent", 0), result.get("total", 0))
        return
    for chat_id in list(state["subscribers"]):
        try:
            send_message(chat_id, text)
        except Exception:
            logger.exception("Не удалось отправить сообщение chat_id=%s", chat_id)


GROUP_STUDENTS = [
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
    "Пучков Григорий Константинович",
]
DUTY_ANCHOR_DATE = date(2026, 11, 12)  # В этот день дежурил Николаев Арсений.
DUTY_ANCHOR_INDEX = GROUP_STUDENTS.index("Николаев Арсений Леонидович")
MENU_KEYBOARD = {
    "keyboard": [[{"text": "📋 Список группы"}]],
    "resize_keyboard": True,
    "is_persistent": True,
}


def duty_student(target: date) -> str | None:
    if target < DUTY_ANCHOR_DATE:
        return None
    school_days = 0
    current = DUTY_ANCHOR_DATE
    while current < target:
        current += timedelta(days=1)
        if current.weekday() != 6:  # Воскресенье — без дежурства.
            school_days += 1
    if target.weekday() == 6:
        return None
    return GROUP_STUDENTS[(DUTY_ANCHOR_INDEX + school_days) % len(GROUP_STUDENTS)]


def group_list_message(target: date | None = None) -> str:
    target = target or datetime.now(timezone(timedelta(hours=5))).date()
    duty = duty_student(target)
    lines = ["📋 Список группы С-12", ""]
    for index, student in enumerate(GROUP_STUDENTS, start=1):
        marker = " ⭐ ДЕЖУРНЫЙ" if student == duty else ""
        lines.append(f"{index}. {student}{marker}")
    lines.extend(["", f"👤 Дежурный на сегодня: {duty}" if duty else
                  "Сегодня воскресенье — дежурства нет."])
    return "\n".join(lines)


def fetch_group_replacements(group: str = "С-12") -> str:
    url = REPLACEMENTS_URL_C33 if group == "С-33" else REPLACEMENTS_URL
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; RaspisanieC12Bot/1.0)"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        html = response.read()

    soup = BeautifulSoup(html, "html.parser")
    lines = [
        re.sub(r"\s+", " ", line).strip()
        for line in soup.get_text("\n").replace("\xa0", " ").splitlines()
    ]
    lines = [line for line in lines if line]

    start = None
    target_pattern = re.compile(rf"^{re.escape(group)}(?:\s|\||$)", re.IGNORECASE)
    for index, line in enumerate(lines):
        if target_pattern.match(line):
            start = index
            break
    if start is None:
        raise ValueError(f"Не удалось найти группу {group} на странице замен")

    section = [lines[start]]
    group_pattern = re.compile(
        r"^(?:А|ВВ|ГД|ДЗ|ЗУ|ПО|СМ?|ЭСТУ|ЛГ)[-‑–]\d{2}(?:\s|\||$)",
        re.IGNORECASE,
    )
    for line in lines[start + 1:]:
        if group_pattern.match(line):
            break
        section.append(line)
    return "\n".join(section)

def process_updates(state: dict) -> None:
    updates = telegram(
        "getUpdates",
        {
            "offset": state["offset"],
            "timeout": 0,
            "allowed_updates": json.dumps(["message"]),
            "limit": 100,
        },
    )
    logger.info("Получено обновлений Telegram: %d", len(updates))
    for update in updates:
        state["offset"] = update["update_id"] + 1
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        if chat.get("type") != "private":
            continue
        text = (message.get("text") or "").strip()
        command = text.split()[0].split("@")[0] if text else ""
        chat_id = int(chat["id"])

        logger.info("Получена команда %s в личном чате", command or "(пустое сообщение)")
        if command == "/start":
            if chat_id not in state["subscribers"]:
                state["subscribers"].append(chat_id)
            send_message(
                chat_id,
                "🔔 Готово! Ты подписан(а) на уведомления группы С-12.\n"
                "Я буду сообщать о новых заменах.\n"
                "Нажми «📋 Список группы», чтобы увидеть список и дежурного. "
                "Чтобы отключить уведомления, отправь /stop.",
                MENU_KEYBOARD,
            )
        elif command == "/stop":
            state["subscribers"] = [
                item for item in state["subscribers"] if item != chat_id
            ]
            send_message(chat_id, "Уведомления отключены. Для подписки снова отправь /start.")
        elif command == "/status":
            if chat_id in state["subscribers"]:
                answer = "✅ Ты подписан(а) на уведомления С-12."
            else:
                answer = "Подписки нет. Отправь /start, чтобы получать уведомления."
            send_message(chat_id, answer, MENU_KEYBOARD)
        elif text == "📋 Список группы":
            send_message(chat_id, group_list_message(), MENU_KEYBOARD)


def format_replacements(text: str) -> str:
    # В расписании колледжа используем "пара", а не "урок".
    replacements = {
        "уроков": "пар",
        "уроками": "парами",
        "уроках": "парах",
        "уроку": "паре",
        "уроком": "парой",
        "урока": "пары",
        "уроки": "пары",
        "урок": "пара",
    }
    pattern = re.compile(r"уроков|уроками|уроках|уроку|уроком|урока|уроки|урок", re.IGNORECASE)
    return pattern.sub(lambda match: replacements[match.group(0).lower()], text)


def check_replacements(state: dict) -> None:
    checks = [
        ("С-12", "snapshot", REPLACEMENTS_URL, "C12"),
        ("С-33", "snapshot_c33", REPLACEMENTS_URL_C33, "C33"),
    ]
    for group, snapshot_key, source_url, group_code in checks:
        try:
            current = format_replacements(fetch_group_replacements(group))
            previous = state.get(snapshot_key)
            if previous is None:
                state[snapshot_key] = current
                logger.info("Сохранён начальный снимок замен %s; старые изменения не рассылаются", group)
            elif previous != current:
                message = (
                    f"📢 Изменения в заменах группы {group}!\n\n"
                    f"{current}\n\nИсточник: {source_url}"
                )
                notify_subscribers(message, state, group_code)
                state[snapshot_key] = current
                logger.info("Обнаружено изменение %s; уведомления отправлены", group)
            else:
                logger.info("Изменений в заменах %s нет", group)
        except Exception:
            logger.exception("Не удалось проверить страницу замен %s; следующая попытка будет позже", group)
    state["last_check"] = int(time.time())

def main() -> None:
    state = load_state()
    if WEBHOOK_MODE:
        # Telegram delivers commands directly to Cloudflare; never call getUpdates in webhook mode.
        worker_post("/internal/setup-webhook")
        logger.info("Webhook mode active; Telegram polling skipped")
    else:
        # Keep polling until subscriber sync is confirmed and webhook mode is enabled.
        process_updates(state)
        if WORKER_URL:
            sync_subscribers_with_worker(state)
    now = int(time.time())
    if now - int(state.get("last_check", 0)) >= CHECK_INTERVAL_SECONDS:
        try:
            check_replacements(state)
        except Exception:
            logger.exception("Не удалось проверить страницу замен; следующая попытка будет позже")
    save_state(state)


if __name__ == "__main__":
    main()
