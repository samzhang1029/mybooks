#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

const repository = 'Wangnov/codex-app-mirror';
const outputDirectory = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value.`);
  return value;
}

const releaseTag = optionValue('--tag');
const knownOptions = new Set(['--dry-run', '--force', '--tag']);
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--tag') {
    index += 1;
  } else if (!knownOptions.has(argument)) {
    throw new Error(`Unknown option: ${argument}`);
  }
}

const releasePath = releaseTag
  ? `releases/tags/${encodeURIComponent(releaseTag)}`
  : 'releases/latest';
const apiUrl = `https://api.github.com/repos/${repository}/${releasePath}`;

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'utils-code-codex-downloader',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
};

async function fetchResponse(url) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status} ${response.statusText}): ${url}`);
  }
  return response;
}

async function fetchText(url) {
  return await (await fetchResponse(url)).text();
}

async function sha256(path) {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', (chunk) => hash.update(chunk));
  await finished(input);
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function findSingleAsset(release, predicate, description) {
  const matches = release.assets.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${description} asset, found ${matches.length}.`);
  }
  return matches[0];
}

function expectedChecksum(checksums, fileName) {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === fileName) return match[1].toLowerCase();
  }
  throw new Error(`No SHA-256 entry found for ${fileName}.`);
}

function validateManifest(manifest, release, msixAsset, checksum) {
  const windows = manifest?.sources?.windows;
  const x64 = windows?.architectures?.x64;
  if (!windows || !x64) throw new Error('release-manifest.json has no Windows x64 metadata.');

  const manifestFileName = `${x64.packageMoniker}.Msix`;
  if (manifestFileName !== msixAsset.name) {
    throw new Error(`Manifest expects ${manifestFileName}, release contains ${msixAsset.name}.`);
  }
  if (release.tag_name !== `codex-app-${x64.appVersion}`) {
    throw new Error(`Release tag ${release.tag_name} does not match Codex ${x64.appVersion}.`);
  }
  if (Number(x64.contentLength) !== Number(msixAsset.size)) {
    throw new Error(`Manifest size ${x64.contentLength} does not match asset size ${msixAsset.size}.`);
  }

  const catalogChecksum = Buffer.from(x64.catalog.hash, 'base64').toString('hex');
  if (catalogChecksum !== checksum) {
    throw new Error('GitHub checksum does not match the Microsoft catalog checksum in the manifest.');
  }

  return {
    appVersion: x64.appVersion,
    backendVersion: x64.backendVersion,
    packageVersion: x64.version
  };
}

async function writeVerifiedMetadata(asset, contents) {
  const destination = resolve(outputDirectory, asset.name);
  const temporary = `${destination}.part`;
  await rm(temporary, { force: true });
  await writeFile(temporary, contents);
  await rm(destination, { force: true });
  await rename(temporary, destination);
  return destination;
}

async function downloadMsix(asset, checksum) {
  const destination = resolve(outputDirectory, asset.name);
  if (await exists(destination)) {
    const currentChecksum = await sha256(destination);
    if (currentChecksum === checksum) {
      console.log(`Already verified: ${basename(destination)}`);
      return destination;
    }
    if (!force) {
      throw new Error(`Existing file has the wrong checksum: ${destination}\nUse --force to replace it.`);
    }
  }

  const temporary = `${destination}.part`;
  await rm(temporary, { force: true });

  const response = await fetchResponse(asset.browser_download_url);
  if (!response.body) throw new Error(`Download response has no body: ${asset.name}`);

  const totalBytes = Number(response.headers.get('content-length') ?? asset.size);
  let downloadedBytes = 0;
  let lastReportedPercent = -1;
  const hash = createHash('sha256');
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      downloadedBytes += chunk.length;
      const percent = totalBytes > 0 ? Math.floor(downloadedBytes * 100 / totalBytes) : 0;
      if (percent >= lastReportedPercent + 5 || percent === 100) {
        process.stdout.write(`\rDownloading ${asset.name}: ${percent}%`);
        lastReportedPercent = percent;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(temporary, { flags: 'wx' }));
    process.stdout.write('\n');

    const actualSize = (await stat(temporary)).size;
    if (actualSize !== asset.size) {
      throw new Error(`Size mismatch for ${asset.name}: expected ${asset.size}, got ${actualSize}.`);
    }

    const actualChecksum = hash.digest('hex');
    if (actualChecksum !== checksum) {
      throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${checksum}, got ${actualChecksum}.`);
    }

    if (await exists(destination)) await rm(destination, { force: true });
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const release = await (await fetchResponse(apiUrl)).json();
const msixAsset = findSingleAsset(
  release,
  (asset) => /^OpenAI\.Codex_.+_x64__.+\.Msix$/i.test(asset.name),
  'Windows x64 MSIX'
);
const checksumsAsset = findSingleAsset(release, (asset) => asset.name === 'SHA256SUMS.txt', 'SHA256SUMS.txt');
const manifestAsset = findSingleAsset(release, (asset) => asset.name === 'release-manifest.json', 'release-manifest.json');

const [checksums, manifestText] = await Promise.all([
  fetchText(checksumsAsset.browser_download_url),
  fetchText(manifestAsset.browser_download_url)
]);
const checksum = expectedChecksum(checksums, msixAsset.name);
const versions = validateManifest(JSON.parse(manifestText), release, msixAsset, checksum);

console.log(`${releaseTag ? 'Selected' : 'Latest'} Codex: ${versions.appVersion}`);
console.log(`Backend: ${versions.backendVersion}`);
console.log(`Windows package: ${versions.packageVersion}`);
console.log(`Asset: ${msixAsset.name}`);
console.log(`Size: ${msixAsset.size} bytes`);
console.log(`SHA-256: ${checksum}`);
console.log(`Output directory: ${outputDirectory}`);

if (dryRun) {
  console.log('Dry run complete; no files were written.');
  process.exit(0);
}

await writeVerifiedMetadata(checksumsAsset, checksums);
await writeVerifiedMetadata(manifestAsset, manifestText);
const msixPath = await downloadMsix(msixAsset, checksum);
console.log(`Downloaded and verified: ${msixPath}`);
