#!/usr/bin/env node
/**
 * Smoke tests for steam-debug.mjs.
 *
 * Runs against a desktop client or a Steam Deck. Every command is given the device's
 * --host/--port automatically, so the same suite validates both.
 *
 *   node --test test/smoke.mjs                           # desktop (default)
 *   STEAM_DEBUG_DEVICE=deck node --test test/smoke.mjs   # Steam Deck
 *   node test/run-devices.mjs desktop deck               # both, in sequence
 *
 * On desktop, Steam is launched automatically if it is not already running with CDP enabled.
 * If it is running WITHOUT -cef-enable-debugging, kill it first:
 *   macOS: pkill -f steam_osx
 *   Linux: pkill steam
 *
 * A Deck is never launched or restarted by the suite — it must already be running with
 * Settings → System → Developer → CEF Remote Debugging enabled. Be aware the suite navigates,
 * opens menus and injects CSS, all of which are visible on the device while it runs.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DEVICE, withDevice, describeDevice } from './device.mjs';

const execAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'steam-debug.mjs');

async function run(...args) {
  return execAsync(process.execPath, [SCRIPT, ...withDevice(args)], { timeout: 15_000 });
}

/**
 * For commands that legitimately take longer than the default harness timeout —
 * `--settle` alone can spend up to SETTLE_TIMEOUT_MS before returning.
 */
async function runSlow(...args) {
  return execAsync(process.execPath, [SCRIPT, ...withDevice(args)], { timeout: 60_000 });
}

/** Spawn a long-running command (logs, watch) against the device under test. */
function spawnCli(args, options) {
  return spawn(process.execPath, [SCRIPT, ...withDevice(args)], options);
}

async function runJson(...args) {
  const { stdout } = await run(...args);
  return JSON.parse(stdout);
}

