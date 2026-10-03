import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, validateConfig, validateBaseUrl, mergeEditable, publicConfig, loadConfig, saveConfig } from '../src/config.mjs';

test('Секреты случайные, различные, не короче 32 символов', () => {
  const a = defaults(), b = defaults();
  assert.notEqual(a.adminToken, a.webhookSecret); assert.notEqual(a.adminToken, b.adminToken);
  assert.ok(a.adminToken.length >= 32); assert.equal(validateConfig(a).provider, 'deepseek');
});
for (const url of ['ftp://example.com', 'http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#key', 'https://example.com/v1/chat/completions']) {
  test(`Опасный или полный URL отклонен: ${url}`, () => assert.throws(() => validateBaseUrl(url)));
}
test('Локальный Ollama и безопасные HTTPS API допустимы', () => {
  for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://host.docker.internal:11434/v1', 'https://api.example.com/v1']) assert.equal(validateBaseUrl(url), url);
});
test('При смене адреса старый ключ не пересылается', () => {
  const c = { ...defaults(), apiKey: 'dummy-provider-key-not-a-secret' };
  assert.equal(mergeEditable(c, { model: 'chat-model', apiKey: '' }).apiKey, c.apiKey);
  assert.equal(mergeEditable(c, { baseUrl: 'https://other.example/v1', apiKey: '' }).apiKey, '');
  assert.equal(mergeEditable(c, { provider: 'custom', apiKey: '' }).apiKey, '');
  assert.equal(mergeEditable(c, { clearApiKey: true }).apiKey, '');
});
test('Публичный конфиг не раскрывает ключ ИИ и ключ панели', () => {
  const c = defaults(), p = publicConfig(c);
  assert.equal(p.apiKey, undefined); assert.equal(p.adminToken, undefined); assert.equal(p.webhookSecret, undefined);
  assert.ok(p.webhookPath.includes(c.webhookSecret)); // Только авторизованный администратор получает этот объект.
});
test('Недопустимые лимиты, одинаковые секреты и произвольные параметры блокируются', () => {
  for (const patch of [{ waitMs: 4500 }, { maxTokens: -1 }, { dailyLimit: 0 }, { extra: { tools: [] } }, { publicUrl: 'http://example.com' }, { publicUrl: 'https://example.com/path' }, { adminToken: 'short' }]) assert.throws(() => validateConfig({ ...defaults(), ...patch }));
  const c = defaults(); assert.throws(() => validateConfig({ ...c, adminToken: c.webhookSecret }));
});
test('Конфигурация переживает перезапуск; секреты env имеют приоритет', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'alice-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const c = defaults(); await saveConfig(dir, c);
  const restored = await loadConfig(dir, {}); assert.deepEqual(restored, c);
  const envToken = 'e'.repeat(64); assert.equal((await loadConfig(dir, { ADMIN_TOKEN: envToken })).adminToken, envToken);
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'config.json'))).mode & 0o777, 0o600);
  assert.ok((await readFile(join(dir, 'config.json'), 'utf8')).endsWith('\n'));
});
