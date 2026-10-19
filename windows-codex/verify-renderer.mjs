#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Pass the startup artifact directory.');
const targets = JSON.parse(await readFile(join(directory, 'cdp-targets.json'), 'utf8'));
const target = [targets].flat().find((item) => item.type === 'page'
  && item.url !== 'about:blank' && !item.url.startsWith('devtools:'));
assert.ok(target?.webSocketDebuggerUrl, 'A nonblank renderer page must expose a CDP endpoint.');

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let sequence = 0;
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data));
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});

function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP request timed out: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed.')); }, { once: true });
  });
  const evaluated = await call('Runtime.evaluate', {
    expression: '({readyState:document.readyState,title:document.title,bodyText:document.body?.innerText?.slice(0,4000)??"",elementCount:document.body?.querySelectorAll("*").length??0})',
    returnByValue: true
  });
  const page = evaluated.result?.value;
  await writeFile(join(directory, 'renderer-state.json'), `${JSON.stringify(page, null, 2)}\n`);
  assert.equal(page?.readyState, 'complete', 'Renderer document must finish loading.');
  assert.ok(page.elementCount > 0 && page.bodyText.trim().length > 0, 'Renderer must contain visible application content.');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(directory, 'renderer.png'), Buffer.from(screenshot.data, 'base64'));
  console.log(JSON.stringify(page, null, 2));
} finally {
  socket.close();
  for (const request of pending.values()) clearTimeout(request.timer);
}
