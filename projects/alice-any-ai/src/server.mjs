import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { publicConfig, mergeEditable, saveConfig, isConfigured, PRESETS } from './config.mjs';
import { SkillEngine, reply, validateEnvelope } from './skill.mjs';
import { complete, listModels, ProviderError } from './provider.mjs';

export function secretEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let total = 0, chunks = [], failed = false;
    req.on('data', chunk => {
      if (failed) return;
      total += chunk.length;
      if (total > 32768) { failed = true; chunks = []; reject(Object.assign(new Error('Слишком большой запрос.'), { status: 413 })); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(Object.assign(new Error('Ожидается JSON-объект.'), { status: 400 })); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Соединение закрыто.')));
  });
}

export async function createApplication({ config, dataDir, generate = complete, models = listModels, persist = saveConfig } = {}) {
  let current = config, writeBusy = false, adminActive = 0;
  let lastUserId = '';
  const engine = new SkillEngine(() => current, { generate });
  const assets = new Map();
  for (const [url, file, type] of [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css']]) {
    assets.set(url, { body: await readFile(fileURLToPath(new URL(`../web/${file}`, import.meta.url))), type: type + '; charset=utf-8' });
  }
  const attempts = new Map();
  function apiRateLimit(ip) {
    const now = Date.now();
    if (attempts.size >= 512) for (const [key, value] of attempts) if (now - value.start > 60000) attempts.delete(key);
    let bucket = attempts.get(ip);
    if (!bucket || now - bucket.start > 60000) {
      if (!bucket && attempts.size >= 512) return false;
      bucket = { start: now, count: 0 }; attempts.set(ip, bucket);
    }
    return ++bucket.count <= 120;
  }
  function originAllowed(req) {
    if (!req.headers.origin) return true; // CLI-клиенты с Bearer-токеном.
    try {
      const origin = new URL(req.headers.origin);
      const port = server.address()?.port;
      return (current.publicUrl && origin.origin === current.publicUrl) ||
        (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && Number(origin.port || 80) === port);
    } catch { return false; }
  }
  const server = createServer(async (req, res) => {
    try {
      let pathname;
      try { pathname = new URL(req.url, 'http://local.invalid').pathname; } catch { return send(res, 400, { error: 'Неверный URL.' }); }
      if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'GET' && assets.has(pathname)) {
        const asset = assets.get(pathname); return send(res, 200, asset.body, asset.type);
      }
      if (pathname.startsWith('/api/')) {
        if (!apiRateLimit(req.socket.remoteAddress || 'unknown')) return send(res, 429, { error: 'Слишком много обращений к панели. Повторите через минуту.' });
        if (!originAllowed(req)) return send(res, 403, { error: 'Запрос с другого сайта запрещен.' });
        const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
        if (!secretEquals(token, current.adminToken)) return send(res, 401, { error: 'Нужен ключ администратора панели, а не ключ ИИ.' });
        if (req.method === 'GET' && pathname === '/api/config') return send(res, 200, { config: publicConfig(current), presets: PRESETS, lastUserId, active: engine.active, daily: engine.daily });
        if (req.method !== 'POST') return send(res, 405, { error: 'Метод не поддерживается.' });
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Нужен Content-Type: application/json.' });
        const patch = await readJson(req);
        let next;
        try { next = mergeEditable(current, patch); } catch (e) { return send(res, 400, { error: e.message }); }
        if (pathname === '/api/config') {
          if (writeBusy || adminActive) return send(res, 409, { error: 'Дождитесь завершения проверки или сохранения.' });
          writeBusy = true;
          try { await persist(dataDir, next); current = next; engine.clearSessions(); }
          finally { writeBusy = false; }
          return send(res, 200, { config: publicConfig(current) });
        }
        if (pathname === '/api/test' || pathname === '/api/models') {
          if (adminActive || writeBusy) return send(res, 409, { error: 'Дождитесь завершения текущей операции.' });
          if (!next.baseUrl) return send(res, 400, { error: 'Укажите базовый адрес API.' });
          if (pathname === '/api/test' && !next.model) return send(res, 400, { error: 'Укажите идентификатор модели.' });
          if (pathname === '/api/test') {
            const problem = engine.reserve();
            if (problem) return send(res, 429, { error: problem });
          }
          adminActive++;
          if (pathname === '/api/test') engine.active++;
          try {
            if (pathname === '/api/models') return send(res, 200, { models: await models(next) });
            const started = Date.now();
            const text = await generate(next, [{ role: 'user', content: 'Ответь одной короткой фразой: подключение работает.' }], new AbortController().signal);
            return send(res, 200, { text: text.slice(0, 1024), elapsedMs: Date.now() - started });
          } catch (e) { return send(res, 502, { error: e instanceof ProviderError ? e.message : 'Ошибка проверки подключения.' }); }
          finally { adminActive--; if (pathname === '/api/test') engine.active--; }
        }
        return send(res, 404, { error: 'Не найдено.' });
      }
      if (pathname.startsWith('/alice/')) {
        if (req.method !== 'POST') return send(res, 405, { error: 'Используйте POST.' });
        let supplied;
        try { supplied = decodeURIComponent(pathname.slice('/alice/'.length)); } catch { return send(res, 404, { error: 'Не найдено.' }); }
        if (!secretEquals(supplied, current.webhookSecret)) return send(res, 404, { error: 'Не найдено.' });
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Нужен JSON.' });
        const body = await readJson(req);
        if (!validateEnvelope(body)) return send(res, 400, { error: 'Некорректный запрос Диалогов.' });
        if (!isConfigured(current)) return send(res, 200, reply('Сначала завершите настройку ИИ и идентификатора навыка в панели.'));
        if (body.session.skill_id !== current.skillId) return send(res, 403, { error: 'Неверный идентификатор навыка.' });
        const userId = body.session.user?.user_id || '';
        if (current.allowedUserIds.length && !current.allowedUserIds.includes(userId)) return send(res, 200, reply('Этот пользователь не допущен к навыку.', [], true));
        lastUserId = userId; // Только в RAM и только для авторизованной панели.
        return send(res, 200, await engine.handle(body));
      }
      return send(res, 404, { error: 'Не найдено.' });
    } catch (e) {
      if (!res.headersSent && !res.destroyed) send(res, e.status || 500, { error: e.status ? e.message : 'Внутренняя ошибка сервера. Проверьте доступ к папке данных.' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 8000;
  server.keepAliveTimeout = 5000;
  const gc = setInterval(() => engine.prune(), 60000); gc.unref();
  server.on('close', () => { clearInterval(gc); engine.clearSessions(); });
  return {
    server, engine,
    get config() { return current; },
    setPublicUrl(url) { current = mergeEditable(current, { publicUrl: url }); },
    close() { engine.clearSessions(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }
  };
}
