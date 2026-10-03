import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export const PRESETS = Object.freeze({
  deepseek: { name: 'DeepSeek', protocol: 'chat', baseUrl: 'https://api.deepseek.com/v1', tokenField: 'max_tokens', docs: 'https://api-docs.deepseek.com/' },
  openrouter: { name: 'OpenRouter', protocol: 'chat', baseUrl: 'https://openrouter.ai/api/v1', tokenField: 'max_tokens', docs: 'https://openrouter.ai/docs/quickstart' },
  openai: { name: 'OpenAI', protocol: 'chat', baseUrl: 'https://api.openai.com/v1', tokenField: 'max_completion_tokens', docs: 'https://platform.openai.com/api-keys' },
  gemini: { name: 'Google Gemini', protocol: 'chat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', tokenField: 'max_tokens', docs: 'https://ai.google.dev/gemini-api/docs/openai' },
  anthropic: { name: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', tokenField: 'max_tokens', docs: 'https://platform.claude.com/docs/en/api/overview' },
  ollama: { name: 'Ollama на этом компьютере', protocol: 'chat', baseUrl: 'http://127.0.0.1:11434/v1', tokenField: 'max_tokens', docs: 'https://docs.ollama.com/api/openai-compatibility' },
  custom: { name: 'Другой совместимый API', protocol: 'chat', baseUrl: '', tokenField: 'max_tokens', docs: '' }
});

export const SYSTEM_PROMPT = 'Ты голосовой помощник в отдельном навыке Алисы. Отвечай по-русски, понятно и кратко, обычно в 2-4 предложениях. Не используй Markdown, таблицы, ссылки и теги озвучивания. Не выдавай себя за Яндекс или человека. Не утверждай, что управляешь устройствами, ищешь в интернете или выполняешь действия: этих инструментов у тебя нет. При недостатке информации прямо сообщай об этом.';

export function defaults() {
  return {
    provider: 'deepseek', protocol: 'chat', baseUrl: PRESETS.deepseek.baseUrl,
    model: '', apiKey: '', tokenField: 'max_tokens', maxTokens: 768,
    systemPrompt: SYSTEM_PROMPT, extra: {}, skillId: '', allowedUserIds: [],
    publicUrl: '', waitMs: 1500, timeoutMs: 60000, dailyLimit: 200,
    adminToken: randomBytes(32).toString('hex'), webhookSecret: randomBytes(32).toString('hex')
  };
}

function str(value, name, max) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Некорректное поле ${name}.`);
  return value.trim();
}
function number(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}: нужно целое число от ${min} до ${max}.`);
  return value;
}

export function validateBaseUrl(value) {
  const raw = str(value, 'baseUrl', 2048);
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('Адрес API должен начинаться с https:// или локального http://.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Не помещайте ключ, параметры или пароль в адрес API.');
  const local = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('HTTP разрешен только для локального API. Для других адресов нужен HTTPS.');
  if (/\/(chat\/completions|messages|models)\/?$/.test(url.pathname)) throw new Error('Укажите базовый адрес API, без /chat/completions, /messages или /models.');
  return url.href.replace(/\/+$/, '');
}

