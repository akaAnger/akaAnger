"""Run the real message handler with a fake transport and temporary database."""
import json
import tempfile
from pathlib import Path
from app import Config, Database, Knowledge, SupportBot


class ConsoleTransport:
    def __init__(self):
        self.events = []

    def send(self, chat_id, text):
        target = "Operator" if chat_id == 99 else "Customer"
        self.events.append({"sender": "Bot", "recipient": target, "text": text})
        print(f"\nBot -> {target}\n{text}")


def run_demo():
    transport = ConsoleTransport()
    with tempfile.TemporaryDirectory() as folder:
        db = Database(str(Path(folder) / "demo.sqlite3"))
        bot = SupportBot(Config("offline-no-token", 99), db,
                         Knowledge(str(Path(__file__).with_name("knowledge.json"))), transport)
        steps = [(12, "How long does delivery take?"),
                 (12, "I need to change a custom order."),
                 (12, "My order number is DEMO-42."),
                 (99, "/history 1"),
                 (99, "/reply 1 I can help. Which detail would you like to change?"),
                 (99, "/stats")]
        print("OFFLINE DEMO — no API calls, fictional conversation")
        for index, (chat_id, text) in enumerate(steps, 1):
            sender = "Operator" if chat_id == 99 else "Customer"
            transport.events.append({"sender": sender, "recipient": "Bot", "text": text})
            print(f"\n{sender} -> Bot\n{text}")
            bot.handle({"update_id": index, "message": {"chat": {"id": chat_id, "type": "private"}, "text": text}})
        db.conn.close()
    return transport.events


if __name__ == "__main__":
    run_demo()
