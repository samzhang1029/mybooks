#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(sourceDirectory, '..');
const entryDirectory = join(root, 'front-end');
const scope = '@utils-code';
const partSize = 5 * 1024 * 1024;
const partsPerPackage = 10;
const maxPackageBytes = 75 * 1024 * 1024;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const requestedVersionIndex = args.indexOf('--version');
const requestedVersion = requestedVersionIndex === -1 ? undefined : args[requestedVersionIndex + 1];

if (requestedVersionIndex !== -1 && !requestedVersion) {
  throw new Error('Usage: update-npm-packages.mjs [--dry-run] [--force] [--version X.Y.Z]');
}

function assertNpmVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid npm version: ${version}`);
  }
  return version;
}

function nextPatchVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Cannot increment current npm version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
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
  input.on('data', (chunk) => hash.update(chunk));
  await finished(input);
  return hash.digest('hex');
}

function checksumFor(checksums, fileName) {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === fileName) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS.txt has no entry for ${fileName}.`);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readExactly(handle, buffer, length) {
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, null);
    if (bytesRead === 0) throw new Error(`Unexpected end of MSIX after ${offset} bytes.`);
    offset += bytesRead;
  }
}

async function verifyStagedParts(staging, parts, expectedArchiveChecksum) {
  const archiveHash = createHash('sha256');
  let totalBytes = 0;

  for (const part of parts) {
    const chunkNumber = String(Math.floor(Number(part.file.slice(-4)) / partsPerPackage) + 1).padStart(3, '0');
    const path = join(staging, `front-end-parts-${chunkNumber}`, 'parts', part.file);
    const partHash = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', (data) => {
      partHash.update(data);
      archiveHash.update(data);
      totalBytes += data.length;
    });
    await finished(input);
    const actualPartChecksum = partHash.digest('hex');
    if (actualPartChecksum !== part.sha256) throw new Error(`Staged checksum mismatch: ${part.file}`);
  }

  const actualArchiveChecksum = archiveHash.digest('hex');
  if (actualArchiveChecksum !== expectedArchiveChecksum) {
    throw new Error(`Reassembled checksum mismatch: expected ${expectedArchiveChecksum}, got ${actualArchiveChecksum}.`);
  }
  return totalBytes;
}

async function replacePackages(staging, newNames) {
  const backup = await mkdtemp(join(root, '.windows-codex-backup-'));
  const existingNames = (await readdir(root)).filter((name) => name === 'front-end' || /^front-end-parts-\d{3}$/.test(name));
  const movedOld = [];
  const movedNew = [];

  try {
    for (const name of existingNames) {
      await rename(join(root, name), join(backup, name));
      movedOld.push(name);
    }
    for (const name of newNames) {
      await rename(join(staging, name), join(root, name));
      movedNew.push(name);
    }
  } catch (error) {
    for (const name of movedNew.reverse()) await rm(join(root, name), { recursive: true, force: true });
    for (const name of movedOld.reverse()) await rename(join(backup, name), join(root, name));
    throw error;
  }

  await rm(backup, { recursive: true, force: true });
}

const releaseManifestPath = join(sourceDirectory, 'release-manifest.json');
const checksumsPath = join(sourceDirectory, 'SHA256SUMS.txt');
const currentPackagePath = join(entryDirectory, 'package.json');
const currentManifestPath = join(entryDirectory, 'manifest.json');
const assemblerPath = join(entryDirectory, 'bin', 'assemble.mjs');

const [releaseManifest, checksums, currentPackage, currentManifest] = await Promise.all([
  readFile(releaseManifestPath, 'utf8').then(JSON.parse),
  readFile(checksumsPath, 'utf8'),
  readFile(currentPackagePath, 'utf8').then(JSON.parse),
  readFile(currentManifestPath, 'utf8').then(JSON.parse)
]);

const x64 = releaseManifest?.sources?.windows?.architectures?.x64;
if (!x64?.downloadable) throw new Error('release-manifest.json has no downloadable Windows x64 package.');

const msixFile = `${x64.packageMoniker}.Msix`;
const msixPath = join(sourceDirectory, msixFile);
if (!(await exists(msixPath))) throw new Error(`Missing downloaded MSIX: ${msixPath}`);

