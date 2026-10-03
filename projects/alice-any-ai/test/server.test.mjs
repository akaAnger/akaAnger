import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, webhookPath } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';

function event(command = '', id = 0) {
  return { version: '1.0', session: { session_id: 'fixture-session', skill_id: 'fixture-skill', message_id: id, new: id === 0, user: { user_id: 'fixture-user' }, application: { application_id: 'fixture-device' } }, request: { type: 'SimpleUtterance', command } };
}
async function fixture(t, patch = {}) {
  let calls = 0;
  const config = { ...defaults(), skillId: 'fixture-skill', model: 'fixture-model', waitMs: 1, ...patch };
  const app = await createApplication({ config, dataDir: '/unused', persist: async () => {}, generate: async () => { calls++; return 'Тестовый ответ.'; }, models: async () => ['fixture-model'] });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' };
  return { app, config, base, auth, calls: () => calls, post: (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
}
test('Панель доступна, но конфиг без секрета закрыт', async t => {
  const f = await fixture(t);
  const page = await fetch(f.base); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(f.base + '/api/config')).status, 401);
  const data = await (await fetch(f.base + '/api/config', { headers: f.auth })).json();
  assert.equal(data.config.apiKey, undefined); assert.equal(data.config.adminToken, undefined); assert.ok(data.presets.ollama);
});
test('CSRF с другого сайта отклонен даже с токеном', async t => {
  const f = await fixture(t);
  const r = await f.post('/api/config', {}, { ...f.auth, origin: 'https://attacker.example' }); assert.equal(r.status, 403);
});
test('Вебхук требует секрет и правильный ID навыка', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/alice/wrong', event('Вопрос'))).status, 404);
  const bad = event('Вопрос'); bad.session.skill_id = 'wrong';
  assert.equal((await f.post(webhookPath(f.config), bad)).status, 403); assert.equal(f.calls(), 0);
});
test('Вебхук возвращает валидный быстрый ответ', async t => {
  const f = await fixture(t); const r = await f.post(webhookPath(f.config), event('Вопрос'));
  assert.equal(r.status, 200); const data = await r.json(); assert.equal(data.version, '1.0'); assert.equal(data.response.text, 'Тестовый ответ.'); assert.equal(f.calls(), 1);
});
test('Некорректный JSON и чрезмерный запрос отвергаются', async t => {
  const f = await fixture(t);
  const r = await fetch(f.base + webhookPath(f.config), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }); assert.equal(r.status, 400);
  const big = await f.post(webhookPath(f.config), { a: 'x'.repeat(40000) }); assert.equal(big.status, 413);
  assert.equal(f.calls(), 0);
});
test('Список пользователей блокирует чужого без обращения к API', async t => {
  const f = await fixture(t, { allowedUserIds: ['another-user'] });
  const data = await (await f.post(webhookPath(f.config), event('Вопрос'))).json(); assert.equal(data.response.end_session, true); assert.equal(f.calls(), 0);
});
test('Проверка подключения учитывается в дневном лимите', async t => {
  const f = await fixture(t, { dailyLimit: 1 });
  assert.equal((await f.post('/api/test', {}, f.auth)).status, 200);
  assert.equal((await f.post('/api/test', {}, f.auth)).status, 429); assert.equal(f.calls(), 1);
});
test('API списка моделей работает без генерации текста', async t => {
  const f = await fixture(t); const res = await f.post('/api/models', {}, f.auth);
  assert.deepEqual((await res.json()).models, ['fixture-model']); assert.equal(f.calls(), 0);
});
test('Изменения сохраняются и не позволяют менять секрет панели через API', async t => {
  const f = await fixture(t); const old = f.app.config.adminToken;
  const r = await f.post('/api/config', { model: 'new-model', adminToken: 'a'.repeat(64) }, f.auth);
  assert.equal(r.status, 200); assert.equal(f.app.config.model, 'new-model'); assert.equal(f.app.config.adminToken, old);
});
test('Данные и исходники сервера не раздаются как статика', async t => {
  const f = await fixture(t);
  for (const path of ['/.data/config.json', '/src/config.mjs', '/package.json']) assert.equal((await fetch(f.base + path)).status, 404);
});
test('Сервер без ID навыка не отправляет платные запросы', async t => {
  const f = await fixture(t, { skillId: '' });
  const r = await f.post(webhookPath(f.config), event('Вопрос'));
  assert.match((await r.json()).response.text, /настройку/); assert.equal(f.calls(), 0);
});
