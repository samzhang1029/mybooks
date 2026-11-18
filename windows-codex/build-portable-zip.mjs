#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findAsciiMarkers, launcherContents, repairEncodedPaths } from '../front-end/bin/assemble.mjs';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(sourceDirectory, '..', 'front-end', 'manifest.json'), 'utf8'));
const archive = join(sourceDirectory, manifest.source.file);
const output = resolve(process.argv[2] ?? join(sourceDirectory, 'dist',
  `Codex-${manifest.source.codexVersion}-win-x64-portable.zip`));
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function runTar(args) {
  const result = spawnSync(tar, args, {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar failed with exit code ${result.status}`);
}

async function archiveMemberHash(zip, member) {
  const child = spawn(tar, ['-xOf', zip, member], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (code) => code === 0 ? resolveClose() : rejectClose(new Error(stderr || `tar exited ${code}`)));
  });
  const hash = createHash('sha256');
  for await (const chunk of child.stdout) hash.update(chunk);
  await closed;
  return hash.digest('hex');
}

if (await exists(output)) throw new Error(`Refusing to overwrite ${output}`);
if ((await stat(archive)).size !== manifest.source.bytes || await sha256(archive) !== manifest.source.sha256) {
  throw new Error('The source MSIX does not match the verified size and SHA-256.');
}
console.log(`Verified source Codex ${manifest.source.codexVersion}.`);

const staging = await mkdtemp(join(tmpdir(), 'codex-portable-zip-'));
try {
  const portableRoot = join(staging, 'CodexOffline');
  await mkdir(portableRoot);
  runTar(['-xf', archive, '-C', portableRoot]);
  const repairedPaths = await repairEncodedPaths(join(portableRoot, 'app'));
  const criticalFiles = ['app/ChatGPT.exe', 'app/resources/codex.exe', 'app/resources/app.asar'];
  for (const file of criticalFiles) {
    if (!(await stat(join(portableRoot, file))).isFile()) throw new Error(`Missing runtime file: ${file}`);
  }
  const missing = await findAsciiMarkers(join(portableRoot, 'app/resources/app.asar'),
    ['CODEX_SPARKLE_ENABLED', 'CODEX_CLI_PATH']);
  if (missing.length) throw new Error(`Missing portable runtime hooks: ${missing.join(', ')}`);
  await writeFile(join(portableRoot, 'Codex.cmd'), launcherContents(), 'ascii');
  const readme = [
    `Codex Windows x64 便携版 ${manifest.source.codexVersion}`,
    '打包方式：Windows x64 便携 ZIP（无需安装 npm）',
    '',
    '使用方法：',
    '1. 关闭正在运行的 Codex/ChatGPT。',
    '2. 将整个 CodexOffline 文件夹解压到短路径，例如 C:\\Users\\你的用户名\\CodexOffline。',
    '3. 双击 CodexOffline 文件夹中的 Codex.cmd 启动。',
    '4. 如需桌面快捷方式，请把快捷方式指向 Codex.cmd。',
    '',
    '必须先完整解压；不能在压缩软件的预览窗口内运行。',
    '请通过 Codex.cmd 启动，它会设置便携运行所需的环境变量。',
    '直接双击 app\\ChatGPT.exe 可能出现“该进程没有程序包标识符”。',
    '',
    '此包不需要安装 Node.js/npm，不需要 Microsoft Store、AppX 注册或开发者模式。',
    '便携版使用原始程序文件；登录账号和发送模型请求仍需要网络。',
    '升级时先关闭旧版，再将新版本解压到一个新文件夹使用。',
    '',
    `Windows 包版本：${manifest.source.windowsPackageVersion}`,
    `内置后端版本：${manifest.source.backendVersion}`,
    `原始 MSIX SHA-256：${manifest.source.sha256}`,
    ''
  ].join('\r\n');
  await writeFile(join(portableRoot, 'README.txt'), `\uFEFF${readme}`, 'utf8');
  await writeFile(join(portableRoot, '.utils-code-portable.json'), `${JSON.stringify({
    packagedAt: new Date().toISOString(),
    packagingVersion: manifest.source.codexVersion,
    codexVersion: manifest.source.codexVersion,
    backendVersion: manifest.source.backendVersion,
    windowsPackageVersion: manifest.source.windowsPackageVersion,
    sourceSha256: manifest.source.sha256,
    mode: 'portable-zip',
    repairedEncodedPaths: repairedPaths
  }, null, 2)}\n`);
  const expectedHashes = new Map();
  for (const file of [...criticalFiles, 'Codex.cmd', 'README.txt']) {
    expectedHashes.set(file, await sha256(join(portableRoot, file)));
  }

  if (!(await exists(dirname(output)))) await mkdir(dirname(output), { recursive: true });
  console.log(`Creating ${output}; repaired ${repairedPaths} encoded paths.`);
  runTar(['--format=zip', '-cf', output, '-C', staging, 'CodexOffline']);

  for (const [file, expected] of expectedHashes) {
    const actual = await archiveMemberHash(output, `CodexOffline/${file}`);
    if (actual !== expected) throw new Error(`ZIP round-trip checksum mismatch: ${file}`);
    console.log(`Verified ZIP member: ${file}`);
  }
  const checksum = await sha256(output);
  await writeFile(`${output}.sha256`, `${checksum}  ${basename(output)}\n`, 'ascii');
  console.log(JSON.stringify({ path: output, bytes: (await stat(output)).size, sha256: checksum }, null, 2));
} catch (error) {
  await rm(output, { force: true });
  await rm(`${output}.sha256`, { force: true });
  throw error;
} finally {
  await rm(staging, { recursive: true, force: true });
}
