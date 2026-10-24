'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyBackport, isApplied, SITES } = require('./patch-wwebjs-browser-connected.js');

const [DESTROY, LOGOUT] = SITES;

// The real shape around both lines: destroy() closes the browser behind the check, logout() polls it.
const BEFORE =
  `    async destroy() {\n        const browser = this.pupBrowser;\n${DESTROY.find}` +
  `        if (isConnected) {\n            await browser.close();\n        }\n` +
  `        await this.authStrategy.destroy();\n    }\n\n` +
  `    async logout() {\n        await this.pupBrowser.close();\n\n        let maxDelay = 0;\n${LOGOUT.find}` +
  `            await new Promise((resolve) => setTimeout(resolve, 100));\n            maxDelay++;\n        }\n`;
const AFTER = BEFORE.replace(DESTROY.find, DESTROY.replace).replace(LOGOUT.find, LOGOUT.replace);

function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-browser-connected-'));
  const client = path.join(root, 'src', 'Client.js');
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(client, source);
  return { root, client };
}

test('the fixture differs from its patched form at both sites', () => {
  // Guard the guard: a fixture that never contained the upstream lines would make the tests vacuous.
  assert.notEqual(BEFORE, AFTER);
  assert.ok(AFTER.includes('browser?.connected;'));
  assert.ok(AFTER.includes('this.pupBrowser.connected &&'));
  // The local `isConnected` variable in destroy() stays; only the removed METHOD calls go.
  assert.ok(!AFTER.includes('.isConnected?.()'));
  assert.ok(!AFTER.includes('.isConnected()'));
});

test('rewrites both isConnected() calls to the connected getter', () => {
  const { root, client } = makeDependency(`head\n${BEFORE}tail\n`);

  const result = applyBackport(root);

  assert.deepEqual(result, {
    skipped: false,
    note: 'destroy() and logout() now read Browser.connected (Puppeteer 25)',
  });
  assert.equal(fs.readFileSync(client, 'utf8'), `head\n${AFTER}tail\n`);
});

test('is idempotent once both sites read the getter', () => {
  const { root, client } = makeDependency(`head\n${AFTER}tail\n`);
  const original = fs.readFileSync(client, 'utf8');

  assert.deepEqual(applyBackport(root), {
    skipped: true,
    reason: 'installed whatsapp-web.js already reads Browser.connected in destroy() and logout()',
  });
  assert.equal(fs.readFileSync(client, 'utf8'), original);
});

test('reports the patch as applied only once the transform has run', () => {
  const { root } = makeDependency(`head\n${BEFORE}tail\n`);

  assert.equal(isApplied(root), false);
  applyBackport(root);
  assert.equal(isApplied(root), true);
});

test('rejects an unknown dependency shape without changing it', () => {
  const { root, client } = makeDependency('class Client {}\n');
  const original = fs.readFileSync(client, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), original);
});

test('rejects an ambiguous dependency shape without changing it', () => {
  const { root, client } = makeDependency(`${BEFORE}${BEFORE}`);
  const original = fs.readFileSync(client, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), original);
});

// A tree where only one of the two sites was rewritten is neither pristine nor patched. It must
// fail the build rather than be waved through as either, and the startup guard must not call it
// applied.
test('rejects a half-patched tree without changing it, and does not report it applied', () => {
  const half = BEFORE.replace(DESTROY.find, DESTROY.replace);
  const { root, client } = makeDependency(half);
  const original = fs.readFileSync(client, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Client\.js shape \(destroy: 0 upstream, 1 patched; logout: 1 upstream, 0 patched\)/);
  assert.equal(fs.readFileSync(client, 'utf8'), original);
  assert.equal(isApplied(root), false);
});

test('fails loudly when Client.js is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-browser-connected-empty-'));

  assert.throws(() => applyBackport(root), /Client\.js not found/);
});
