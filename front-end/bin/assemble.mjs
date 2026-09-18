#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, realpathSync } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
const entryPackageRoot = dirname(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath));
const supportedEncodedComponents = new Map([
  ['%40', '@'],
  ['%24', '$'],
  ['%2B', '+']
]);
const runtimeMarkers = ['CODEX_SPARKLE_ENABLED', 'CODEX_CLI_PATH'];

function usage() {
  console.log(`Usage:
  utils-code-front-end assemble [output.msix]
  utils-code-front-end install-portable [install-directory] [--force] [--launch]
  utils-code-front-end install-portable-msix <source.msix> [install-directory] [--force] [--launch]
  utils-code-front-end install-offline [install-directory] [--force] [--launch]
  utils-code-front-end launch [install-directory]

The portable installer extracts the verified official MSIX without registering
an AppX package. The default directory is
%LOCALAPPDATA%\\Programs\\OpenAI.Codex.Portable.`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', (buffer) => hash.update(buffer));
  await finished(input);
  return hash.digest('hex');
}

async function resolvePartPackageRoot(chunkNumber) {
  const sibling = resolve(entryPackageRoot, '..', `front-end-parts-${chunkNumber}`);
  if (await exists(join(sibling, 'package.json'))) return sibling;
  return dirname(require.resolve(`@utils-code/front-end-parts-${chunkNumber}/package.json`));
}

async function assemble(outputArgument = './OpenAI.Codex.msix') {
  const output = resolve(outputArgument);
  if (await exists(output)) throw new Error(`Refusing to overwrite ${output}`);

  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.partial`;
  await rm(temporary, { force: true });
  const target = createWriteStream(temporary, { flags: 'wx' });
  const hash = createHash('sha256');

  try {
    for (const part of manifest.parts) {
      const chunkNumber = String(Math.floor(Number(part.file.slice(-4)) / 10) + 1).padStart(3, '0');
      const packageRoot = await resolvePartPackageRoot(chunkNumber);
      const source = createReadStream(resolve(packageRoot, 'parts', part.file));
      source.on('data', (buffer) => hash.update(buffer));
      source.pipe(target, { end: false });
      await finished(source);
    }
    target.end();
    await finished(target);

    const actualHash = hash.digest('hex');
    if (actualHash !== manifest.source.sha256) {
      throw new Error(`Archive checksum mismatch: expected ${manifest.source.sha256}, got ${actualHash}`);
    }

    await rename(temporary, output);
    console.log(`Created ${output}`);
    console.log(`SHA-256 ${actualHash}`);
    return output;
  } catch (error) {
    target.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

function runPowerShell(script, extraEnvironment = {}) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnvironment },
      stdio: 'inherit'
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PowerShell failed with exit code ${result.status}`);
}

function assertWindows() {
  if (process.platform !== 'win32') {
    throw new Error('Portable installation and launch are only supported on Windows.');
  }
}

function defaultInstallDirectory(directoryArgument) {
  if (directoryArgument) return resolve(directoryArgument);
  if (!process.env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is unavailable; pass an absolute install directory.');
  }
  return resolve(process.env.LOCALAPPDATA, 'Programs', 'OpenAI.Codex.Portable');
}

function decodeSupportedComponent(name) {
  let decoded = name;
  for (const [encoded, value] of supportedEncodedComponents) {
    decoded = decoded.replaceAll(new RegExp(encoded, 'gi'), value);
  }
  return decoded;
}

async function collectEncodedPaths(root, result = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await collectEncodedPaths(path, result);

    const encodedTokens = entry.name.match(/%[0-9a-f]{2}/gi) ?? [];
    const unsupported = encodedTokens.filter(
      (token) => !supportedEncodedComponents.has(token.toUpperCase())
    );
    if (unsupported.length > 0) {
      throw new Error(`Unsupported encoded path component ${entry.name} at ${path}`);
    }
    if (encodedTokens.length > 0) result.push(path);
  }
  return result;
}

