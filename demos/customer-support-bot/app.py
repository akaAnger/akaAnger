"""Small, inspectable Telegram customer-support demo (standard library only)."""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

LOG = logging.getLogger("support_bot")
WORD = re.compile(r"[\w]+", re.UNICODE)
STOP = {"the", "a", "an", "is", "are", "do", "does", "how", "what", "i", "my", "to", "for", "can", "you", "and", "of", "in", "on"}


def words(value: str) -> set[str]:
    return {w for w in WORD.findall(value.casefold()) if len(w) > 2 and w not in STOP}


def load_env(path: str = ".env") -> None:
    """Load simple KEY=value settings without overriding the process environment."""
    source = Path(path)
    if not source.is_file():
        return
    for raw in source.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("Invalid .env setting; expected KEY=value")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


@dataclass(frozen=True)
class Config:
    token: str
    admin_id: int
    db_path: str = "data/support.sqlite3"
    knowledge_path: str = "knowledge.json"
    api_key: str = ""
    model: str = "gpt-4o-mini"

    @classmethod
    def from_env(cls) -> "Config":
        token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
        admin = os.getenv("ADMIN_CHAT_ID", "").strip()
        if not token or not admin.isdigit() or int(admin) <= 0:
            raise ValueError("Set TELEGRAM_BOT_TOKEN and a positive private ADMIN_CHAT_ID")
        return cls(token, int(admin), os.getenv("DB_PATH", cls.db_path),
                   os.getenv("KNOWLEDGE_PATH", cls.knowledge_path),
                   os.getenv("OPENAI_API_KEY", ""), os.getenv("OPENAI_MODEL", cls.model))


