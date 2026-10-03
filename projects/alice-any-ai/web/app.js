const $ = id => document.getElementById(id);
let token = '', state;
let presets = {};

async function request(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Ошибка HTTP ${res.status}`);
  return data;
}
function docs() {
  const url = presets[$('provider').value].docs;
  $('providerDocs').hidden = !url; $('providerDocs').href = url || '#';
}
function populate(c) {
  state = c;
  for (const k of ['provider', 'protocol', 'baseUrl', 'model', 'tokenField', 'maxTokens', 'dailyLimit', 'systemPrompt', 'skillId', 'publicUrl', 'webhookUrl']) $(k).value = c[k] ?? '';
  $('extra').value = JSON.stringify(c.extra || {});
  $('allowedUserIds').value = c.allowedUserIds.join('\n');
  $('apiKey').value = ''; $('clearApiKey').checked = false;
  $('keyHint').textContent = c.hasApiKey ? 'Ключ уже сохранен. Пустое поле оставит его без изменений, если сервис и адрес прежние.' : 'Ключ нужен у большинства облачных провайдеров. Для локальной Ollama обычно можно оставить поле пустым.';
  docs();
}
function patch() {
  const data = {};
  for (const k of ['provider', 'protocol', 'baseUrl', 'model', 'tokenField', 'systemPrompt', 'skillId', 'publicUrl', 'apiKey']) data[k] = $(k).value.trim();
  for (const k of ['maxTokens', 'dailyLimit']) data[k] = Number($(k).value);
  data.clearApiKey = $('clearApiKey').checked;
  data.allowedUserIds = $('allowedUserIds').value.split('\n').map(x => x.trim()).filter(Boolean);
  try { data.extra = JSON.parse($('extra').value || '{}'); } catch { throw new Error('В дополнительных параметрах нужен корректный JSON. Например: {}'); }
  return data;
}
async function action(id, fn) {
  $(id).disabled = true; $('error').textContent = '';
  try { await fn(); } catch (e) { $('error').textContent = e.message; }
  finally { $(id).disabled = false; }
}
async function login() {
  const data = await request('/api/config'); presets = data.presets;
  $('provider').replaceChildren();
  for (const [id, item] of Object.entries(presets)) $('provider').add(new Option(item.name, id));
  populate(data.config);
  $('login').hidden = true; $('workspace').hidden = false; $('admin').value = '';
  $('userHint').textContent = data.lastUserId ? `ID последнего разрешенного пользователя: ${data.lastUserId}` : 'ID появится после обращения к настроенному навыку и нажатия «Обновить адрес».';
}
$('loginButton').onclick = () => action('loginButton', async () => { token = $('admin').value.trim(); await login(); });
$('admin').onkeydown = e => { if (e.key === 'Enter') $('loginButton').click(); };
$('provider').onchange = () => {
  const p = presets[$('provider').value];
  $('protocol').value = p.protocol; $('baseUrl').value = p.baseUrl; $('tokenField').value = p.tokenField;
  $('model').value = ''; $('apiKey').value = ''; $('models').replaceChildren(); $('testResult').textContent = ''; docs();
  $('keyHint').textContent = 'Для нового сервиса укажи его ключ. Старый ключ не будет отправлен по другому адресу.';
};
$('modelsButton').onclick = () => action('modelsButton', async () => {
  const data = await request('/api/models', patch()); $('models').replaceChildren();
  for (const name of data.models) $('models').append(new Option(name, name));
  $('testResult').textContent = data.models.length ? `Найдено моделей: ${data.models.length}. Начни вводить имя в поле «Модель» и выбери чат-модель.` : 'Список пуст. Введи идентификатор модели вручную.';
});
$('testButton').onclick = () => action('testButton', async () => {
  $('testResult').textContent = 'Проверяем подключение…';
  try {
    const data = await request('/api/test', patch());
    $('testResult').textContent = `${data.text} Время API: ${(data.elapsedMs / 1000).toFixed(1)} с. ${data.elapsedMs > 1500 ? 'Для такого ответа может понадобиться команда «Ответ готов?».' : 'Быстрый ответ. Скорость в следующий раз может отличаться.'}`;
  } catch (e) { $('testResult').textContent = ''; throw e; }
});
$('saveButton').onclick = () => action('saveButton', async () => {
  const data = await request('/api/config', patch()); populate(data.config);
  $('saveResult').textContent = data.config.configured ? 'Сохранено. Скопируй Webhook URL ниже.' : 'Сохранено. Для запуска заполни модель, базовый адрес API и ID навыка.';
});
$('refreshButton').onclick = () => action('refreshButton', async () => {
  const data = await request('/api/config');
  $('publicUrl').value = data.config.publicUrl; $('webhookUrl').value = data.config.webhookUrl;
  $('userHint').textContent = data.lastUserId ? `ID последнего разрешенного пользователя: ${data.lastUserId}` : 'Пользователь еще не обращался к настроенному навыку.';
});
$('copyButton').onclick = () => action('copyButton', async () => {
  if (!$('webhookUrl').value) throw new Error('Сначала сохрани публичный HTTPS-адрес сервера.');
  try { await navigator.clipboard.writeText($('webhookUrl').value); $('saveResult').textContent = 'Webhook URL скопирован. Не публикуй его.'; }
  catch { $('webhookUrl').select(); throw new Error('Браузер запретил копирование. Адрес выделен: скопируй его вручную.'); }
});
if (location.hash.length > 1) {
  try { token = decodeURIComponent(location.hash.slice(1)); } catch { token = ''; }
  history.replaceState(null, '', location.pathname);
  action('loginButton', login);
}
