import base64
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
CHECK_INTERVAL_SECONDS = 90 * 60
MAX_TELEGRAM_TEXT = 4000

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
        return {"offset": 0, "subscribers": [], "snapshot": None, "last_check": 0}
    try:
        raw = cipher().decrypt(STATE_PATH.read_bytes())
        state = json.loads(raw.decode("utf-8"))
        if not isinstance(state, dict):
            raise ValueError("State file is not a JSON object")
        state.setdefault("offset", 0)
        state.setdefault("subscribers", [])
        state.setdefault("snapshot", None)
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


def send_message(chat_id: int, text: str) -> None:
    telegram("sendMessage", {"chat_id": chat_id, "text": text[:MAX_TELEGRAM_TEXT]})


def fetch_group_replacements() -> str:
    request = urllib.request.Request(
        REPLACEMENTS_URL,
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
    for index, line in enumerate(lines):
        if re.match(r"^С[-‑–]12(?:\s|\||$)", line, re.IGNORECASE):
            start = index
            break
    if start is None:
        raise ValueError("Не удалось найти группу С-12 на странице замен")

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
    for update in updates:
        state["offset"] = update["update_id"] + 1
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        if chat.get("type") != "private":
            continue
        text = (message.get("text") or "").strip()
        command = text.split()[0].split("@")[0] if text else ""
        chat_id = int(chat["id"])

        if command == "/start":
            if chat_id not in state["subscribers"]:
                state["subscribers"].append(chat_id)
            send_message(
                chat_id,
                "🔔 Готово! Ты подписан(а) на уведомления группы С-12.\n"
                "Я буду сообщать о новых заменах. Чтобы отключить уведомления, отправь /stop.",
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
            send_message(chat_id, answer)


def check_replacements(state: dict) -> None:
    current = fetch_group_replacements()
    previous = state.get("snapshot")
    if previous is None:
        state["snapshot"] = current
        logger.info("Сохранён начальный снимок замен С-12; старые изменения не рассылаются")
    elif previous != current:
        message = (
            "📢 Изменения в заменах группы С-12!\n\n"
            f"{current}\n\nИсточник: {REPLACEMENTS_URL}"
        )
        for chat_id in list(state["subscribers"]):
            try:
                send_message(chat_id, message)
            except Exception:
                logger.exception("Не удалось отправить сообщение chat_id=%s", chat_id)
        state["snapshot"] = current
        logger.info("Обнаружено изменение; уведомления отправлены подписчикам")
    else:
        logger.info("Изменений в заменах С-12 нет")
    state["last_check"] = int(time.time())


def main() -> None:
    state = load_state()
    # This workflow runs every five minutes. Telegram commands are handled on each run.
    process_updates(state)
    now = int(time.time())
    if now - int(state.get("last_check", 0)) >= CHECK_INTERVAL_SECONDS:
        try:
            check_replacements(state)
        except Exception:
            logger.exception("Не удалось проверить страницу замен; следующая попытка будет позже")
    save_state(state)


if __name__ == "__main__":
    main()
