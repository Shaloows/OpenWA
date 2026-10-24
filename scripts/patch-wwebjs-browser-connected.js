/**
 * Keep whatsapp-web.js's browser-connection checks working on Puppeteer 25.
 *
 * `Client.destroy()` and `Client.logout()` ask the browser whether it is still connected through
 * `Browser.isConnected()`. puppeteer-core 25.0.0 removed that method (deprecated since 22 in favour
 * of the `connected` getter: "remove deprecated Browser.isConnected()" in its 25.0.0 changelog).
 * whatsapp-web.js 1.34.7 pins Puppeteer 24.38.0 and still calls it; OpenWA overrides that pin to
 * 25.16.0 (package.json `overrides`) to clear the zod advisory carried by chromium-bidi, so the two
 * call sites drift apart in different ways:
 *
 *   - destroy(): `browser?.isConnected?.()`. Optional chaining turns the missing method into
 *     `undefined`, the `if` is skipped and `browser.close()` never runs. Nothing throws; the
 *     Chromium process simply outlives the session it belonged to.
 *   - logout(): `this.pupBrowser.isConnected()`. Throws `TypeError: ... is not a function` right
 *     after `browser.close()`, so logout rejects after the account was already signed out.
 *
 * Both become the `connected` getter, which puppeteer-core defines on every Browser since 22
 * (cdp/Browser.js: `!this.#connection._closed`) and which Puppeteer 24 already carried, so the
 * patched tree runs on either line.
 *
 * The source transform is exact and self-disabling, matching the sibling patchers: each line must
 * appear exactly once, the patch stands down once the installed tree already reads `.connected` at
 * both sites (whatsapp-web.js moving to Puppeteer 25 itself), and any other shape, a half-patched
 * tree included, fails the production image build instead of silently shipping without the fix.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

/** The two upstream lines, byte-exact, and what each becomes. */
const SITES = [
  {
    name: 'destroy',
    find: '        const isConnected = browser?.isConnected?.();\n',
    replace: '        const isConnected = browser?.connected;\n',
  },
  {
    name: 'logout',
    find: '        while (this.pupBrowser.isConnected() && maxDelay < 10) {\n',
    replace: '        while (this.pupBrowser.connected && maxDelay < 10) {\n',
  },
];

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** Per-site counts of the upstream line and of the patched line. */
function survey(source) {
  return SITES.map(site => ({
    name: site.name,
    finds: occurrences(source, site.find),
    fixes: occurrences(source, site.replace),
  }));
}

function applyBackport(wwjsDir = DEFAULT_WWJS) {
  const clientFile = path.join(wwjsDir, CLIENT_PATH);
  if (!fs.existsSync(clientFile)) {
    throw new Error(`whatsapp-web.js Client.js not found at ${clientFile}`);
  }

  const source = fs.readFileSync(clientFile, 'utf8');
  const counts = survey(source);

  if (counts.every(c => c.finds === 0 && c.fixes === 1)) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already reads Browser.connected in destroy() and logout()',
    };
  }
  if (!counts.every(c => c.finds === 1 && c.fixes === 0)) {
    const shape = counts.map(c => `${c.name}: ${c.finds} upstream, ${c.fixes} patched`).join('; ');
    throw new Error(
      `unsupported Client.js shape (${shape}); ` +
        're-evaluate the Browser.connected backport against the installed whatsapp-web.js',
    );
  }

  let patched = source;
  for (const site of SITES) {
    patched = patched.replace(site.find, site.replace);
  }
  fs.writeFileSync(clientFile, patched);
  return { skipped: false, note: 'destroy() and logout() now read Browser.connected (Puppeteer 25)' };
}

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const source = fs.readFileSync(path.join(wwjsDir, CLIENT_PATH), 'utf8');
    return survey(source).every(c => c.finds === 0 && c.fixes === 1);
  } catch {
    return true;
  }
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyBackport();
    console.log(
      `patch-wwebjs-browser-connected: ${result.skipped ? `skipped: ${result.reason}` : result.note}`,
    );
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-browser-connected: skipped: ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-browser-connected: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyBackport, isApplied, SITES };