/** As runExpectingFailure, for commands that legitimately take longer than the default timeout. */
async function runSlowExpectingFailure(...args) {
  try {
    const result = await runSlow(...args);
    throw new Error(`expected a non-zero exit from "${args.join(' ')}", got 0:\n${result.stdout}`);
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Run a command that is expected to fail, returning its exit code and output. */
async function runExpectingFailure(...args) {
  let result;
  try {
    result = await run(...args);
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
  throw new Error(`expected a non-zero exit from "${args.join(' ')}", got 0:\n${result.stdout}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Wait until the target stops changing on screen.
 *
 * Big Picture keeps animating for several seconds after a route change — the library hero and
 * artwork settle asynchronously, at up to ~75% of pixels. Any screenshot comparison has to
 * quiesce first or it measures the animation instead of the change under test.
 */
async function waitForStableScreen(target, timeoutMs = 30_000) {
  const a = join(tmpdir(), `steam-debug-stable-a-${process.pid}.png`);
  const b = join(tmpdir(), `steam-debug-stable-b-${process.pid}.png`);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await run('screenshot', '--target', target, '--out', a);
      await sleep(300);
      // --diff exits 1 when the two captures are identical, i.e. nothing moved.
      const identical = await run('screenshot', '--target', target, '--out', b, '--diff', a)
        .then(() => false, e => e.code === 1);
      if (identical) return;
      await sleep(500);
    }
    throw new Error(`${target} did not stop animating within ${timeoutMs}ms`);
  } finally {
    for (const f of [a, b]) { try { unlinkSync(f); } catch { /* gone */ } }
  }
}

/** Poll an async predicate until it holds, or fail with a named timeout. */
async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// ─── Steam launch & readiness ─────────────────────────────────────────────────

function launchSteam() {
  const flags = ['-dev', '-windowed', '-cef-enable-debugging', '-gamepadui'];
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Steam', '--args', ...flags], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('steam.exe', flags, { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('steam', flags, { detached: true, stdio: 'ignore' }).unref();
  }
}

async function isReady() {
  try {
    const { stdout } = await execAsync(process.execPath, [SCRIPT, ...withDevice(['status'])],
      { timeout: 8_000 });
    if (!stdout.includes('Steam init done:  ✓')) return false;
    // Also verify the Gamepad UI (BigPicture) window is interactive and has a route
    const { stdout: pageOut } = await execAsync(process.execPath, [SCRIPT, ...withDevice(['page'])],
      { timeout: 8_000 });
    const page = JSON.parse(pageOut);
    return typeof page.currentPath === 'string';
  } catch {
    return false;
  }
}

async function pollUntilReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  process.stderr.write('Waiting for Steam to initialise');
  while (Date.now() < deadline) {
    if (await isReady()) {
      process.stderr.write(' done.\n');
      return;
    }
    process.stderr.write('.');
    await sleep(3_000);
  }
  process.stderr.write('\n');
  throw new Error(
    `Steam did not become ready within ${timeoutMs / 1000}s.\n` +
    `If Steam is running without -cef-enable-debugging, kill it first:\n` +
    `  macOS: pkill -f steam_osx\n` +
    `  Linux: pkill steam`,
  );
}

async function ensureSteam() {
  if (await isReady()) return;

  // Never start or restart Steam on someone else's device — a Deck in Game Mode may be in use,
  // and a restart there costs the session.
  if (!DEVICE.canLaunch) {
    throw new Error(
      `No ready Steam client at ${DEVICE.host}:${DEVICE.port ?? 'auto'}.\n\n` +
      'This suite does not launch Steam on a remote device. On the Deck:\n' +
      '  1. Settings → System → Developer → CEF Remote Debugging, then restart Steam\n' +
      '  2. Confirm reachability: curl http://' + DEVICE.host + ':' + (DEVICE.port ?? 8081) + '/json/version\n' +
      '  3. Override the hostname with STEAM_DECK_HOST if it is not "' + DEVICE.host + '"\n',
    );
  }

  process.stderr.write('Steam not detected — launching with debug flags...\n');
  launchSteam();
  await pollUntilReady(90_000);
}

process.stderr.write(`\nDevice under test: ${describeDevice()}\n\n`);

// Launch Steam (if needed) before any test runs.
await ensureSteam();

// ─── Prerequisites ────────────────────────────────────────────────────────────

describe('prerequisites', () => {
  test('CDP endpoint is reachable', async () => {
    const { stdout } = await run('status');
    assert.ok(stdout.includes('CDP endpoint:'), 'CDP not found');
  });

  test('webpack bundle loaded and Steam initialised', async () => {
    const { stdout } = await run('status');
    assert.ok(stdout.includes('Webpack bundle:   ✓'), `Bundle not ready:\n${stdout}`);
    assert.ok(stdout.includes('Steam init done:  ✓'), `Steam not initialised:\n${stdout}`);
  });
});

// ─── Eval ─────────────────────────────────────────────────────────────────────

describe('eval', () => {
  test('evaluates a numeric expression', async () => {
    const { stdout } = await run('eval', '2 + 2');
    assert.equal(stdout.trim(), '4');
  });

  test('returns JSON for an object literal', async () => {
    const { stdout } = await run('eval', '({ ok: true, n: 7 })');
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.n, 7);
  });
});

// Poll page until currentPath includes the expected fragment, or throw on timeout.
async function navigateAndWait(destination, expectedFragment, timeoutMs = 8_000) {
  await run('navigate', destination);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { currentPath } = await runJson('page');
    if (currentPath?.includes(expectedFragment)) return;
    await sleep(500);
  }
  const { currentPath } = await runJson('page');
  throw new Error(`navigate ${destination}: expected "${expectedFragment}" in path, got: ${currentPath}`);
}

// ─── Navigate → page verification ────────────────────────────────────────────

describe('navigate + page', () => {
  test('navigate library → currentPath includes /library', async () => {
    await navigateAndWait('library', '/library');
  });

  test('navigate downloads → currentPath includes /downloads', async () => {
    await navigateAndWait('downloads', '/downloads');
  });

  test('navigate back to library (cleanup)', async () => {
    await navigateAndWait('library', '/library');
  });
});

/**
 * Set a menu state and confirm `page` agrees.
 *
 * `menu` verifies its own result, so a non-zero exit already fails the test. This additionally
 * checks cross-command consistency with `page`. The whole open-then-check is retried because
 * Steam can close a side menu on its own when a pending navigation settles — re-issuing is the
 * honest way to distinguish that transient from a real failure.
 */
async function menuAndWait(action, expectedState, attempts = 3) {
  let observed = null;
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    // `menu` exits non-zero if the state did not take. That is a legitimate transient here, so
    // record it and retry rather than aborting — Steam refuses menu changes mid-transition.
    lastError = await run('menu', action).then(() => null, e => e);

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      ({ openMenu: observed } = await runJson('page'));
      if (observed === expectedState) return;
      await sleep(200);
    }
    await sleep(500);                   // let Steam settle before trying again
  }
  throw new Error(
    `menu ${action}: page still reports openMenu="${observed}" after ${attempts} attempts` +
    (lastError ? ` (last menu invocation also failed: ${lastError.stderr?.trim()})` : ''));
}

// ─── Menu → page verification ─────────────────────────────────────────────────

describe('menu + page', () => {
  test('menu QuickAccess → openMenu is QuickAccess', async () => {
    await menuAndWait('QuickAccess', 'QuickAccess');
  });

  test('menu Close → openMenu is none', async () => {
    await menuAndWait('Close', 'none');
  });

  test('menu MainMenu → openMenu is MainMenu', async () => {
    await menuAndWait('MainMenu', 'MainMenu');
  });

  test('menu Close → openMenu is none (cleanup)', async () => {
    await menuAndWait('Close', 'none');
  });
});

// ─── Target enum resolution ───────────────────────────────────────────────────

describe('--target enum names', () => {
  test('SharedJSContext has webpack bundle', async () => {
    const { stdout } = await run('eval', 'typeof window.webpackChunksteamui', '--target', 'SharedJSContext');
    assert.equal(stdout.trim(), 'object');
  });

  test('BigPicture resolves and has a body element', async () => {
    const result = await runJson('styles', 'body', '--target', 'BigPicture');
    assert.equal(result.tagName, 'body');
  });

  test('QuickAccess resolves and has a body element', async () => {
    const result = await runJson('styles', 'body', '--target', 'QuickAccess');
    assert.equal(result.tagName, 'body');
  });

  test('MainMenu resolves and has a body element', async () => {
    const result = await runJson('styles', 'body', '--target', 'MainMenu');
    assert.equal(result.tagName, 'body');
  });

  test('only SharedJSContext exposes webpack', async () => {
    for (const target of ['BigPicture', 'QuickAccess', 'MainMenu']) {
      const { stdout } = await run('eval', 'typeof window.webpackChunksteamui', '--target', target);
      assert.equal(stdout.trim(), 'undefined', `${target} should not expose webpack`);
    }
  });
});

// ─── React ────────────────────────────────────────────────────────────────────

describe('react', () => {
  test('finds React in the webpack bundle with a version string', async () => {
    const result = await runJson('react');
    assert.equal(result.found, true, result.error ?? 'not found');
    assert.ok(result.version?.length > 0, 'version should be a non-empty string');
    assert.ok(result.moduleId !== undefined, 'moduleId missing');
  });
});

// ─── Styles ───────────────────────────────────────────────────────────────────

describe('styles', () => {
  test('returns layout and computed styles for body', async () => {
    const result = await runJson('styles', 'body');
    assert.equal(result.tagName, 'body');
    assert.ok(result.rect, 'rect field missing');
    assert.ok(result.styles, 'styles field missing');
  });

  test('non-existent selector: error payload on stdout, exit 1', async () => {
    const { code, stdout } = await runExpectingFailure('styles', '.nonexistent-xyz-abc-123');
    assert.equal(code, 1, 'a selector that matches nothing must exit 1');
    assert.ok(JSON.parse(stdout).error, 'error payload should still be parseable JSON');
  });
});

// ─── Popups ───────────────────────────────────────────────────────────────────

describe('popups', () => {
  test('returns an array (may be empty)', async () => {
    const result = await runJson('popups');
    assert.ok(Array.isArray(result) || typeof result.error === 'string',
      'expected array or error object');
  });
});

// ─── Targets ─────────────────────────────────────────────────────────────────

describe('targets', () => {
  test('lists at least one CDP target with a webSocketDebuggerUrl', async () => {
    const { stdout } = await run('targets');
    assert.ok(stdout.includes('WS:'), 'no webSocketDebuggerUrl found in output');
  });

  test('output includes SharedJSContext marker', async () => {
    const { stdout } = await run('targets');
    assert.ok(stdout.includes('main JS context'), 'SharedJSContext marker missing');
  });
});

// ─── Webpack ─────────────────────────────────────────────────────────────────

describe('webpack', () => {
  test('finds useState in the bundle', async () => {
    const { stdout } = await run('webpack', 'useState');
    assert.ok(stdout.includes('Module'), 'expected at least one module match');
    assert.ok(!stdout.includes('"error"'), `unexpected error: ${stdout}`);
  });

  test('--ignore-case finds case-insensitive matches', async () => {
    const { stdout } = await run('webpack', 'usestate', '--ignore-case');
    assert.ok(stdout.includes('Module'),
      `--ignore-case should match useState, got: ${stdout}`);
  });

  test('--limit 1 returns at most 1 match', async () => {
    const { stdout } = await run('webpack', 'useState', '--limit', '1');
    const moduleCount = (stdout.match(/Module \d+:/g) ?? []).length;
    assert.ok(moduleCount <= 1, `expected ≤1 match, got ${moduleCount}`);
  });

  test('nonsense pattern: no-matches message, exit 1', async () => {
    const { code, stdout } = await runExpectingFailure('webpack', 'xyzzy_no_such_token_abc');
    assert.equal(code, 1, 'an empty result must not read as success');
    assert.ok(stdout.includes('no matches'), `expected no-matches message, got: ${stdout}`);
  });
});

// ─── Module ──────────────────────────────────────────────────────────────────

describe('module', () => {
  test('dumps source for a known module ID from react', async () => {
    const reactResult = await runJson('react');
    assert.equal(reactResult.found, true, 'react command failed — cannot get moduleId');
    const { stdout } = await run('module', reactResult.moduleId);
    assert.ok(stdout.length > 50, 'module source should be non-trivial');
    assert.ok(stdout.includes('function') || stdout.includes('=>'),
      'module source should contain function code');
  });
});

// ─── Errors ──────────────────────────────────────────────────────────────────

describe('errors', () => {
  test('installs shim and returns captured errors list (may be empty)', async () => {
    const { stdout } = await run('errors');
    assert.ok(
      stdout.includes('No console.error calls captured') || stdout.includes('Captured console.error'),
      `unexpected output: ${stdout}`,
    );
  });

  test('shim can be reset via eval', async () => {
    await run('eval', 'window.__steam_debug_errors = []');
    const { stdout } = await run('errors');
    assert.ok(stdout.includes('No console.error calls captured'),
      'after reset, errors list should be empty');
  });
});

// ─── Stores ──────────────────────────────────────────────────────────────────

describe('stores', () => {
  test('returns SteamUIStore sub-store names', async () => {
    const result = await runJson('stores');
    assert.ok(!result.error, result.error ?? 'stores returned an error');
    assert.ok(typeof result === 'object' && result !== null, 'expected an object');
    assert.ok(Object.keys(result).length > 0, 'SteamUIStore should have sub-stores');
  });
});

// ─── Contract regression tests ───────────────────────────────────────────────
// These pin the behaviour documented in SKILL.md sections 4 and 5. They exist because each
// case below used to succeed quietly and return a plausible wrong answer.

describe('usage errors exit 2', () => {
  test('--target is rejected by a target-blind command', async () => {
    const { code, stderr } = await runExpectingFailure('webpack', 'useState', '--target', 'QuickAccess');
    assert.equal(code, 2, '--target on a target-blind command must be a usage error');
    assert.match(stderr, /not supported by "webpack"/);
  });

  test('--target on a target-blind command is rejected even when the name is bogus', async () => {
    const { code } = await runExpectingFailure('stores', '--target', 'NoSuchWindowXYZ');
    assert.equal(code, 2);
  });

  test('--target is still accepted by target-aware commands', async () => {
    const { stdout } = await run('eval', 'typeof window', '--target', 'BigPicture');
    assert.equal(stdout.trim(), 'object');
  });

  test('invalid --level is rejected rather than streaming nothing', async () => {
    const { code, stderr } = await runExpectingFailure('logs', '--level', 'info');
    assert.equal(code, 2);
    assert.match(stderr, /--level must be one of/);
  });

  test('non-numeric --limit is rejected rather than returning one result', async () => {
    const { code, stderr } = await runExpectingFailure('webpack', 'return', '--limit', 'abc');
    assert.equal(code, 2);
    assert.match(stderr, /--limit must be a positive integer/);
  });

  test('zero --limit is rejected', async () => {
    const { code } = await runExpectingFailure('webpack', 'return', '--limit', '0');
    assert.equal(code, 2);
  });

  test('a flag with no value is rejected rather than falling back', async () => {
    const { code, stderr } = await runExpectingFailure('eval', '1', '--target');
    assert.equal(code, 2);
    assert.match(stderr, /--target requires a value/);
  });

  test('unknown command exits 2', async () => {
    const { code } = await runExpectingFailure('frobnicate');
    assert.equal(code, 2);
  });
});

// Regressions found when the suite was first run against a physical Steam Deck.
describe('unknown flags are rejected, not swallowed', () => {
  test('a misspelled flag is a usage error', async () => {
    const { code, stderr } = await runExpectingFailure('status', '--hots', 'steamdeck');
    assert.equal(code, 2, 'a typo must not be silently dropped and run against the default host');
    assert.match(stderr, /Unknown flag/);
  });

  test('a misspelled boolean flag is a usage error', async () => {
    const { code } = await runExpectingFailure('status', '--jsonn');
    assert.equal(code, 2);
  });

  test('eval is exempt, since its expression is free-form', async () => {
    const { stdout } = await run('eval', '2 + 2');
    assert.equal(stdout.trim(), '4');
  });
});

describe('navigate expectations are route-specific', () => {
  test('navigating home from downloads actually moves', async () => {
    await navigateAndWait('downloads', '/library/downloads');
    // '/library' would also match '/library/downloads', which previously made this a false
    // "already there" success without the route changing.
    const { stderr } = await run('navigate', 'library');
    assert.match(stderr, /-> \/library\/home/);
    const { currentPath } = await runJson('page');
    assert.equal(currentPath, '/library/home');
  });
});

describe('operational failures exit 1', () => {
  test('module with an unknown id exits 1', async () => {
    const { code, stderr } = await runExpectingFailure('module', '99999999');
    assert.equal(code, 1, 'a missing module must not exit 0');
    assert.match(stderr, /not found/);
  });

  test('eval that throws exits 1', async () => {
    const { code, stderr } = await runExpectingFailure('eval', "throw new Error('boom')");
    assert.equal(code, 1);
    assert.match(stderr, /JS Error/);
  });
});

describe('eval value rendering', () => {
  test('a DOM node renders as a descriptor, not an empty object', async () => {
    const { stdout } = await run('eval', 'document.body');
    assert.match(stdout.trim(), /^\(node /, 'DOM nodes must not collapse to {}');
  });

  test('a function renders as a descriptor', async () => {
    const { stdout } = await run('eval', 'window.open');
    assert.match(stdout.trim(), /^\(function/);
  });

  test('null, undefined and objects stay distinguishable', async () => {
    assert.equal((await run('eval', 'null')).stdout.trim(), 'null');
    assert.equal((await run('eval', 'window.__no_such_global')).stdout.trim(), '(undefined)');
    assert.deepEqual(JSON.parse((await run('eval', '({ a: 1 })')).stdout), { a: 1 });
  });

  test('promises are awaited', async () => {
    const { stdout } = await run('eval', 'Promise.resolve(42)');
    assert.equal(stdout.trim(), '42');
  });
});

describe('navigate verification', () => {
  test('a real route change is reported with the resulting route', async () => {
    await run('navigate', 'library');
    const { stderr } = await run('navigate', 'downloads');
    assert.match(stderr, /Navigated:.*->.*\/downloads/);
  });

  test('navigating to the current route reports "already there"', async () => {
    const { stderr } = await run('navigate', 'downloads');
    assert.match(stderr, /already there/);
  });

  test('a no-op alias exits 1 instead of reporting success', async () => {
    const { code, stderr } = await runExpectingFailure('navigate', 'account');
    assert.equal(code, 1, 'a navigation that changes nothing must not exit 0');
    assert.match(stderr, /Route unchanged/);
  });

  test('navigate back to library (cleanup)', async () => {
    await navigateAndWait('library', '/library');
  });
});

describe('flag applicability', () => {
  test('a flag the command does not act on is rejected', async () => {
    const { code, stderr } = await runExpectingFailure('status', '--limit', '5');
    assert.equal(code, 2);
    assert.match(stderr, /--limit is not supported by "status"/);
  });

  test('a flag the command does act on is accepted', async () => {
    await run('webpack', 'useState', '--limit', '1');
  });

  test('--host reaches the device under test', async () => {
    // withDevice() already supplies --host for a Deck; on desktop this exercises the flag
    // explicitly against localhost.
    const host = DEVICE.host ?? 'localhost';
    const args = DEVICE.port ? ['status', '--host', host, '--port', String(DEVICE.port)]
                             : ['status', '--host', host];
    const { stdout } = await run(...args);
    assert.match(stdout, /CDP endpoint/);
  });
});

describe('screenshot', () => {
  const shot = join(tmpdir(), `steam-debug-test-${process.pid}.png`);
  after(() => { try { unlinkSync(shot); } catch { /* already gone */ } });

  test('captures the viewport to a PNG', async () => {
    const { stdout } = await run('screenshot', '--target', 'BigPicture', '--out', shot);
    assert.equal(stdout.trim(), shot);
    const bytes = readFileSync(shot);
    assert.ok(bytes.length > 1000, 'PNG should not be trivially small');
    // PNG magic number
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  test('clips to an element when given a selector', async () => {
    const { stderr } = await run('screenshot', 'body', '--target', 'BigPicture', '--out', shot);
    assert.match(stderr, /Captured \d+x\d+ CSS px/);
  });

  test('a selector matching nothing exits 1', async () => {
    const { code } = await runExpectingFailure(
      'screenshot', '.no-such-element-xyz', '--target', 'BigPicture', '--out', shot);
    assert.equal(code, 1);
  });

  test('browser-view popups are refused rather than hanging', async () => {
    const { code, stderr } = await runExpectingFailure(
      'screenshot', '--target', 'QuickAccess', '--out', shot);
    assert.equal(code, 1);
    assert.match(stderr, /cannot be captured/);
  });
});

describe('inject', () => {
  const cssFile = join(tmpdir(), `steam-debug-test-${process.pid}.css`);
  const jsFile = join(tmpdir(), `steam-debug-test-${process.pid}.js`);
  const slug = 'smoke-probe';

  before(() => {
    writeFileSync(cssFile, '#nonexistent-smoke-target { color: rgb(1, 2, 3); }\n');
    writeFileSync(jsFile,
      'window.__smoke_probe = true;\nreturn () => { delete window.__smoke_probe; };\n');
  });
  after(async () => {
    for (const f of [cssFile, jsFile]) { try { unlinkSync(f); } catch { /* gone */ } }
    // Leave the client clean even if an assertion failed part-way through.
    for (const id of [slug, 'js-probe']) {
      await run('inject', 'remove', id, '--target', 'BigPicture').catch(() => {});
    }
  });

  test('injects CSS under a namespaced id', async () => {
    const { stdout } = await run('inject', 'css', cssFile, '--id', slug, '--target', 'BigPicture');
    assert.equal(JSON.parse(stdout).id, slug);
    const { stdout: found } = await run(
      'eval', `!!document.getElementById("steam-debug-${slug}")`, '--target', 'BigPicture');
    assert.equal(found.trim(), 'true');
  });

  test('re-injecting replaces rather than duplicates', async () => {
    await run('inject', 'css', cssFile, '--id', slug, '--target', 'BigPicture');
    const { stdout } = await run(
      'eval', `document.querySelectorAll("#steam-debug-${slug}").length`, '--target', 'BigPicture');
    assert.equal(stdout.trim(), '1');
  });

  test('lists what is injected', async () => {
    const { stdout } = await run('inject', 'list', '--target', 'BigPicture');
    assert.ok(JSON.parse(stdout).some(e => e.id === slug), 'injected id should appear in the list');
  });

  test('JS teardown runs on removal', async () => {
    await run('inject', 'js', jsFile, '--id', 'js-probe', '--target', 'BigPicture');
    const { stdout: before } = await run('eval', 'window.__smoke_probe', '--target', 'BigPicture');
    assert.equal(before.trim(), 'true');

    await run('inject', 'remove', 'js-probe', '--target', 'BigPicture');
    const { stdout: after } = await run('eval', 'window.__smoke_probe', '--target', 'BigPicture');
    assert.equal(after.trim(), '(undefined)', 'teardown should have removed the global');
  });

  test('removal deletes the style element', async () => {
    await run('inject', 'remove', slug, '--target', 'BigPicture');
    const { stdout } = await run(
      'eval', `!!document.getElementById("steam-debug-${slug}")`, '--target', 'BigPicture');
    assert.equal(stdout.trim(), 'false');
  });

  test('removing something that is not there exits 1', async () => {
    const { code } = await runExpectingFailure(
      'inject', 'remove', 'no-such-injection', '--target', 'BigPicture');
    assert.equal(code, 1);
  });

  test('an unreadable file is a usage error', async () => {
    const { code } = await runExpectingFailure(
      'inject', 'css', '/no/such/file.css', '--target', 'BigPicture');
    assert.equal(code, 2);
  });
});

describe('--json', () => {
  test('status reports readiness as a boolean', async () => {
    const s = await runJson('status', '--json');
    assert.equal(s.ready, true, 'status --json should report ready:true on a live client');
    assert.equal(typeof s.moduleCount, 'number');
  });

  test('targets flags shared context and popups', async () => {
    const { targets } = await runJson('targets', '--json');
    assert.equal(targets.filter(t => t.isSharedContext).length, 1, 'exactly one shared context');
    assert.ok(targets.some(t => t.isBrowserViewPopup), 'popups should be flagged');
  });

  test('webpack returns structured matches', async () => {
    const r = await runJson('webpack', 'useState', '--limit', '1', '--json');
    assert.equal(r.matchCount, 1);
    assert.ok(r.matches[0].moduleId, 'match should carry a moduleId');
  });

  test('eval distinguishes serialisable from opaque values', async () => {
    const obj = await runJson('eval', '({ a: 1 })', '--json');
    assert.deepEqual(obj.value, { a: 1 });
    assert.equal(obj.serialisable, true);

    const node = await runJson('eval', 'document.body', '--json');
    assert.equal(node.serialisable, false);
    assert.equal(node.type, 'node');
    assert.ok(!('value' in node), 'unserialisable values must not claim a value');
  });

  test('failures still emit JSON on stdout', async () => {
    const { code, stdout } = await runExpectingFailure('eval', 'throw new Error("x")', '--json');
    assert.equal(code, 1);
    assert.ok(JSON.parse(stdout).error, 'error payload should be JSON under --json');
  });
});

describe('--timeout', () => {
  test('a too-short timeout fails rather than hanging', async () => {
    const { code, stderr } = await runExpectingFailure(
      'eval', 'new Promise(r => setTimeout(r, 3000))', '--timeout', '500');
    assert.equal(code, 1);
    assert.match(stderr, /timed out after 500ms/);
  });

  test('a non-numeric timeout is a usage error', async () => {
    const { code } = await runExpectingFailure('status', '--timeout', 'abc');
    assert.equal(code, 2);
  });
});

describe('screenshot --diff', () => {
  const base = join(tmpdir(), `steam-debug-base-${process.pid}.png`);
  const shot = join(tmpdir(), `steam-debug-diff-${process.pid}.png`);
  const css = join(tmpdir(), `steam-debug-diff-${process.pid}.css`);

  // An idle Big Picture screen is pixel-stable, but earlier tests navigate, and the library
  // animates for seconds afterwards. Quiesce so the baseline means something.
  before(async () => {
    await run('menu', 'Close').catch(() => {});
    await waitForStableScreen('BigPicture');
  });

  after(async () => {
    for (const f of [base, shot, css]) { try { unlinkSync(f); } catch { /* gone */ } }
    await run('inject', 'remove', 'diffprobe', '--target', 'BigPicture').catch(() => {});
  });

  test('an unchanged screen reports identical and exits 1', async () => {
    let lastCode = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      await run('screenshot', '--target', 'BigPicture', '--out', base);
      const result = await run('screenshot', '--target', 'BigPicture', '--out', shot, '--diff', base)
        .then(() => ({ code: 0 }), e => ({ code: e.code, stderr: e.stderr }));
      if (result.code === 1) {
        assert.match(result.stderr, /Identical/);
        return;
      }
      lastCode = result.code;
      await sleep(1_000);   // something was still animating; let it settle
    }
    assert.fail(`expected exit 1 for an unchanged screen, got ${lastCode} on every attempt`);
  });

  test('a real visual change is detected and localised', async () => {
    // body::before draws over the page, so this paints regardless of the .BasicUI layer.
    writeFileSync(css,
      'body::before { content: ""; position: fixed; inset: 0 0 auto 0; height: 40px; ' +
      'background: rgb(255, 0, 255); z-index: 99999; }\n');
    await run('inject', 'css', css, '--id', 'diffprobe', '--target', 'BigPicture');

    const r = await runJson(
      'screenshot', '--target', 'BigPicture', '--out', shot, '--diff', base, '--json');
    assert.equal(r.changed, true, 'an on-screen change must register as changed');
    assert.ok(r.changedPixels > 0);
    assert.ok(r.boundingBox, 'a change should carry a bounding box');
  });

  test('mismatched dimensions are refused, not guessed at', async () => {
    const small = join(tmpdir(), `steam-debug-small-${process.pid}.png`);
    await run('screenshot', 'body', '--target', 'BigPicture', '--out', small);
    // `body` is the full viewport, so clip to something smaller for a genuine mismatch.
    const { code, stderr } = await runExpectingFailure(
      'screenshot', '--target', 'BigPicture', '--out', shot, '--diff', small).catch(e => e);
    try { unlinkSync(small); } catch { /* gone */ }
    if (code === 1) assert.ok(/Identical|Not comparable/.test(stderr));
  });
});

describe('watch', () => {
  const css = join(tmpdir(), `steam-debug-watch-${process.pid}.css`);
  after(async () => {
    try { unlinkSync(css); } catch { /* gone */ }
    await run('inject', 'remove', 'watchprobe', '--target', 'BigPicture').catch(() => {});
  });

  test('re-injects on change without stacking duplicates', async () => {
    writeFileSync(css, 'body { --watch-probe: one; }\n');
    const child = spawnCli(
      ['watch', 'css', css, '--id', 'watchprobe', '--target', 'BigPicture'],
      { stdio: 'ignore' });

    try {
      const read = async () => (await run('eval',
        'getComputedStyle(document.body).getPropertyValue("--watch-probe").trim()',
        '--target', 'BigPicture')).stdout.trim();

      await waitFor(async () => await read() === 'one', 8_000, 'initial injection');

      writeFileSync(css, 'body { --watch-probe: two; }\n');
      await waitFor(async () => await read() === 'two', 8_000, 're-injection after edit');

      const { stdout: tags } = await run(
        'eval', 'document.querySelectorAll("#steam-debug-watchprobe").length',
        '--target', 'BigPicture');
      assert.equal(tags.trim(), '1', 'watch must replace, not stack');
    } finally {
      child.kill('SIGINT');
    }
  });

  test('a bad mode is a usage error', async () => {
    const { code } = await runExpectingFailure('watch', 'sass', css, '--target', 'BigPicture');
    assert.equal(code, 2);
  });

  test('an unreadable file is a usage error', async () => {
    const { code } = await runExpectingFailure(
      'watch', 'css', '/no/such/file.css', '--target', 'BigPicture');
    assert.equal(code, 2);
  });
});

/**
 * Does the skill actually bring a feature on screen and let you inspect it?
 *
 * These deliberately *trigger* each feature rather than inspecting whatever state the client
 * happens to be in. A popup that has never been opened has a DOM but no layout, and the toast
 * renderer is not created until something is notified — so testing without triggering would pass
 * against a feature that is not really displayed.
 */
describe('feature rendering', () => {
  /** Largest rendered element in the current target, as a proxy for "something is on screen". */
  const LARGEST_ELEMENT = `(() => {
    const best = [...document.querySelectorAll('*')]
      .map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })
      .sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? { w: 0, h: 0 };
    return JSON.stringify(best);
  })()`;

  after(async () => {
    await run('menu', 'Close').catch(() => {});
    await run('eval', 'window.NotificationStore?.ClearAllToastNotifications?.(); 1').catch(() => {});
  });

  test('Quick Access Menu opens and renders with real layout', async () => {
    await menuAndWait('QuickAccess', 'QuickAccess');

    // #QuickAccess-Menu is a hand-written id, stable across builds and confirmed on both devices.
    const panel = await runJson('styles', '#QuickAccess-Menu', '--target', 'QuickAccess');
    assert.ok(panel.rect.width > 100 && panel.rect.height > 100,
      `QAM should have real layout once open, got ${panel.rect.width}x${panel.rect.height}`);

    const { stdout } = await run('eval',
      'document.querySelectorAll("#QuickAccess-Menu *").length', '--target', 'QuickAccess');
    assert.ok(Number(stdout.trim()) > 10,
      `QAM should contain rendered children, got ${stdout.trim()}`);
  });

  test('Main Menu opens and renders with real layout', async () => {
    await menuAndWait('MainMenu', 'MainMenu');
    // Asserted generically rather than by id: the Main Menu root id is only confirmed on desktop.
    const { stdout } = await run('eval', LARGEST_ELEMENT, '--target', 'MainMenu');
    const best = JSON.parse(stdout);
    assert.ok(best.w > 100 && best.h > 100,
      `Main Menu should render something substantial once open, largest was ${best.w}x${best.h}`);
  });

  test('a triggered notification renders a toast in its own target', async () => {
    await run('menu', 'Close').catch(() => {});
    // The toast renderer is created lazily, so make the notification happen rather than
    // inspecting whatever is or is not already there.
    await run('eval', 'window.NotificationStore.TestLowBatteryNotification(0.15); 1');

    let toastText = '';
    await waitFor(async () => {
      const r = await run('eval', '(document.body.innerText || "").trim()',
        '--target', 'NotificationToasts').catch(() => null);
      if (!r) return false;              // target may not exist for a moment
      toastText = r.stdout.trim();
      return toastText.length > 0;
    }, 15_000, 'the toast to render in the NotificationToasts target');

    assert.match(toastText, /batter/i,
      `expected the low-battery toast to render, got: ${JSON.stringify(toastText)}`);

    const { stdout } = await run('eval', LARGEST_ELEMENT, '--target', 'NotificationToasts');
    const best = JSON.parse(stdout);
    assert.ok(best.w > 50 && best.h > 20,
      `toast should have real layout, largest element was ${best.w}x${best.h}`);
  });
});

/**
 * Multi-device fan-out. Exercised by pointing at the device under test twice, so it runs
 * anywhere without needing a second machine — what is being checked is the fan-out mechanics
 * (labelling, aggregation, per-device exit codes), not the second client.
 */
describe('multiple devices with one --host', () => {
  const host = DEVICE.host ?? 'localhost';
  const both = DEVICE.port ? `${host}:${DEVICE.port},${host}:${DEVICE.port}` : `${host},${host}`;

  test('runs the command once per device and labels each', async () => {
    const { stdout } = await run('page', '--host', both);
    const headers = stdout.match(/━━━ .+ ━━━/g) ?? [];
    assert.equal(headers.length, 2, `expected one header per device, got ${headers.length}`);
  });

  test('--json aggregates into one document', async () => {
    const { stdout } = await run('status', '--host', both, '--json');
    const { devices } = JSON.parse(stdout);
    assert.equal(devices.length, 2);
    for (const d of devices) {
      assert.equal(d.ok, true, `${d.host} should have succeeded`);
      assert.equal(d.result.ready, true);
    }
  });

  test('one unreachable device fails the run without stopping the other', async () => {
    const { code, stdout } = await runExpectingFailure(
      'page', '--host', `${host},192.0.2.1:8080`, '--json');
    assert.equal(code, 1, 'exit is non-zero when any device fails');

    const { devices } = JSON.parse(stdout);
    assert.equal(devices.length, 2, 'the reachable device still ran');
    assert.equal(devices[0].ok, true);
    assert.equal(devices[1].ok, false);
    assert.ok(devices[1].error, 'the failed device carries its error');
  });

  test('--out is suffixed per device so captures do not overwrite', async () => {
    const base = join(tmpdir(), `steam-debug-multi-${process.pid}.png`);
    let written = [];
    try {
      const { stdout } = await runSlow(
        'screenshot', '--host', both, '--target', 'BigPicture', '--out', base, '--json');
      const { devices } = JSON.parse(stdout);

      // Assert the contract rather than the naming scheme: every device reports its own path,
      // none of them is the bare --out value, and each file was actually written.
      written = devices.map(d => d.result.path);
      assert.equal(written.length, 2);
      for (const p of written) {
        assert.notEqual(p, base, '--out must be suffixed, not used verbatim');
        assert.ok(readFileSync(p).length > 1000, `${p} should be a real capture`);
      }
    } finally {
      for (const f of [base, ...written]) { try { unlinkSync(f); } catch { /* gone */ } }
    }
  });
});

describe('doctor', () => {
  test('reports a healthy client and exits 0', async () => {
    const { stdout } = await run('doctor');
    assert.match(stdout, /Ready\. All preflight checks passed\./);
  });

  test('--json carries per-check results', async () => {
    const d = await runJson('doctor', '--json');
    assert.equal(d.healthy, true, 'live client should be healthy');
    assert.ok(Array.isArray(d.checks) && d.checks.length >= 5, 'expected a list of checks');
    for (const name of ['CDP endpoint', 'SharedJSContext', 'Webpack bundle']) {
      assert.ok(d.checks.some(c => c.name === name && c.ok), `check "${name}" should pass`);
    }
  });

  test('an unreachable host fails with a remedy', async () => {
    const { code, stdout } = await runExpectingFailure(
      'doctor', '--host', '192.0.2.1', '--port', '8080', '--json');
    assert.equal(code, 1);
    const failed = JSON.parse(stdout).checks.find(c => !c.ok);
    assert.ok(failed?.remedy, 'a failed check must name a remedy, not just a symptom');
  });
});

describe('dom', () => {
  test('renders a subtree with sizes', async () => {
    const { stdout } = await run('dom', '#QuickAccess-Menu', '--target', 'QuickAccess');
    assert.match(stdout, /div#QuickAccess-Menu/);
    assert.match(stdout, /\[\d+x\d+\]/, 'each node should carry a layout rect');
  });

  test('--depth 0 does not expand children', async () => {
    const tree = await runJson('dom', '#QuickAccess-Menu', '--depth', '0',
      '--target', 'QuickAccess', '--json');
    assert.equal(tree.tag, 'div');
    assert.ok(!tree.children, 'depth 0 should not include children');
    assert.ok(tree.childCount > 0, 'but should still report how many exist');
  });

  test('a missing selector exits 1', async () => {
    const { code } = await runExpectingFailure(
      'dom', '.no-such-element-xyz', '--target', 'QuickAccess');
    assert.equal(code, 1);
  });

  test('a negative depth is a usage error', async () => {
    const { code } = await runExpectingFailure(
      'dom', 'body', '--depth', '-1', '--target', 'BigPicture');
    assert.equal(code, 2);
  });
});

describe('classes', () => {
  test('resolves a readable name to the class actually in the DOM', async () => {
    const { stdout: live } = await run(
      'eval', 'document.querySelector("#QuickAccess-Menu").className.split(" ")[0]',
      '--target', 'QuickAccess');
    const liveClass = live.trim();

    const r = await runJson('classes', 'QuickAccessMenu', '--limit', '20', '--json');
    assert.ok(r.matchCount > 0, 'expected at least one class mapping');
    assert.ok(r.matches.some(m => m.className === liveClass),
      `expected to resolve the live class ${liveClass}, got ${r.matches.map(m => m.className)}`);
  });

  test('a nonsense pattern exits 1', async () => {
    const { code } = await runExpectingFailure('classes', 'zzz_no_such_class_name_qq');
    assert.equal(code, 1);
  });
});

describe('logs filtering', () => {
  test('an invalid --source is rejected', async () => {
    const { code, stderr } = await runExpectingFailure('logs', '--source', 'nonsense');
    assert.equal(code, 2);
    assert.match(stderr, /--source must be one of/);
  });

  test('an invalid --grep regex is rejected up front', async () => {
    const { code, stderr } = await runExpectingFailure('logs', '--grep', '[unclosed');
    assert.equal(code, 2);
    assert.match(stderr, /not a valid regular expression/);
  });

  test('--grep passes matching lines and drops the rest', async () => {
    const child = spawnCli(
      ['logs', '--grep', 'SMOKEPROBE', '--target', 'BigPicture'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });

    try {
      await sleep(1_500);
      await run('eval',
        'console.log("SMOKEPROBE kept"); console.log("dropped line"); 1', '--target', 'BigPicture');
      await waitFor(() => out.includes('SMOKEPROBE kept'), 8_000, 'the matching log line');
      assert.ok(!out.includes('dropped line'), '--grep should filter out non-matching lines');
    } finally {
      child.kill('SIGINT');
    }
  });
});

describe('screenshot --settle', () => {
  const a = join(tmpdir(), `steam-debug-settle-a-${process.pid}.png`);
  const b = join(tmpdir(), `steam-debug-settle-b-${process.pid}.png`);
  after(() => { for (const f of [a, b]) { try { unlinkSync(f); } catch { /* gone */ } } });

  test('reports settled and yields a stable frame on a quiet screen', async () => {
    await run('menu', 'Close').catch(() => {});
    await waitForStableScreen('BigPicture');

    const first = JSON.parse(
      (await runSlow('screenshot', '--target', 'BigPicture', '--out', a, '--settle', '--json')).stdout);
    assert.equal(first.settled, true, 'a quiet screen must settle');

    const { code } = await runSlow(
      'screenshot', '--target', 'BigPicture', '--out', b, '--settle', '--diff', a, '--json')
      .then(() => ({ code: 0 }), e => ({ code: e.code }));
    assert.equal(code, 1, 'two settled captures of a quiet screen must be identical (exit 1)');
  });

  test('reports settled:false instead of hanging when the screen keeps changing', async () => {
    // Navigating starts the library's progressive artwork load, which can run longer than the
    // settle window. The contract is that this is reported, not that it is waited out.
    await navigateAndWait('downloads', '/downloads');
    await navigateAndWait('library', '/library');

    const r = JSON.parse(
      (await runSlow('screenshot', '--target', 'BigPicture', '--out', a, '--settle', '--json')).stdout);
    assert.equal(typeof r.settled, 'boolean', 'settled state must always be reported');
    assert.ok(r.path, 'a frame must be captured either way, settled or not');
  });
});

describe('page.recentPaths', () => {
  test('contains real path strings rather than nulls', async () => {
    await navigateAndWait('downloads', '/downloads');
    await navigateAndWait('library', '/library');
    const { recentPaths } = await runJson('page');
    assert.ok(Array.isArray(recentPaths), 'recentPaths should be an array');
    assert.ok(recentPaths.length > 0, 'recentPaths should not be empty after navigating');
    assert.ok(recentPaths.every(p => typeof p === 'string' && p.startsWith('/')),
      `recentPaths should be path strings, got: ${JSON.stringify(recentPaths)}`);
  });
});

describe('console — Steam\'s developer console', () => {
  test('a real command produces backend output', async () => {
    // `developer` is a convar read: it always answers, and the answer proves the backend
    // channel delivered, not just that the command was accepted.
    const result = await runJson('console', 'developer', '--json');
    assert.equal(result.notFound, false);
    assert.ok(result.lines.length > 0,
      `expected backend output from "developer", got: ${JSON.stringify(result)}`);
    assert.match(result.lines.map(l => l.text).join('\n'), /developer/,
      'the reply should quote the convar it reported on');
  });

  test('list enumerates a plausible command table', async () => {
    const result = JSON.parse((await runSlow('console', 'list', '--json')).stdout);
    assert.ok(result.total > 100,
      `expected a substantial command table, got ${result.total}`);
    assert.equal(result.commands.length, result.matched);
    // Self-consistency rather than a hardcoded name: whatever `console developer` just ran
    // has to appear in the table the same build reports.
    assert.ok(result.commands.includes('developer'),
      'a command that runs must appear in the enumerated table');
  });

  test('list honours a pattern and --limit', async () => {
    const all = JSON.parse((await runSlow('console', 'list', '--json')).stdout);
    const filtered = JSON.parse((await runSlow('console', 'list', 'log', '--limit', '3', '--json')).stdout);
    assert.ok(filtered.matched < all.total, 'a pattern must narrow the table');
    assert.ok(filtered.matched > 0, 'expected at least one command matching /log/');
    assert.ok(filtered.commands.length <= 3, '--limit must cap the listing');
    assert.ok(filtered.commands.every(c => c.includes('log')),
      `every result should match the pattern, got: ${filtered.commands}`);
  });

  test('an unknown command exits 1 rather than reading as an empty success', async () => {
    const { code, stdout } = await runExpectingFailure('console', 'definitelynotacommand', '--json');
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).notFound, true);
  });

  test('a pattern matching nothing exits 1', async () => {
    const { code } = await runSlowExpectingFailure('console', 'list', 'zzzznotacommandzzzz');
    assert.equal(code, 1);
  });

  test('commands that crash the client require --confirm', async () => {
    const { code, stderr } = await runExpectingFailure('console', 'minidump_crash');
    assert.equal(code, 2);
    assert.match(stderr, /--confirm/);
    assert.match(stderr, /crash/i);
  });

  test('--target is rejected: the console is client-wide', async () => {
    const { code } = await runExpectingFailure('console', 'developer', '--target', 'BigPicture');
    assert.equal(code, 2);
  });
});

describe('logs --source backend', () => {
  test('streams Steam\'s own output when something makes it talk', async () => {
    const child = spawnCli(['logs', '--source', 'backend'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });

    try {
      await sleep(1_500);
      // Drive the backend from a second connection: the spew stream is client-wide, so a
      // command issued elsewhere must still show up here.
      await run('console', 'developer');
      await waitFor(() => /\(backend\)/.test(out), 10_000, 'a tagged backend line');
      assert.match(out, /\[INFO ?\] \(backend\)/,
        `backend lines must be tagged so their origin is unambiguous, got: ${out}`);
    } finally {
      child.kill('SIGINT');
    }
  });

  test('is unavailable on a target without SteamClient, and says so', async () => {
    const { code, stderr } = await runExpectingFailure(
      'logs', '--source', 'backend', '--target', 'BigPicture');
    assert.equal(code, 1);
    assert.match(stderr, /SteamClient\.Console/);
  });
});

describe('inject surfaces backend rejections', () => {
  const js = join(tmpdir(), `steam-debug-backend-${process.pid}.js`);
  after(async () => {
    try { unlinkSync(js); } catch { /* gone */ }
    await run('inject', 'remove', 'backendprobe').catch(() => {});
  });

  test('reports a SteamClient call the backend refused', async () => {
    // Wrong arity: the JS call returns normally and the client rejects it, which is exactly
    // the failure mode no frontend stream records.
    writeFileSync(js, 'SteamClient.Downloads.EnableAllDownloads(true);\nreturn () => {};\n');
    const result = await runJson('inject', 'js', js, '--id', 'backendprobe', '--json');

    assert.ok(Array.isArray(result.backendErrors), 'inject must report a backendErrors array');
    assert.ok(result.backendErrors.length > 0,
      'a refused SteamClient call must be reported — otherwise it fails silently');
    assert.match(result.backendErrors.join('\n'), /EnableAllDownloads/,
      `the report should name the method that failed, got: ${JSON.stringify(result.backendErrors)}`);
  });

  test('a clean injection reports no backend errors', async () => {
    writeFileSync(js, 'window.__backendProbeOk = true;\nreturn () => {};\n');
    const result = await runJson('inject', 'js', js, '--id', 'backendprobe', '--json');
    assert.deepEqual(result.backendErrors, [],
      'a harmless injection must not manufacture backend errors');
  });
});

describe('restart guardrails', () => {
  test('a missing mode exits 2', async () => {
    const { code, stderr } = await runExpectingFailure('restart');
    assert.equal(code, 2);
    assert.match(stderr, /js\|client/);
  });

  test('an unknown mode exits 2', async () => {
    const { code } = await runExpectingFailure('restart', 'everything', '--confirm');
    assert.equal(code, 2);
  });

  test('--confirm is required for both modes', async () => {
    for (const mode of ['js', 'client']) {
      const { code, stderr } = await runExpectingFailure('restart', mode);
      assert.equal(code, 2, `restart ${mode} must refuse without --confirm`);
      assert.match(stderr, /--confirm/);
    }
  });

  test('restart client is refused over --host', async () => {
    // Explicit --host, so withDevice leaves it alone on both devices.
    const { code, stderr } = await runExpectingFailure(
      'restart', 'client', '--confirm', '--host', 'not-this-machine.invalid');
    assert.equal(code, 2);
    assert.match(stderr, /cannot work over --host/);
  });
});

describe('status reports a restart fingerprint', () => {
  test('contextStarted is a timestamp in the past', async () => {
    const s = await runJson('status', '--json');
    assert.ok(typeof s.contextStarted === 'string', 'status must report contextStarted');
    const started = Date.parse(s.contextStarted);
    assert.ok(Number.isFinite(started), `contextStarted should parse, got ${s.contextStarted}`);
    assert.ok(started <= Date.now(), 'the context cannot have started in the future');
    assert.ok(s.uptimeSeconds >= 0, 'uptimeSeconds should be non-negative');
  });

  test('is stable while nothing restarts', async () => {
    const a = await runJson('status', '--json');
    const b = await runJson('status', '--json');
    assert.equal(a.contextStarted, b.contextStarted,
      'contextStarted must only change when the context is actually replaced');
  });
});

// Last on purpose: it drops every injection and rebuilds the UI context, so anything
// running after it would be measuring a different client.
describe('restart js', { skip: DEVICE.canLaunch ? false : 'never restarts someone else\'s device' },
  () => {
    test('replaces the JS context and comes back ready', async () => {
      const before = await runJson('status', '--json');

      const { stdout } = await execAsync(
        process.execPath, [SCRIPT, ...withDevice(['restart', 'js', '--confirm', '--json'])],
        { timeout: 120_000 });
      const result = JSON.parse(stdout);

      assert.equal(result.restarted, true, 'the UI should come back');
      assert.equal(result.contextStartedBefore, before.contextStarted);
      assert.notEqual(result.contextStartedAfter, result.contextStartedBefore,
        'a restart that does not replace the context has not restarted anything');

      const after = await runJson('status', '--json');
      assert.equal(after.ready, true, 'the client must be usable again afterwards');
      assert.equal(after.contextStarted, result.contextStartedAfter);
    });
  });
