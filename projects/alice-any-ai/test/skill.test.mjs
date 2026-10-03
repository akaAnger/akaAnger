import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../src/config.mjs';
import { SkillEngine, validateEnvelope, splitAnswer } from '../src/skill.mjs';

export function envelope(command = '', id = 0, session = 'session-1', user = 'user-1') {
  return { version: '1.0', session: { session_id: session, skill_id: 'fixture-skill', message_id: id, new: id === 0, user: { user_id: user }, application: { application_id: 'device-1' } }, request: { type: 'SimpleUtterance', command } };
}
const setup = options => new SkillEngine(() => ({ ...defaults(), skillId: 'fixture-skill', model: 'fixture-model', waitMs: 5 }), options);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Проверка структуры входного запроса', () => {
  assert.ok(validateEnvelope(envelope()));
  assert.ok(!validateEnvelope({})); assert.ok(!validateEnvelope({ ...envelope(), version: '2.0' }));
  const e = envelope(); e.session.message_id = -1; assert.ok(!validateEnvelope(e));
});
test('Приветствие и помощь не вызывают API', async () => {
  let calls = 0; const engine = setup({ generate: async () => { calls++; return 'Ответ'; } });
  assert.match((await engine.handle(envelope())).response.text, /отдельный навык/);
  await engine.handle(envelope('помощь', 1)); assert.equal(calls, 0);
});
test('Первый вопрос в новой сессии не теряется', async () => {
  let prompt; const engine = setup({ generate: async (c, messages) => { prompt = messages.at(-1).content; return 'Четыре.'; } });
  assert.equal((await engine.handle(envelope('Дважды два'))).response.text, 'Четыре.'); assert.equal(prompt, 'Дважды два');
});
test('Одновременный повтор того же message_id оплачивается один раз', async () => {
  let calls = 0; const engine = setup({ generate: async () => { calls++; return 'Один ответ.'; } });
  const event = envelope('Вопрос'); const [a, b] = await Promise.all([engine.handle(event), engine.handle(event)]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
});
test('Медленная модель продолжает работу; опрос не создает повторный запрос', async () => {
  let resolve, calls = 0;
  const engine = setup({ generate: () => { calls++; return new Promise(r => { resolve = r; }); } });
  assert.match((await engine.handle(envelope('Сложный вопрос'))).response.text, /Ответ готов/);
  assert.match((await engine.handle(envelope('Еще один вопрос', 1))).response.text, /готовлю/);
  resolve('Подготовленный ответ.'); await tick();
  assert.equal((await engine.handle(envelope('Ответ готов?', 2))).response.text, 'Подготовленный ответ.');
  assert.equal(calls, 1);
});
test('Отмена прерывает ожидание и не подмешивает результат в следующую тему', async () => {
  let signal, resolve; const engine = setup({ generate: (c, m, s) => { signal = s; return new Promise(r => { resolve = r; }); } });
  await engine.handle(envelope('Вопрос')); await engine.handle(envelope('Отмена', 1)); assert.ok(signal.aborted);
  resolve('Поздний ответ'); await tick();
  assert.match((await engine.handle(envelope('Ответ готов?', 2))).response.text, /Ожидающего ответа нет/);
});
test('Контекст сессии сохраняется и сбрасывается новой темой', async () => {
  const histories = []; const engine = setup({ generate: async (c, m) => { histories.push(m); return 'Ответ.'; } });
  await engine.handle(envelope('Первый')); await engine.handle(envelope('Второй', 1));
  assert.equal(histories[1].length, 3);
  await engine.handle(envelope('Новая тема', 2)); await engine.handle(envelope('Третий', 3));
  assert.equal(histories[2].length, 1);
});
test('Истории разных пользователей не смешиваются', async () => {
  const messages = []; const engine = setup({ generate: async (c, m) => { messages.push(m); return 'Ответ.'; } });
  await engine.handle(envelope('секрет первого', 0, 'same', 'one'));
  await engine.handle(envelope('вопрос второго', 0, 'same', 'two'));
  assert.equal(messages[1].length, 1); assert.equal(messages[1][0].content, 'вопрос второго');
});
test('Длинный ответ делится; каждое сообщение не длиннее 1024 символов', async () => {
  const long = 'Это предложение для проверки длины. '.repeat(150);
  assert.ok(splitAnswer(long).length > 1);
  const engine = setup({ generate: async () => long });
  const first = await engine.handle(envelope('Расскажи'));
  assert.ok(first.response.text.length <= 1024); assert.match(first.response.text, /Дальше/);
  const next = await engine.handle(envelope('Дальше', 1)); assert.ok(next.response.text.length <= 1024);
  const repeat = await engine.handle(envelope('Повтори', 2)); assert.equal(repeat.response.text, next.response.text);
});
test('Дневной лимит ограничивает новые генерации', async () => {
  let calls = 0; const c = { ...defaults(), skillId: 'fixture-skill', waitMs: 1, dailyLimit: 1 };
  const engine = new SkillEngine(() => c, { generate: async () => { calls++; return 'ОК'; } });
  await engine.handle(envelope('Первый')); assert.match((await engine.handle(envelope('Второй', 1))).response.text, /дневной лимит/); assert.equal(calls, 1);
});
test('Число сессий ограничено; устаревшие записи очищаются', async () => {
  let now = Date.now(); const engine = setup({ now: () => now, maxSessions: 1, generate: async () => 'ОК' });
  await engine.handle(envelope('', 0, 'one'));
  assert.match((await engine.handle(envelope('', 0, 'two'))).response.text, /занят/);
  now += 21 * 60000;
  assert.match((await engine.handle(envelope('', 0, 'two'))).response.text, /отдельный навык/);
  assert.equal(engine.sessions.size, 1);
});
test('Старые message_id не инициируют генерацию', async () => {
  let calls = 0; const engine = setup({ generate: async () => { calls++; return 'ОК'; } });
  await engine.handle(envelope('Вопрос', 10));
  assert.match((await engine.handle(envelope('Старый', 1))).response.text, /устаревший/); assert.equal(calls, 1);
});
test('Команда выхода завершает сессию', async () => {
  const engine = setup({ generate: async () => 'ОК' }); assert.equal((await engine.handle(envelope('Выход'))).response.end_session, true);
});
test('Пустой command при наличии original_utterance остается приветствием', async () => {
  const engine = setup({ generate: async () => { throw new Error('Не должно вызываться'); } });
  const e = envelope(); e.request.original_utterance = 'Алиса запусти навык';
  assert.match((await engine.handle(e)).response.text, /отдельный навык/);
});
