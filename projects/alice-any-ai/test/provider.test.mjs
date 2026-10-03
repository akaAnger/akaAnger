import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../src/config.mjs';
import { buildRequest, complete, listModels, cleanText, ProviderError } from '../src/provider.mjs';
const config = () => ({ ...defaults(), model: 'fixture-chat', apiKey: 'fixture-key' });
const response = data => new Response(JSON.stringify(data), { status: 200 });

test('Chat Completions: системная инструкция, лимит и Bearer', () => {
  const c = { ...config(), tokenField: 'max_completion_tokens' }, r = buildRequest(c, [{ role: 'user', content: 'Привет' }]);
  assert.equal(r.headers.authorization, 'Bearer fixture-key');
  assert.equal(r.body.max_completion_tokens, 768); assert.equal(r.body.max_tokens, undefined);
  assert.equal(r.body.messages[0].role, 'system'); assert.equal(r.body.stream, false);
});
test('Anthropic: system отдельно, версия API и текстовые блоки', async () => {
  const c = { ...config(), protocol: 'anthropic' };
  const r = buildRequest(c, [{ role: 'user', content: 'Привет' }]);
  assert.equal(r.headers['anthropic-version'], '2023-06-01'); assert.equal(r.headers['x-api-key'], 'fixture-key');
  assert.equal(r.body.messages[0].role, 'user'); assert.ok(r.url.endsWith('/messages'));
  const out = await complete(c, [], undefined, async () => response({ content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Ответ.' }] }));
  assert.equal(out, 'Ответ.');
});
test('Ответ очищен от Markdown и управляющих тегов', async () => {
  assert.equal(cleanText('**Привет** <speaker audio="x"> [сайт](https://example.com)\n'), 'Привет сайт');
  const out = await complete(config(), [], undefined, async (url, opts) => {
    assert.equal(opts.redirect, 'error'); return response({ choices: [{ message: { content: 'Добрый день.' } }] });
  });
  assert.equal(out, 'Добрый день.');
});
test('Скрытые блоки рассуждений не озвучиваются', () => assert.equal(cleanText('<think>Внутренние рассуждения</think>Ответ'), 'Ответ'));
for (const status of [400, 401, 402, 403, 404, 429, 500]) {
  test(`Ошибка ${status} не раскрывает сырой ответ API или ключ`, async () => {
    await assert.rejects(complete(config(), [], undefined, async () => new Response('fixture-key confidential raw body', { status })), e => e instanceof ProviderError && !e.message.includes('fixture-key') && e.code === `http_${status}`);
  });
}
test('Пустой результат и не-JSON дают понятную ошибку', async () => {
  await assert.rejects(complete(config(), [], undefined, async () => response({ choices: [] })), e => e.code === 'empty');
  await assert.rejects(complete(config(), [], undefined, async () => new Response('<html>wrong endpoint</html>')), e => e.code === 'format');
});
test('Остановка запроса и ошибка сети обработаны', async () => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(complete(config(), [], ac.signal, async () => { throw new Error('raw'); }), e => e.code === 'timeout');
  await assert.rejects(complete(config(), [], undefined, async () => { throw new Error('secret'); }), e => e.code === 'network' && !e.message.includes('secret'));
});
test('Список моделей уникальный и отсортирован', async () => {
  assert.deepEqual(await listModels(config(), async () => response({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, {}] })), ['a', 'b']);
});
test('Локальный провайдер без ключа не получает фиктивный Bearer', () => {
  const r = buildRequest({ ...config(), apiKey: '' }, []); assert.equal(r.headers.authorization, undefined);
});
