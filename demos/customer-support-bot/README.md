# AI Telegram Customer Support Bot — portfolio demo

An inspectable customer-support bot for a fictional store. It matches questions to a small editable FAQ, optionally reformulates the verified answer with the OpenAI API, and opens a ticket when it cannot find a confident match. An operator can reply from a private admin chat. The sample store policy is illustrative, not a real merchant policy.

## Try it without credentials

Run `python demo.py` to replay the real handler with a temporary SQLite database and a fake Telegram transport. No API calls or paid services are used. The conversation is fictional.

## Features

- Telegram private-chat bot using long polling, with no external Python dependencies.
- Editable `knowledge.json`; conservative keyword overlap matching.
- Optional LLM response only when a FAQ entry is matched; the bot falls back to the exact FAQ answer if the AI request fails.
- Human handoff with `/human`, numbered tickets, `/tickets`, `/history`, `/reply`, `/close` and `/stats`.
- SQLite messages, tickets, and polling offset; `/forget` removes a user's stored messages and tickets.
- Docker image and automated offline tests. No customer data or credentials are in this repository.

## Run

1. Create a bot with BotFather and send a message to the bot from the operator account.
2. Copy `.env.example` to `.env`, set the bot token and numeric operator Telegram chat ID. Keep `.env` private.
3. Run `python app.py`. The bot reads simple KEY=value settings from `.env`; existing environment variables take precedence. Python 3.12+ is recommended.

Docker Compose example (uses a named volume for persistent data):

```bash
docker compose up --build -d
docker compose logs -f bot
```

Run offline checks with `python -m unittest discover -s tests -v`.

## Demo flow

1. Ask `How long does delivery take?` and see the approved FAQ answer.
2. Ask something absent from the FAQ. The bot creates a ticket and alerts the operator.
3. Additional customer messages are forwarded to the operator while the ticket is open. From the admin account, send `/tickets`, `/history 1`, then `/reply 1 Your answer`. The reply closes the ticket and restores automatic answers.
4. Check `/stats` and try `/forget` from the customer chat.

## Scope and production notes

This is a portfolio demo, not a deployed service or production-ready help desk. It handles text in private chats. The conservative matcher can still match the wrong FAQ entry; business policies must be reviewed and tested with real customer phrasing before use. The optional LLM receives the customer's question and matching FAQ, so add consent and retention controls for real users. The polling offset is persisted after handling, so an interruption between sending and offset persistence can repeat a notification. For production, add update-level idempotency, rate limits, access logging controls, monitoring, backups, a privacy policy, and stronger retrieval evaluation.
