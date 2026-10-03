import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig } from './src/config.mjs';
import { createApplication } from './src/server.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, '.data');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
let app, tunnel;

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Нужен Node.js 22 или новее.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный PORT.');
  const config = await loadConfig(dataDir);
  await saveConfig(dataDir, config);
  app = await createApplication({ config, dataDir });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject); app.server.listen(port, host, resolve);
  });
  const local = `http://127.0.0.1:${port}`;
  console.log(`Alice Any AI запущен. Панель: ${config.publicUrl || local}`);
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
    const setup = `${local}/#${encodeURIComponent(config.adminToken)}`;
    console.log(`Личная ссылка настройки (не публикуйте): ${setup}`);
    if (process.argv.includes('--open')) {
      let child;
      if (process.platform === 'win32') child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', setup], { stdio: 'ignore' });
      else if (process.platform === 'darwin') child = spawn('open', [setup], { stdio: 'ignore' });
      else child = spawn('xdg-open', [setup], { stdio: 'ignore' });
      child.on('error', () => console.log('Откройте личную ссылку настройки вручную.'));
    }
  } else console.log('Для входа используйте ADMIN_TOKEN из переменных окружения. Секреты в общие логи не выводятся.');
  if (process.argv.includes('--tunnel')) {
    // Используем установленный пользователем cloudflared; ничего не скачиваем и не исполняем из сети.
    tunnel = spawn('cloudflared', ['--no-autoupdate', 'tunnel', '--url', local], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    const receive = data => {
      buffer = (buffer + data.toString()).slice(-6000);
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && app.config.publicUrl !== match[0]) {
        app.setPublicUrl(match[0]); console.log('Временный HTTPS-адрес готов. Нажмите «Обновить адрес» в панели. После перезапуска туннеля адрес изменится.');
      }
    };
    tunnel.stdout.on('data', receive); tunnel.stderr.on('data', receive);
    tunnel.on('error', () => console.log('cloudflared не найден. Локальная панель работает. Установите cloudflared по docs/LOCAL.md или используйте облачное размещение.'));
    tunnel.on('exit', code => { if (code) console.log('Туннель завершился. Проверьте установку cloudflared и интернет. Панель продолжает работать локально.'); });
  }
} catch (e) {
  console.error(e.code === 'EADDRINUSE' ? 'Порт занят. Закройте другую копию программы или укажите другой PORT.' : e.message);
  process.exitCode = 1;
}

let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  tunnel?.kill();
  if (app) await app.close();
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