export async function repairEncodedPaths(root) {
  const encodedPaths = await collectEncodedPaths(root);
  encodedPaths.sort((left, right) => right.length - left.length);

  for (const source of encodedPaths) {
    const parent = dirname(source);
    const name = source.slice(parent.length + 1);
    const destination = join(parent, decodeSupportedComponent(name));
    if (source === destination) continue;
    if (await exists(destination)) {
      throw new Error(`Cannot repair encoded path because the destination exists: ${destination}`);
    }
    await rename(source, destination);
  }
  return encodedPaths.length;
}

async function assertFile(path, label) {
  if (!(await exists(path)) || !(await stat(path)).isFile()) {
    throw new Error(`${label} was not found: ${path}`);
  }
}

export async function findAsciiMarkers(path, markers) {
  const remaining = new Set(markers);
  const longest = Math.max(...markers.map((marker) => marker.length));
  let carry = '';
  const input = createReadStream(path);
  for await (const chunk of input) {
    const text = carry + chunk.toString('latin1');
    for (const marker of remaining) {
      if (text.includes(marker)) remaining.delete(marker);
    }
    if (remaining.size === 0) break;
    carry = text.slice(-(longest - 1));
  }
  input.destroy();
  return [...remaining];
}

async function assertPortableRuntime(appRoot) {
  const executable = join(appRoot, 'ChatGPT.exe');
  const cli = join(appRoot, 'resources', 'codex.exe');
  const asar = join(appRoot, 'resources', 'app.asar');
  await assertFile(executable, 'Codex desktop executable');
  await assertFile(cli, 'Bundled Codex CLI');
  await assertFile(asar, 'Electron ASAR');

  const missingMarkers = await findAsciiMarkers(asar, runtimeMarkers);
  if (missingMarkers.length > 0) {
    throw new Error(
      `Codex ${manifest.source.codexVersion} does not expose the required portable runtime hooks: ${missingMarkers.join(', ')}`
    );
  }
}

export function launcherContents() {
  return [
    '@echo off',
    'setlocal',
    'set "CODEX_SPARKLE_ENABLED=false"',
    'set "CODEX_CLI_PATH=%~dp0app\\resources\\codex.exe"',
    'set "CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE=1"',
    'start "" /D "%~dp0app" "%~dp0app\\ChatGPT.exe" %*',
    ''
  ].join('\r\n');
}

function parseInstallArguments(arguments_) {
  const knownFlags = new Set(['--force', '--launch']);
  const unknownFlag = arguments_.find((argument) => argument.startsWith('-') && !knownFlags.has(argument));
  if (unknownFlag) throw new Error(`Unknown option: ${unknownFlag}`);
  const positional = arguments_.filter((argument) => !knownFlags.has(argument));
  if (positional.length > 1) throw new Error('Pass at most one install directory.');
  return {
    directory: positional[0],
    force: arguments_.includes('--force'),
    launch: arguments_.includes('--launch')
  };
}

function parseMsixInstallArguments(arguments_) {
  const options = parseInstallArguments(arguments_.slice(1));
  const archive = arguments_[0];
  if (!archive || archive.startsWith('-')) {
    throw new Error('Pass the verified source MSIX as the first argument.');
  }
  return { ...options, archive: resolve(archive) };
}

async function validateSourceArchive(archive) {
  await assertFile(archive, 'Source MSIX');
  const archiveStat = await stat(archive);
  if (archiveStat.size !== manifest.source.bytes) {
    throw new Error(`Source MSIX size mismatch: expected ${manifest.source.bytes}, got ${archiveStat.size}`);
  }
  const actualHash = await sha256(archive);
  if (actualHash !== manifest.source.sha256) {
    throw new Error(`Source MSIX checksum mismatch: expected ${manifest.source.sha256}, got ${actualHash}`);
  }
  console.log(`Verified source MSIX SHA-256 ${actualHash}`);
}

function assertShortInstallPath(installDirectory) {
  if (installDirectory.length > 80) {
    throw new Error(`Install path is too long (${installDirectory.length} characters). Use a short path such as C:\\CodexOffline.`);
  }
}