const msixStat = await stat(msixPath);
if (msixStat.size !== Number(x64.contentLength)) {
  throw new Error(`MSIX size mismatch: expected ${x64.contentLength}, got ${msixStat.size}.`);
}

const expectedArchiveChecksum = checksumFor(checksums, msixFile);
const catalogChecksum = Buffer.from(x64.catalog.hash, 'base64').toString('hex');
if (catalogChecksum !== expectedArchiveChecksum) {
  throw new Error('SHA256SUMS.txt does not match the Microsoft catalog checksum in release-manifest.json.');
}

const actualArchiveChecksum = await sha256(msixPath);
if (actualArchiveChecksum !== expectedArchiveChecksum) {
  throw new Error(`MSIX checksum mismatch: expected ${expectedArchiveChecksum}, got ${actualArchiveChecksum}.`);
}

if (currentManifest?.source?.sha256 === expectedArchiveChecksum && !force) {
  console.log(`Already materialized Codex ${x64.appVersion} as npm ${currentPackage.version}.`);
  console.log('No package files were changed. Use --force to rebuild the same source.');
  process.exit(0);
}

const currentVersion = assertNpmVersion(currentPackage.version);
const newVersion = assertNpmVersion(requestedVersion ?? nextPatchVersion(currentVersion));
if (newVersion === currentVersion && !force) {
  throw new Error(`New npm version must differ from ${currentVersion}; use --force to rebuild it.`);
}

const partCount = Math.ceil(msixStat.size / partSize);
const packageCount = Math.ceil(partCount / partsPerPackage);

console.log(`Codex app: ${x64.appVersion}`);
console.log(`Codex backend: ${x64.backendVersion}`);
console.log(`Windows package: ${x64.version} x64`);
console.log(`Source: ${msixFile}`);
console.log(`Source SHA-256: ${expectedArchiveChecksum}`);
console.log(`npm version: ${currentVersion} -> ${newVersion}`);
console.log(`Plan: ${partCount} parts in ${packageCount} data packages`);

if (dryRun) {
  console.log('Dry run complete; npm package files were not changed.');
  process.exit(0);
}

