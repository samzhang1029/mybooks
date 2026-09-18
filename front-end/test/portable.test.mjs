import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findAsciiMarkers,
  launcherContents,
  repairEncodedPaths
} from '../bin/assemble.mjs';

const assemblerUrl = new URL('../bin/assemble.mjs', import.meta.url);

test('offline installation is portable and does not register an AppX package', async () => {
  const source = await readFile(assemblerUrl, 'utf8');
  const launcher = launcherContents();

  assert.doesNotMatch(source, /Add-AppxPackage/);
  assert.doesNotMatch(source, /Developer Mode/);
  assert.doesNotMatch(source, /ZipFile.*ExtractToDirectory/);
  assert.match(source, /tar\.exe/);
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
