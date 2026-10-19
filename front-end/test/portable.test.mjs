import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  findAsciiMarkers,
  launcherContents,
  repairEncodedPaths
} from '../bin/assemble.mjs';

const assemblerUrl = new URL('../bin/assemble.mjs', import.meta.url);
const execFileAsync = promisify(execFile);

test('assemble skips mkdir for an existing output parent, including a Windows volume root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-assemble-root-'));
  try {
    const entryRoot = join(root, 'front-end');
    const binRoot = join(entryRoot, 'bin');
    const partRoot = join(root, 'front-end-parts-001');
    await mkdir(binRoot, { recursive: true });
    await mkdir(join(partRoot, 'parts'), { recursive: true });
    const payload = Buffer.from('verified MSIX fixture');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    await copyFile(assemblerUrl, join(binRoot, 'assemble.mjs'));
    await writeFile(join(partRoot, 'package.json'), '{}');
    await writeFile(join(partRoot, 'parts', 'code.zip.part-0000'), payload);
    await writeFile(join(entryRoot, 'manifest.json'), JSON.stringify({
      source: { sha256, bytes: payload.length },
      parts: [{ file: 'code.zip.part-0000' }]
    }));
    const output = join(root, 'CodexOffline.source.zip');
    const bootstrap = `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const originalMkdir = fs.mkdir;
      fs.mkdir = async (path, ...args) => {
        if (path === process.env.CODEX_TEST_PARENT) {
          throw Object.assign(new Error('EPERM: operation not permitted, mkdir C:\\\\'), { code: 'EPERM' });
        }
        return originalMkdir(path, ...args);
      };
      syncBuiltinESMExports();
      process.argv = [process.execPath, process.env.CODEX_TEST_ASSEMBLER, 'assemble', process.env.CODEX_TEST_OUTPUT];
      await import(process.env.CODEX_TEST_ASSEMBLER_URL);
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', bootstrap], {
      env: {
        ...process.env,
        CODEX_TEST_PARENT: root,
        CODEX_TEST_ASSEMBLER: join(binRoot, 'assemble.mjs'),
        CODEX_TEST_ASSEMBLER_URL: pathToFileURL(join(binRoot, 'assemble.mjs')).href,
        CODEX_TEST_OUTPUT: output
      }
    });
    assert.match(stdout, new RegExp(sha256));
    assert.deepEqual(await readFile(output), payload);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('offline installation is portable and does not register an AppX package', async () => {
  const source = await readFile(assemblerUrl, 'utf8');
  const launcher = launcherContents();

  assert.doesNotMatch(source, /Add-AppxPackage/);
  assert.doesNotMatch(source, /Developer Mode/);
  assert.doesNotMatch(source, /ZipFile.*ExtractToDirectory/);
  assert.match(source, /tar\.exe/);
  assert.match(source, /if \(!\(await exists\(parentDirectory\)\)\) await mkdir/);
  assert.match(source, /install-portable-msix/);
  assert.match(source, /Source MSIX checksum mismatch/);
  assert.match(launcher, /set "CODEX_SPARKLE_ENABLED=false"/);
  assert.match(launcher, /set "CODEX_CLI_PATH=%~dp0app\\resources\\codex\.exe"/);
  assert.match(launcher, /app\\ChatGPT\.exe/);
});

test('portable extraction repairs URL-encoded npm path components', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-portable-paths-'));
  try {
    const scope = join(root, 'node_modules', '%40scope');
    const universal = join(scope, 'prebuilds', 'darwin-x64%2Barm64');
    await mkdir(universal, { recursive: true });
    await writeFile(join(scope, '%24module.js'), 'fixture');

    assert.equal(await repairEncodedPaths(root), 3);
    await access(join(root, 'node_modules', '@scope', '$module.js'));
    await access(join(root, 'node_modules', '@scope', 'prebuilds', 'darwin-x64+arm64'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('portable extraction fails closed on an unknown encoded component', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-portable-unknown-'));
  try {
    await writeFile(join(root, 'unexpected%3Aname'), 'fixture');
    await assert.rejects(
      repairEncodedPaths(root),
      /Unsupported encoded path component/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime marker scan detects markers split across stream chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-portable-markers-'));
  const fixture = join(root, 'app.asar');
  try {
    await writeFile(fixture, `${'x'.repeat(65_530)}CODEX_SPARKLE_ENABLED`);
    assert.deepEqual(
      await findAsciiMarkers(fixture, ['CODEX_SPARKLE_ENABLED', 'CODEX_CLI_PATH']),
      ['CODEX_CLI_PATH']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