const staging = await mkdtemp(join(root, '.windows-codex-staging-'));
try {
  const parts = [];
  const source = await open(msixPath, 'r');
  try {
    for (let index = 0; index < partCount; index += 1) {
      const bytes = Math.min(partSize, msixStat.size - index * partSize);
      const buffer = Buffer.allocUnsafe(bytes);
      await readExactly(source, buffer, bytes);

      const file = `code.zip.part-${String(index).padStart(4, '0')}`;
      const number = String(Math.floor(index / partsPerPackage) + 1).padStart(3, '0');
      const partsDirectory = join(staging, `front-end-parts-${number}`, 'parts');
      await mkdir(partsDirectory, { recursive: true });
      await writeFile(join(partsDirectory, file), buffer);
      parts.push({ file, bytes, sha256: createHash('sha256').update(buffer).digest('hex') });

      if ((index + 1) % 10 === 0 || index + 1 === partCount) {
        console.log(`Split ${index + 1}/${partCount} parts`);
      }
    }
  } finally {
    await source.close();
  }

  const sourceInfo = {
    file: msixFile,
    bytes: msixStat.size,
    sha256: expectedArchiveChecksum,
    architecture: 'x64',
    packageName: 'OpenAI.Codex',
    packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0',
    applicationId: 'App',
    codexVersion: x64.appVersion,
    backendVersion: x64.backendVersion,
    windowsPackageVersion: x64.version
  };

  const chunks = [];
  for (let start = 0; start < parts.length; start += partsPerPackage) {
    const number = String(chunks.length + 1).padStart(3, '0');
    const packageName = `${scope}/front-end-parts-${number}`;
    const chunkParts = parts.slice(start, start + partsPerPackage);
    const packageDirectory = join(staging, `front-end-parts-${number}`);
    const packageBytes = chunkParts.reduce((total, part) => total + part.bytes, 0);
    if (packageBytes > maxPackageBytes) {
      throw new Error(`${packageName} contains ${packageBytes} bytes; exceeds the 75 MiB guard.`);
    }

    chunks.push({ number, packageName, parts: chunkParts });
    await writeJson(join(packageDirectory, 'package.json'), {
      name: packageName,
      version: newVersion,
      description: `Data segment ${number} for ${scope}/front-end.`,
      license: 'UNLICENSED',
      private: false,
      publishConfig: { registry: 'https://registry.npmjs.org/' },
      files: ['parts', 'manifest.json']
    });
    await writeJson(join(packageDirectory, 'manifest.json'), {
      package: packageName,
      version: newVersion,
      source: sourceInfo,
      parts: chunkParts
    });
  }

  const stagedEntry = join(staging, 'front-end');
  await mkdir(join(stagedEntry, 'bin'), { recursive: true });
  await copyFile(assemblerPath, join(stagedEntry, 'bin', 'assemble.mjs'));
  await chmod(join(stagedEntry, 'bin', 'assemble.mjs'), 0o755);
  const testDirectory = join(entryDirectory, 'test');
  if (await exists(testDirectory)) await cp(testDirectory, join(stagedEntry, 'test'), { recursive: true });

  const dependencies = Object.fromEntries(chunks.map(({ packageName }) => [packageName, newVersion]));
  await writeJson(join(stagedEntry, 'package.json'), {
    name: `${scope}/front-end`,
    version: newVersion,
    description: 'Portable installer and assembler for the split Codex Windows application archive.',
    license: 'UNLICENSED',
    type: 'module',
    publishConfig: { registry: 'https://registry.npmjs.org/' },
    bin: { 'utils-code-front-end': './bin/assemble.mjs' },
    files: ['bin', 'manifest.json', 'README.md'],
    dependencies
  });
  await writeJson(join(stagedEntry, 'manifest.json'), {
    version: newVersion,
    source: sourceInfo,
    chunks,
    parts
  });
  await writeFile(
    join(stagedEntry, 'README.md'),
    `# ${scope}/front-end

This package contains the archive segments for Codex Windows ${x64.appVersion}. It assembles the verified official MSIX and extracts a portable copy without Microsoft Store/AppX registration. No install lifecycle script runs automatically.

## Portable installation on Windows (CMD)

Exit existing Codex/ChatGPT processes. From an installer directory, run:

\`\`\`cmd
npm install ${scope}/front-end@${newVersion} --ignore-scripts
node_modules\\.bin\\utils-code-front-end.cmd install-portable "%USERPROFILE%\\CodexOffline"
call "%USERPROFILE%\\CodexOffline\\Codex.cmd"
\`\`\`

Always launch through \`Codex.cmd\` (or the \`launch\` command). Directly opening \`app\\ChatGPT.exe\` omits the required portable environment and can fail with a package-identity error. Point shortcuts at \`Codex.cmd\`.

The installer does not call \`Add-AppxPackage\`, require Developer Mode, or modify the official executable or ASAR. It disables the package-only updater and selects the bundled Codex CLI. \`install-offline\` remains an alias for \`install-portable\`.

To replace an existing portable directory, close Codex and add \`--force\`. Use a short, dedicated application directory. “Offline” means Store-independent installation and startup; sign-in and model requests still require network access.

## Assemble the original MSIX

\`\`\`cmd
node_modules\\.bin\\utils-code-front-end.cmd assemble .\\OpenAI.Codex.msix
\`\`\`

## Pre-publication verification

The repository's **Windows portable smoke test** downloads the pinned MSIX, rebuilds the npm parts, packs and installs all packages locally, and runs the installed \`install-portable\` command at \`C:\\CodexOffline\`. It verifies a renderer page is created and remains running. Diagnostics are uploaded even on failure. No account or model request is required.
`
  );

  const verifiedBytes = await verifyStagedParts(staging, parts, expectedArchiveChecksum);
  if (verifiedBytes !== msixStat.size) {
    throw new Error(`Reassembled size mismatch: expected ${msixStat.size}, got ${verifiedBytes}.`);
  }

  const newNames = [...chunks.map(({ number }) => `front-end-parts-${number}`), 'front-end'];
  await replacePackages(staging, newNames);
  console.log(`Updated ${newNames.length} npm packages to ${newVersion}.`);
  console.log(`Reassembly verified: ${verifiedBytes} bytes, SHA-256 ${expectedArchiveChecksum}.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
