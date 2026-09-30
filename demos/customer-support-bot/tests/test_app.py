import tempfile
import unittest
import os
from unittest.mock import patch
from pathlib import Path

from app import Config, Database, Knowledge, SupportBot, load_env


class FakeTelegram:
    def __init__(self):
        self.sent = []

    def send(self, chat_id, text):
        self.sent.append((chat_id, text))


def update(chat_id, text):
    return {"update_id": 1, "message": {"chat": {"id": chat_id, "type": "private"}, "text": text}}


class DemoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(__file__).resolve().parents[1]
        self.db = Database(str(Path(self.tmp.name) / "bot.sqlite3"))
        self.tg = FakeTelegram()
        self.bot = SupportBot(Config("test-token", 99), self.db, Knowledge(str(root / "knowledge.json")), self.tg)

    def tearDown(self):
        self.db.conn.close()
        self.tmp.cleanup()

    def test_known_answer_and_unknown_handoff(self):
        self.bot.handle(update(12, "How long does delivery take?"))
        self.assertIn("3–5 business days", self.tg.sent[-1][1])
        self.bot.handle(update(12, "Can I engrave a custom name?"))
        self.assertEqual(len(self.db.open_tickets()), 1)
        self.assertEqual(self.tg.sent[-1][0], 99)

    def test_admin_reply_routes_to_customer_and_closes(self):
        self.bot.handle(update(12, "/human"))
        self.bot.handle(update(99, "/reply 1 We can help with that."))
        self.assertIn((12, "Support: We can help with that."), self.tg.sent)
        self.assertEqual(len(self.db.open_tickets()), 0)

    def test_forget_removes_history_and_tickets(self):
        self.bot.handle(update(12, "question without answer"))
        self.bot.handle(update(12, "/forget"))
        self.assertEqual(self.db.stats(), (0, 0, 0))

    def test_admin_commands_restricted(self):
        self.bot.handle(update(12, "/stats"))
        self.assertIn("Unknown command", self.tg.sent[-1][1])
        self.bot.handle(update(99, "/stats"))
        self.assertIn("Tickets:", self.tg.sent[-1][1])

    def test_open_handoff_forwards_followups_instead_of_autoanswering(self):
        self.bot.handle(update(12, "/human"))
        self.tg.sent.clear()
        self.bot.handle(update(12, "How long does delivery take?"))
        self.assertEqual(self.tg.sent[0][0], 99)
        self.assertIn("Follow-up for ticket #1", self.tg.sent[0][1])
        self.assertIn("support team", self.tg.sent[-1][1])
        self.assertFalse(any("3–5" in text for _, text in self.tg.sent))
        self.bot.handle(update(99, "/history 1"))
        self.assertIn("How long does delivery take?", self.tg.sent[-1][1])
        self.bot.handle(update(12, "/history 1"))
        self.assertIn("Unknown command", self.tg.sent[-1][1])

    def test_env_file_does_not_override_deployment_secrets(self):
        path = Path(self.tmp.name) / ".env"
        path.write_text('TELEGRAM_BOT_TOKEN="local-example"\nADMIN_CHAT_ID=99\n')
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "deployment-example"}, clear=True):
            load_env(str(path))
            cfg = Config.from_env()
            self.assertEqual(cfg.token, "deployment-example")
            self.assertEqual(cfg.admin_id, 99)


if __name__ == "__main__":
    unittest.main()
