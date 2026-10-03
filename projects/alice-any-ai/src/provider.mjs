export class ProviderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function cleanText(text) {
  return String(text).slice(0, 20000)
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '[ссылка]')
    .replace(/[`*_#]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\u0451/g, 'е').replace(/\u0401/g, 'Е')
    .replace(/\s+/g, ' ').trim();
}

export function buildRequest(c, messages) {
  const headers = { 'content-type': 'application/json' };
  if (c.protocol === 'anthropic') {
    if (c.apiKey) headers['x-api-key'] = c.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return { url: `${c.baseUrl}/messages`, headers, body: { ...c.extra, model: c.model, max_tokens: c.maxTokens, system: c.systemPrompt, messages } };
  }
  if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`;
  return { url: `${c.baseUrl}/chat/completions`, headers, body: { ...c.extra, model: c.model, messages: [{ role: 'system', content: c.systemPrompt }, ...messages], [c.tokenField]: c.maxTokens, stream: false } };
}

async function readLimited(response) {
  if (!response.body) throw new ProviderError('empty', 'Провайдер прислал пустой ответ.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 2 * 1024 * 1024) throw new ProviderError('large', 'Провайдер прислал слишком большой ответ.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProviderError('format', 'Ответ API не похож на JSON. Проверьте базовый адрес.'); }
}

function statusError(status) {
  const messages = {
    400: 'API отклонил параметры. Проверьте модель, поле лимита токенов и дополнительные параметры.',
    401: 'Провайдер не принял API-ключ. Проверьте его в панели настройки.',
    402: 'Провайдер сообщил о проблеме с оплатой или балансом.',
    403: 'Провайдер запретил запрос. Проверьте доступ к модели и регион сервера.',
    404: 'Не найдена модель или адрес API. Проверьте настройки.',
    429: 'У провайдера исчерпан лимит запросов или квота. Повторите позже.'
  };
  return new ProviderError(`http_${status}`, messages[status] || 'Сервис ИИ временно недоступен. Повторите позже.');
}

export async function requestJson(url, options, fetchFn = fetch) {
  try {
    const response = await fetchFn(url, { ...options, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
    return await readLimited(response);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (options.signal?.aborted || ['AbortError', 'TimeoutError'].includes(e.name)) throw new ProviderError('timeout', 'Не удалось дождаться ответа ИИ. Попробуйте более быструю модель.');
    throw new ProviderError('network', 'Не удалось связаться с API. Проверьте адрес, интернет и доступность провайдера с сервера.');
  }
}

export async function complete(c, messages, signal, fetchFn = fetch) {
  const req = buildRequest(c, messages);
  const data = await requestJson(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(c.timeoutMs)]) }, fetchFn);
  let text;
  if (c.protocol === 'anthropic') text = data.content?.filter(x => x.type === 'text').map(x => x.text).join(' ');
  else {
    const message = data.choices?.[0]?.message;
    const content = message?.content;
    text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text).join(' ') : message?.refusal;
  }
  const cleaned = cleanText(text ?? '');
  if (!cleaned) throw new ProviderError('empty', 'Модель не вернула текст. Проверьте поддержку чата или увеличьте лимит токенов для рассуждающей модели.');
  return cleaned;
}

export async function listModels(c, fetchFn = fetch) {
  const { headers } = buildRequest(c, []);
  const data = await requestJson(`${c.baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) }, fetchFn);
  const models = (Array.isArray(data.data) ? data.data : []).map(x => x.id).filter(x => typeof x === 'string' && x.length <= 256);
  return [...new Set(models)].sort().slice(0, 2000);
}
