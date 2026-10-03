import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['start.mjs'];
for (const dir of ['src', 'web', 'test', 'scripts']) {
  for (const file of await readdir(dir)) if (/\.(mjs|js)$/.test(file)) files.push(`${dir}/${file}`);
}
for (const file of files) {
  const run = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status || 1);
}
console.log(`Синтаксис проверен: ${files.length} файлов.`);