class Database:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, role TEXT NOT NULL,
                text TEXT NOT NULL, created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL,
                question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
                created_at INTEGER NOT NULL, closed_at INTEGER
            );
        """)

    def offset(self) -> int:
        row = self.conn.execute("SELECT value FROM state WHERE key='offset'").fetchone()
        return int(row[0]) if row else 0

    def set_offset(self, value: int) -> None:
        with self.conn:
            self.conn.execute("INSERT INTO state VALUES ('offset', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(value),))

    def log(self, chat_id: int, role: str, text: str) -> None:
        with self.conn:
            self.conn.execute("INSERT INTO messages(chat_id,role,text,created_at) VALUES (?,?,?,?)", (chat_id, role, text[:4000], int(time.time())))

    def ticket(self, chat_id: int, question: str) -> int:
        with self.conn:
            row = self.conn.execute("SELECT id FROM tickets WHERE chat_id=? AND status='open' ORDER BY id DESC LIMIT 1", (chat_id,)).fetchone()
            if row:
                return row[0]
            cur = self.conn.execute("INSERT INTO tickets(chat_id,question,created_at) VALUES (?,?,?)", (chat_id, question[:2000], int(time.time())))
            return int(cur.lastrowid)

    def open_tickets(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT id,chat_id,question FROM tickets WHERE status='open' ORDER BY id DESC LIMIT 10").fetchall()

    def get_ticket(self, ticket_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()

    def active_ticket(self, chat_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM tickets WHERE chat_id=? AND status='open' ORDER BY id DESC LIMIT 1", (chat_id,)).fetchone()

    def history(self, chat_id: int) -> list[sqlite3.Row]:
        rows = self.conn.execute("SELECT role,text FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 10", (chat_id,)).fetchall()
        return list(reversed(rows))

    def close(self, ticket_id: int) -> None:
        with self.conn:
            self.conn.execute("UPDATE tickets SET status='closed', closed_at=? WHERE id=?", (int(time.time()), ticket_id))

    def stats(self) -> tuple[int, int, int]:
        return (self.conn.execute("SELECT COUNT(DISTINCT chat_id) FROM messages WHERE role='user'").fetchone()[0],
                self.conn.execute("SELECT COUNT(*) FROM tickets").fetchone()[0],
                self.conn.execute("SELECT COUNT(*) FROM tickets WHERE status='open'").fetchone()[0])

    def forget(self, chat_id: int) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM messages WHERE chat_id=?", (chat_id,))
            self.conn.execute("DELETE FROM tickets WHERE chat_id=?", (chat_id,))


class Knowledge:
    def __init__(self, path: str):
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(raw, list) or not all(isinstance(x, dict) and isinstance(x.get("question"), str) and isinstance(x.get("answer"), str) and isinstance(x.get("keywords", []), list) and all(isinstance(k, str) for k in x.get("keywords", [])) for x in raw):
            raise ValueError("Knowledge must be a list of question/answer objects")
        self.entries = raw

    def match(self, question: str) -> dict | None:
        query = words(question)
        if not query:
            return None
        ranked = []
        for entry in self.entries:
            terms = words(entry["question"] + " " + " ".join(entry.get("keywords", [])))
            if not terms:
                continue
            coverage = len(query & terms) / len(query)
            ranked.append((coverage, len(query & terms), entry))
        if not ranked:
            return None
        score, common, entry = max(ranked, key=lambda item: (item[0], item[1]))
        return entry if score >= 0.5 and common >= (1 if len(query) == 1 else 2) else None


def post_json(url: str, payload: dict, headers: dict | None = None, timeout: int = 35) -> dict:
    data = json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


class Telegram:
    def __init__(self, token: str):
        self.url = f"https://api.telegram.org/bot{token}/"

    def call(self, method: str, payload: dict, timeout: int = 35) -> dict:
        response = post_json(self.url + method, payload, timeout=timeout)
        if not response.get("ok"):
            raise RuntimeError(f"Telegram {method}: {response.get('description', 'unknown error')}")
        return response["result"]

    def send(self, chat_id: int, text: str) -> None:
        for start in range(0, len(text), 4000):
            self.call("sendMessage", {"chat_id": chat_id, "text": text[start:start + 4000]})


def ai_answer(config: Config, question: str, entry: dict) -> str:
    """Optional reformulation grounded in exactly one matched FAQ entry."""
    if not config.api_key:
        return entry["answer"]
    payload = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": "Answer the customer's question using ONLY the supplied FAQ answer. If the FAQ does not contain the answer, output exactly HANDOFF. Keep the reply short. Do not invent policies or prices."},
            {"role": "user", "content": f"FAQ question: {entry['question']}\nFAQ answer: {entry['answer']}\nCustomer question: {question}"},
        ],
        "temperature": 0,
        "max_completion_tokens": 180,
    }
    try:
        result = post_json("https://api.openai.com/v1/chat/completions", payload,
                           {"Authorization": "Bearer " + config.api_key}, timeout=20)
        answer = result["choices"][0]["message"]["content"].strip()
        return answer if answer and answer != "HANDOFF" else ""
    except (OSError, KeyError, IndexError, ValueError, urllib.error.HTTPError):
        LOG.exception("AI request failed; using the verified FAQ answer")
        return entry["answer"]


class SupportBot:
    def __init__(self, config: Config, db: Database, knowledge: Knowledge, telegram: Telegram):
        self.config, self.db, self.knowledge, self.tg = config, db, knowledge, telegram

    def handle(self, update: dict) -> None:
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        if chat.get("type") != "private" or not isinstance(message.get("text"), str):
            return
        chat_id, text = int(chat["id"]), message["text"].strip()
        if not text:
            return
        if chat_id == self.config.admin_id and text.startswith("/"):
            self.admin(text)
            return
        if text.startswith("/start") or text.startswith("/help"):
            self.tg.send(chat_id, "Hi! Ask a question about our sample store. Type /human to reach a person or /forget to erase your conversation and tickets.")
        elif text == "/forget":
            self.db.forget(chat_id)
            self.tg.send(chat_id, "Your stored messages and tickets have been deleted.")
        elif text == "/human":
            self.db.log(chat_id, "user", "/human")
            self.handoff(chat_id, "Customer requested a person")
        elif text.startswith("/"):
            self.tg.send(chat_id, "Unknown command. Use /help or ask a question.")
        else:
            self.db.log(chat_id, "user", text)
            active = self.db.active_ticket(chat_id)
            if active:
                self.tg.send(self.config.admin_id, f"Follow-up for ticket #{active['id']}:\n{text[:2000]}\nHistory: /history {active['id']}")
                self.tg.send(chat_id, f"Added your message to ticket #{active['id']}. Your request is with the support team.")
                return
            entry = self.knowledge.match(text)
            answer = ai_answer(self.config, text, entry) if entry else ""
            if answer:
                self.tg.send(chat_id, answer)
                self.db.log(chat_id, "bot", answer)
            else:
                self.handoff(chat_id, text)

    def handoff(self, chat_id: int, question: str) -> None:
        ticket_id = self.db.ticket(chat_id, question)
        self.tg.send(chat_id, f"Ticket #{ticket_id} is open; a person can reply here. You can add details while you wait.")
        if chat_id != self.config.admin_id:
            self.tg.send(self.config.admin_id, f"Ticket #{ticket_id} from chat {chat_id}:\n{question[:2000]}\nReply: /reply {ticket_id} your answer\nHistory: /history {ticket_id}")

    def admin(self, text: str) -> None:
        admin = self.config.admin_id
        if text == "/tickets":
            rows = self.db.open_tickets()
            self.tg.send(admin, "\n".join(f"#{r['id']} ({r['chat_id']}): {r['question'][:120]}" for r in rows) or "No open tickets.")
        elif text == "/stats":
            users, total, opened = self.db.stats()
            self.tg.send(admin, f"Users: {users}\nTickets: {total}\nOpen: {opened}")
        elif text.startswith("/history "):
            parts = text.split()
            ticket = self.db.get_ticket(int(parts[1])) if len(parts) == 2 and parts[1].isdigit() else None
            if not ticket:
                self.tg.send(admin, "Usage: /history <existing ticket ID>")
                return
            history = self.db.history(ticket["chat_id"])
            self.tg.send(admin, "\n\n".join(f"{row['role']}: {row['text']}" for row in history) or "No messages stored.")
        elif text.startswith("/reply "):
            parts = text.split(maxsplit=2)
            if len(parts) < 3 or not parts[1].isdigit() or not parts[2].strip():
                self.tg.send(admin, "Usage: /reply <ticket ID> <answer>")
                return
            ticket = self.db.get_ticket(int(parts[1]))
            if not ticket or ticket["status"] != "open":
                self.tg.send(admin, "Open ticket not found.")
                return
            self.tg.send(ticket["chat_id"], "Support: " + parts[2])
            self.db.log(ticket["chat_id"], "operator", parts[2])
            self.db.close(ticket["id"])
            self.tg.send(admin, f"Ticket #{ticket['id']} answered and closed.")
        elif text.startswith("/close "):
            parts = text.split()
            if len(parts) != 2 or not parts[1].isdigit():
                self.tg.send(admin, "Usage: /close <ticket ID>")
                return
            ticket = self.db.get_ticket(int(parts[1]))
            if not ticket or ticket["status"] != "open":
                self.tg.send(admin, "Open ticket not found.")
                return
            self.db.close(ticket["id"])
            self.tg.send(admin, f"Ticket #{ticket['id']} closed.")
        else:
            self.tg.send(admin, "Admin commands: /tickets, /stats, /history <id>, /reply <id> <answer>, /close <id>.")


def run() -> None:
    load_env()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    config = Config.from_env()
    db = Database(config.db_path)
    bot = SupportBot(config, db, Knowledge(config.knowledge_path), Telegram(config.token))
    LOG.info("Starting support bot polling")
    while True:
        try:
            updates = bot.tg.call("getUpdates", {"offset": db.offset(), "timeout": 25, "allowed_updates": ["message"]}, timeout=35)
            for update in updates:
                bot.handle(update)
                db.set_offset(update["update_id"] + 1)
        except (OSError, RuntimeError, KeyError, ValueError):
            LOG.exception("Polling or message handling error; retrying")
            time.sleep(3)


if __name__ == "__main__":
    run()
