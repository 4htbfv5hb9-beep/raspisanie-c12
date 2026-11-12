import asyncio
import logging
import os
import re
import sqlite3
import urllib.request
from contextlib import closing
from pathlib import Path

from bs4 import BeautifulSoup

from telegram import Update
from telegram.error import Forbidden, TelegramError
from telegram.ext import Application, CommandHandler, ContextTypes

BOT_TOKEN = os.environ["BOT_TOKEN"]
DATABASE_PATH = os.getenv("DATABASE_PATH", "data/subscribers.sqlite3")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
REPLACEMENTS_URL = "https://bask-rb.ru/%D0%B7%D0%B0%D0%BC%D0%B5%D0%BD%D1%8B"
CHECK_INTERVAL_SECONDS = 90 * 60  # 1 hour 30 minutes

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("raspisanie-c12")


def connect_db() -> sqlite3.Connection:
    path = Path(DATABASE_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with closing(connect_db()) as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS monitor_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS subscribers (
                chat_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        db.commit()


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat is None or update.effective_user is None:
        return

    user = update.effective_user
    chat_id = update.effective_chat.id

    with closing(connect_db()) as db:
        db.execute(
            """
            INSERT INTO subscribers (chat_id, username, first_name, is_active)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(chat_id) DO UPDATE SET
                username = excluded.username,
                first_name = excluded.first_name,
                is_active = 1,
                updated_at = CURRENT_TIMESTAMP
            """,
            (chat_id, user.username, user.first_name),
        )
        db.commit()

    await update.effective_message.reply_text(
        "🔔 Готово! Ты подписан(а) на личные уведомления группы С-12.\n\n"
        "Я буду присылать сообщения о новых заменах и изменениях расписания.\n"
        "Чтобы отключить уведомления, отправь /stop."
    )


async def stop(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat is None:
        return

    with closing(connect_db()) as db:
        db.execute(
            """
            UPDATE subscribers
            SET is_active = 0, updated_at = CURRENT_TIMESTAMP
            WHERE chat_id = ?
            """,
            (update.effective_chat.id,),
        )
        db.commit()

    await update.effective_message.reply_text(
        "Уведомления отключены. Чтобы снова подписаться, отправь /start."
    )


async def subscription_status(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    if update.effective_chat is None:
        return

    with closing(connect_db()) as db:
        row = db.execute(
            "SELECT is_active FROM subscribers WHERE chat_id = ?",
            (update.effective_chat.id,),
        ).fetchone()

    if row and row["is_active"]:
        message = "✅ Ты подписан(а) на уведомления С-12."
    else:
        message = "Подписки нет. Отправь /start, чтобы получать уведомления."
    await update.effective_message.reply_text(message)


async def send_to_subscribers(
    application: Application, text: str
) -> tuple[int, int]:
    """Send one notification to every active subscriber; return (sent, failed)."""
    with closing(connect_db()) as db:
        rows = db.execute(
            "SELECT chat_id FROM subscribers WHERE is_active = 1"
        ).fetchall()

    sent = 0
    failed = 0
    for row in rows:
        chat_id = row["chat_id"]
        try:
            await application.bot.send_message(chat_id=chat_id, text=text)
            sent += 1
        except Forbidden:
            # The user blocked the bot or revoked access; stop retrying.
            with closing(connect_db()) as db:
                db.execute(
                    "UPDATE subscribers SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?",
                    (chat_id,),
                )
                db.commit()
            failed += 1
        except TelegramError:
            logger.exception("Could not send notification to chat_id=%s", chat_id)
            failed += 1

    logger.info("Notification delivery: sent=%s failed=%s", sent, failed)
    return sent, failed



def fetch_group_replacements() -> str:
    """Fetch the college page and extract the С-12 section."""
    request = urllib.request.Request(
        REPLACEMENTS_URL,
        headers={"User-Agent": "Mozilla/5.0 (compatible; RaspisanieC12Bot/1.0)"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        html = response.read()

    soup = BeautifulSoup(html, "html.parser")
    lines = [
        re.sub(r"\\s+", " ", line).strip()
        for line in soup.get_text("\\n").replace("\\xa0", " ").splitlines()
    ]
    lines = [line for line in lines if line]

    start = None
    for index, line in enumerate(lines):
        if re.match(r"^С[-‑–]12(?:\\s|\\||$)", line, re.IGNORECASE):
            start = index
            break

    if start is None:
        raise ValueError("Не удалось найти группу С-12 на странице замен")

    section = [lines[start]]
    group_pattern = re.compile(
        r"^(?:А|ВВ|ГД|ДЗ|ЗУ|ПО|СМ?|ЭСТУ|ЛГ)[-‑–]\\d{2}(?:\\s|\\||$)",
        re.IGNORECASE,
    )
    for line in lines[start + 1:]:
        if group_pattern.match(line):
            break
        section.append(line)

    return "\\n".join(section)


async def check_replacements(application: Application) -> None:
    try:
        current = await asyncio.to_thread(fetch_group_replacements)

        with closing(connect_db()) as db:
            previous = db.execute(
                "SELECT value FROM monitor_state WHERE key = 'c12_snapshot'"
            ).fetchone()

            if previous is None:
                # Save the first successful read as a baseline; do not send old data.
                db.execute(
                    "INSERT INTO monitor_state (key, value) VALUES ('c12_snapshot', ?)",
                    (current,),
                )
                db.commit()
                logger.info("Saved initial С-12 replacement snapshot")
                return

            if previous["value"] == current:
                logger.info("No changes in С-12 replacements")
                return

            db.execute(
                "UPDATE monitor_state SET value = ?, updated_at = CURRENT_TIMESTAMP "
                "WHERE key = 'c12_snapshot'",
                (current,),
            )
            db.commit()

        message = (
            "📢 Изменения в заменах группы С-12!\\n\\n"
            f"{current}\\n\\nИсточник: {REPLACEMENTS_URL}"
        )
        await send_to_subscribers(application, message)
    except Exception:
        logger.exception("Не удалось проверить замены С-12")


async def replacement_monitor(application: Application) -> None:
    # First read establishes a baseline; subsequent reads run every 90 minutes.
    while True:
        await check_replacements(application)
        await asyncio.sleep(CHECK_INTERVAL_SECONDS)


async def post_init(application: Application) -> None:
    application.create_task(replacement_monitor(application))


def main() -> None:
    init_db()
    application = Application.builder().token(BOT_TOKEN).post_init(post_init).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("stop", stop))
    application.add_handler(CommandHandler("status", subscription_status))

    logger.info("Starting Telegram bot polling")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