async function extractPortableArchive(archive, installDirectory, options) {
  assertShortInstallPath(installDirectory);
  if ((await exists(installDirectory)) && !options.force) {
    throw new Error(`Install directory already exists: ${installDirectory}. Pass --force to replace it.`);
  }

  const stagingDirectory = `${installDirectory}.partial-${process.pid}`;
  await mkdir(dirname(installDirectory), { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });

  try {
    await mkdir(stagingDirectory, { recursive: true });
    runPowerShell(
      "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:UTILS_CODE_ARCHIVE, $env:UTILS_CODE_STAGING)",
      {
        UTILS_CODE_ARCHIVE: archive,
        UTILS_CODE_STAGING: stagingDirectory
      }
    );

    const appRoot = join(stagingDirectory, 'app');
    const repairedPaths = await repairEncodedPaths(appRoot);
    await assertPortableRuntime(appRoot);
    await writeFile(join(stagingDirectory, 'Codex.cmd'), launcherContents(), 'ascii');
    await writeFile(
      join(stagingDirectory, '.utils-code-portable.json'),
      `${JSON.stringify({
        installedAt: new Date().toISOString(),
        npmVersion: manifest.version,
        codexVersion: manifest.source.codexVersion,
        backendVersion: manifest.source.backendVersion,
        windowsPackageVersion: manifest.source.windowsPackageVersion,
        sourceSha256: manifest.source.sha256,
        mode: 'portable',
        repairedEncodedPaths: repairedPaths
      }, null, 2)}\n`
    );

    if (await exists(installDirectory)) await rm(installDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, installDirectory);
    console.log(`Installed portable Codex ${manifest.source.codexVersion} at ${installDirectory}`);
    console.log(`Repaired ${repairedPaths} encoded archive paths.`);
    console.log(`Run ${join(installDirectory, 'Codex.cmd')}`);

    if (options.launch) await launchPortable(installDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function installPortable(arguments_) {
  assertWindows();
  const options = parseInstallArguments(arguments_);
  const installDirectory = defaultInstallDirectory(options.directory);
  const archive = `${installDirectory}.source-${process.pid}.zip`;
  await rm(archive, { force: true });

  try {
    await assemble(archive);
    await extractPortableArchive(archive, installDirectory, options);
  } finally {
    await rm(archive, { force: true });
  }
}

async function installPortableMsix(arguments_) {
  assertWindows();
  const options = parseMsixInstallArguments(arguments_);
  const installDirectory = defaultInstallDirectory(options.directory);
  await validateSourceArchive(options.archive);
  await extractPortableArchive(options.archive, installDirectory, options);
}

async function launchPortable(directoryArgument) {
  assertWindows();
  const installDirectory = defaultInstallDirectory(directoryArgument);
  const executable = join(installDirectory, 'app', 'ChatGPT.exe');
  const cli = join(installDirectory, 'app', 'resources', 'codex.exe');
  await assertFile(executable, 'Portable Codex executable');
  await assertFile(cli, 'Portable Codex CLI');
  const child = spawn(executable, [], {
    cwd: join(installDirectory, 'app'),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_SPARKLE_ENABLED: 'false',
      CODEX_CLI_PATH: cli,
      CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE: '1'
    }
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  child.unref();
  console.log(`Launched portable Codex from ${executable}`);
}

function isMainModule() {
  if (!process.argv[1] || process.argv[1] === '-') return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [command = 'assemble', ...commandArguments] = process.argv.slice(2);

  if (command === 'assemble') {
    await assemble(commandArguments[0]);
  } else if (command === 'install-portable' || command === 'install-offline') {
    await installPortable(commandArguments);
  } else if (command === 'install-portable-msix') {
    await installPortableMsix(commandArguments);
  } else if (command === 'launch') {
    await launchPortable(commandArguments[0]);
  } else if (command === '--help' || command === '-h' || command === 'help') {
    usage();
  } else {
    usage();
    process.exitCode = 1;
  }
}
