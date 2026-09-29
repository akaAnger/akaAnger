FROM python:3.12-slim
WORKDIR /app
COPY app.py knowledge.json ./
RUN useradd -r -u 10001 bot && mkdir /app/data && chown bot:bot /app/data
USER bot
ENV PYTHONUNBUFFERED=1 DB_PATH=/app/data/support.sqlite3 KNOWLEDGE_PATH=/app/knowledge.json
VOLUME /app/data
CMD ["python", "app.py"]