export function validateConfig(input) {
  const c = { ...input };
  if (!Object.hasOwn(PRESETS, c.provider)) throw new Error('Выберите известного провайдера или «Другой совместимый API».');
  if (!['chat', 'anthropic'].includes(c.protocol)) throw new Error('Поддерживаются Chat Completions и Anthropic Messages.');
  c.baseUrl = validateBaseUrl(c.baseUrl);
  for (const [name, max] of [['model', 256], ['apiKey', 4096], ['skillId', 128], ['systemPrompt', 4000]]) c[name] = str(c[name], name, max);
  if (/[\r\n]/.test(c.apiKey)) throw new Error('Ключ API не должен содержать переводы строк.');
  if (!['max_tokens', 'max_completion_tokens'].includes(c.tokenField)) throw new Error('Неверное имя параметра ограничения токенов.');
  number(c.maxTokens, 'maxTokens', 64, 8192);
  number(c.waitMs, 'waitMs', 0, 1800);
  number(c.timeoutMs, 'timeoutMs', 1000, 120000);
  number(c.dailyLimit, 'dailyLimit', 1, 10000);
  for (const name of ['adminToken', 'webhookSecret']) {
    c[name] = str(c[name], name, 256);
    if (c[name].length < 32 || /\s/.test(c[name])) throw new Error(`${name}: нужен секрет длиной не менее 32 символов без пробелов.`);
  }
  if (c.adminToken === c.webhookSecret) throw new Error('Ключ панели и секрет вебхука должны различаться.');
  c.publicUrl = str(c.publicUrl, 'publicUrl', 2048);
  if (c.publicUrl) {
    let u;
    try { u = new URL(c.publicUrl); } catch { throw new Error('Нужен публичный адрес https://...'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Публичный адрес: только HTTPS и домен, без пути и параметров.');
    c.publicUrl = u.origin;
  }
  if (!Array.isArray(c.allowedUserIds) || c.allowedUserIds.length > 30 || c.allowedUserIds.some(x => typeof x !== 'string' || !x || x.length > 128)) throw new Error('Некорректный список разрешенных идентификаторов пользователей.');
  if (!c.extra || typeof c.extra !== 'object' || Array.isArray(c.extra)) throw new Error('Дополнительные параметры должны быть JSON-объектом.');
  for (const [k, v] of Object.entries(c.extra)) {
    if (k === 'reasoning_effort' && ['none', 'minimal', 'low', 'medium', 'high'].includes(v)) continue;
    if (k === 'temperature' && typeof v === 'number' && v >= 0 && v <= 2) continue;
    if (k === 'top_p' && typeof v === 'number' && v > 0 && v <= 1) continue;
    throw new Error(`Параметр ${k} не поддерживается. Разрешены temperature, top_p, reasoning_effort.`);
  }
  if (c.protocol === 'anthropic' && Object.hasOwn(c.extra, 'reasoning_effort')) throw new Error('reasoning_effort доступен только для совместимого Chat Completions API.');
  return c;
}

export function isConfigured(c) { return Boolean(c.baseUrl && c.model && c.skillId); }
export function webhookPath(c) { return `/alice/${encodeURIComponent(c.webhookSecret)}`; }
export function publicConfig(c) {
  const { apiKey, adminToken, webhookSecret, ...safe } = c;
  return { ...safe, hasApiKey: Boolean(apiKey), webhookUrl: c.publicUrl ? c.publicUrl + webhookPath(c) : '', webhookPath: webhookPath(c), configured: isConfigured(c) };
}

// Пустое поле сохраняет прежний ключ только для того же адреса и провайдера.
export function mergeEditable(current, patch) {
  const fields = ['provider', 'protocol', 'baseUrl', 'model', 'tokenField', 'maxTokens', 'systemPrompt', 'extra', 'skillId', 'allowedUserIds', 'publicUrl', 'waitMs', 'timeoutMs', 'dailyLimit'];
  const next = { ...current };
  for (const k of fields) if (Object.hasOwn(patch, k)) next[k] = patch[k];
  const changedDestination = next.baseUrl.replace(/\/+$/, '') !== current.baseUrl.replace(/\/+$/, '') || next.provider !== current.provider || next.protocol !== current.protocol;
  if (changedDestination || patch.clearApiKey === true) next.apiKey = '';
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  return validateConfig(next);
}

export async function saveConfig(dir, config) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'config.json');
  const temp = join(dir, `config.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
  await chmod(file, 0o600);
}

export async function loadConfig(dir, env = process.env) {
  let stored = {};
  try { stored = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Не удалось прочитать .data/config.json. Исправьте файл или восстановите резервную копию.'); }
  const c = { ...defaults(), ...stored };
  if (env.ADMIN_TOKEN) c.adminToken = env.ADMIN_TOKEN;
  if (env.WEBHOOK_SECRET) c.webhookSecret = env.WEBHOOK_SECRET;
  if (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL) c.publicUrl = env.PUBLIC_URL || env.RENDER_EXTERNAL_URL;
  return validateConfig(c);
}
