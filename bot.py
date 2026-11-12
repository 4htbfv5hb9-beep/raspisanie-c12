import logging
import os
import sqlite3
from contextlib import closing
from pathlib import Path

from telegram import Update
from telegram.error import Forbidden, TelegramError
from telegram.ext import Application, CommandHandler, ContextTypes

BOT_TOKEN = os.environ["BOT_TOKEN"]
DATABASE_PATH = os.getenv("DATABASE_PATH", "data/subscribers.sqlite3")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

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


def main() -> None:
    init_db()
    application = Application.builder().token(BOT_TOKEN).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("stop", stop))
    application.add_handler(CommandHandler("status", subscription_status))

    logger.info("Starting Telegram bot polling")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
