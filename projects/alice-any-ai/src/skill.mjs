import { complete, cleanText, ProviderError } from './provider.mjs';

export function reply(text, buttons = ['Помощь', 'Новая тема'], end = false) {
  return { version: '1.0', response: { text: cleanText(text).slice(0, 1024), end_session: end, buttons: end ? [] : buttons.map(title => ({ title, hide: true })) } };
}
const WAIT = 'Еще готовлю ответ. Через несколько секунд скажи: «Ответ готов?». Можно сказать «Отмена».';
const POLL = new Set(['ответ готов', 'готово', 'готов', 'проверить ответ', 'получить ответ']);
const HELP = new Set(['помощь', 'что ты умеешь', 'помоги']);
const RESET = new Set(['новая тема', 'начать заново', 'забудь разговор', 'очистить историю']);
const STOP = new Set(['выход', 'выйти', 'хватит', 'стоп', 'завершить']);
const normalize = text => text.toLowerCase().replace(/\u0451/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

export function validateEnvelope(body) {
  if (!body || body.version !== '1.0' || !body.session || !body.request) return false;
  const s = body.session;
  const validId = x => typeof x === 'string' && x.length > 0 && x.length <= 128;
  return validId(s.session_id) && validId(s.skill_id) && Number.isInteger(s.message_id) && s.message_id >= 0 && s.message_id <= 99999999 &&
    (validId(s.user?.user_id) || validId(s.application?.application_id)) &&
    ['SimpleUtterance', 'ButtonPressed'].includes(body.request.type) &&
    (body.request.command === undefined || typeof body.request.command === 'string') &&
    (body.request.original_utterance === undefined || typeof body.request.original_utterance === 'string');
}

export function splitAnswer(text) {
  let rest = cleanText(text).slice(0, 12000); const chunks = [];
  while (rest) {
    let end = Math.min(850, rest.length);
    if (rest.length > end) {
      const prefix = rest.slice(0, end);
      const sentence = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '));
      const space = prefix.lastIndexOf(' ');
      end = sentence > 400 ? sentence + 1 : space > 0 ? space : end;
    }
    chunks.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim();
  }
  return chunks;
}

function historyWindow(history) {
  let chars = 0; const selected = [];
  for (let i = history.length - 2; i >= 0 && selected.length < 10; i -= 2) {
    const pair = history.slice(i, i + 2);
    const size = pair.reduce((n, x) => n + x.content.length, 0);
    if (chars + size > 10000) break;
    selected.unshift(...pair); chars += size;
  }
  return selected;
}

export class SkillEngine {
  constructor(getConfig, { generate = complete, now = Date.now, maxSessions = 256, maxActive = 4 } = {}) {
    this.getConfig = getConfig; this.generate = generate; this.now = now;
    this.sessions = new Map(); this.maxSessions = maxSessions; this.maxActive = maxActive;
    this.active = 0; this.attempts = []; this.daily = { day: '', count: 0 };
  }
  reserve() {
    const c = this.getConfig(), now = this.now(), day = new Date(now).toISOString().slice(0, 10);
    if (this.daily.day !== day) this.daily = { day, count: 0 };
    this.attempts = this.attempts.filter(t => now - t < 60000);
    if (this.daily.count >= c.dailyLimit) return 'Достигнут дневной лимит этого сервера. Он защищает от лишних расходов.';
    if (this.active >= this.maxActive || this.attempts.length >= 20) return 'Слишком много запросов. Попробуйте через минуту.';
    this.daily.count++; this.attempts.push(now); return '';
  }
  prune() {
    for (const [key, s] of this.sessions) if (this.now() - s.touched > 20 * 60000) {
      s.job?.controller.abort(); this.sessions.delete(key);
    }
  }
  clearSessions() {
    for (const s of this.sessions.values()) s.job?.controller.abort();
    this.sessions.clear();
  }
  handle(body) {
    this.prune();
    const identity = body.session.user?.user_id || body.session.application.application_id;
    const key = JSON.stringify([body.session.skill_id, identity, body.session.session_id]);
    let s = this.sessions.get(key);
    if (!s) {
      if (this.sessions.size >= this.maxSessions) return Promise.resolve(reply('Сервер занят. Повторите позже.'));
      s = { touched: this.now(), history: [], cache: new Map(), lastId: -1, job: null, chunks: [], lastText: '', minute: [] };
      this.sessions.set(key, s);
    }
    s.touched = this.now();
    const id = body.session.message_id;
    if (s.cache.has(id)) return s.cache.get(id);
    if (id < s.lastId) return Promise.resolve(reply('Это устаревший запрос. Повторите последнюю фразу.'));
    s.lastId = id;
    // Обещание кладется в кеш до запуска: одновременные повторы не создают второй платный запрос.
    const result = Promise.resolve().then(() => this.process(s, body)).catch(() => reply('Внутренняя ошибка. Начните новую тему и повторите запрос.'));
    s.cache.set(id, result);
    while (s.cache.size > 24) s.cache.delete(s.cache.keys().next().value);
    return result;
  }
  reset(s) {
    s.job?.controller.abort(); s.job = null; s.history = []; s.chunks = []; s.lastText = ''; s.cache.clear();
  }
  takeChunk(s) {
    if (!s.chunks.length) return reply('Продолжения нет. Задайте новый вопрос.');
    const text = s.chunks.shift() + (s.chunks.length ? ' Скажи «Дальше», чтобы услышать продолжение.' : '');
    s.lastText = text;
    return reply(text, s.chunks.length ? ['Дальше', 'Повтори', 'Новая тема'] : ['Повтори', 'Новая тема']);
  }
  async collect(s, job) {
    let timer;
    await Promise.race([job.promise, new Promise(resolve => { timer = setTimeout(resolve, this.getConfig().waitMs); })]);
    clearTimeout(timer);
    if (s.job !== job) return reply('Запрос отменен. Можно задать новый вопрос.');
    if (!job.done) return reply(WAIT, ['Ответ готов?', 'Отмена']);
    s.job = null;
    if (job.error) return reply(job.error);
    s.history = historyWindow([...s.history, { role: 'user', content: job.prompt }, { role: 'assistant', content: job.text.slice(0, 6000) }]);
    s.chunks = splitAnswer(job.text);
    return this.takeChunk(s);
  }
  async process(s, body) {
    const r = body.request;
    const raw = r.type === 'ButtonPressed' ? r.payload?.command || '' : r.command ?? r.original_utterance ?? '';
    if (typeof raw !== 'string') return reply('Не удалось прочитать фразу. Повторите ее голосом.');
    const text = raw.trim(), command = normalize(text);
    if (STOP.has(command)) { this.reset(s); return reply('Навык завершен.', [], true); }
    if (RESET.has(command)) { this.reset(s); return reply('История этой сессии очищена. О чем поговорим?'); }
    if (command === 'отмена' || command === 'отмени') { s.job?.controller.abort(); s.job = null; return reply('Запрос отменен. Задайте другой вопрос.'); }
    if (HELP.has(command) || !text) return reply('Это отдельный навык для общения с выбранным ИИ. Задайте вопрос. Если я еще готовлю ответ, скажите «Ответ готов?». Команды: «Дальше», «Повтори», «Новая тема», «Отмена», «Выход». Не диктуйте пароли и секреты: текст получает провайдер модели.');
    if (command === 'дальше' || command === 'продолжи') return this.takeChunk(s);
    if (command === 'повтори') return reply(s.lastText || 'Пока нечего повторять. Задайте вопрос.');
    if (POLL.has(command)) return s.job ? this.collect(s, s.job) : reply('Ожидающего ответа нет. Задайте вопрос.');
    if (s.job) return s.job.done ? reply('Предыдущий ответ уже готов. Скажите «Ответ готов?», чтобы его услышать, или «Отмена».', ['Ответ готов?', 'Отмена']) : reply(WAIT, ['Ответ готов?', 'Отмена']);
    if (text.length > 2000) return reply('Вопрос слишком длинный. Сократите его до 2000 символов.');
    s.minute = s.minute.filter(t => this.now() - t < 60000);
    if (s.minute.length >= 6) return reply('Не больше шести новых вопросов в минуту. Подождите немного.');
    const problem = this.reserve(); if (problem) return reply(problem);
    s.minute.push(this.now());
    const c = this.getConfig();
    const job = { prompt: text, controller: new AbortController(), done: false, text: '', error: '' };
    s.job = job; s.chunks = []; this.active++;
    job.promise = Promise.resolve().then(() => this.generate(c, [...s.history, { role: 'user', content: text }], job.controller.signal))
      .then(answer => { job.text = cleanText(answer); })
      .catch(e => { job.error = e instanceof ProviderError ? e.message : 'Ошибка обращения к ИИ. Проверьте подключение в панели настройки.'; })
      .finally(() => { job.done = true; this.active--; });
    return this.collect(s, job);
  }
}
