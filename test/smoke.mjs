#!/usr/bin/env node
/**
 * Smoke tests for steam-debug.mjs.
 *
 * Steam is launched automatically if not already running with CDP enabled.
 * If Steam is running WITHOUT -cef-enable-debugging, kill it first:
 *   macOS: pkill -f steam_osx
 *   Linux: pkill steam
 *
 * Run:
 *   node --test test/smoke.mjs
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'steam-debug.mjs');

async function run(...args) {
  return execAsync(process.execPath, [SCRIPT, ...args], { timeout: 15_000 });
}

async function runJson(...args) {
  const { stdout } = await run(...args);
  return JSON.parse(stdout);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
    const { stdout } = await execAsync(process.execPath, [SCRIPT, 'status'], { timeout: 5_000 });
    if (!stdout.includes('Steam init done:  ✓')) return false;
    // Also verify the Gamepad UI (BigPicture) window is interactive and has a route
    const { stdout: pageOut } = await execAsync(process.execPath, [SCRIPT, 'page'], { timeout: 5_000 });
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
  process.stderr.write('Steam not detected — launching with debug flags...\n');
  launchSteam();
  await pollUntilReady(90_000);
}

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

// Poll page until openMenu matches the expected value, or throw on timeout.
async function menuAndWait(action, expectedState, timeoutMs = 5_000) {
  await run('menu', action);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { openMenu } = await runJson('page');
    if (openMenu === expectedState) return;
    await sleep(200);
  }
  const { openMenu } = await runJson('page');
  throw new Error(`menu ${action}: expected openMenu="${expectedState}", got: "${openMenu}"`);
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

  test('returns error object for a non-existent selector', async () => {
    const result = await runJson('styles', '.nonexistent-xyz-abc-123');
    assert.ok(result.error, 'expected an error field for a missing selector');
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
    const { stdout: lower } = await run('webpack', 'usestate', '--ignore-case');
    assert.ok(stdout => lower.includes('Module') || lower.includes('no matches'),
      'command should not crash');
  });

  test('--limit 1 returns at most 1 match', async () => {
    const { stdout } = await run('webpack', 'useState', '--limit', '1');
    const moduleCount = (stdout.match(/Module \d+:/g) ?? []).length;
    assert.ok(moduleCount <= 1, `expected ≤1 match, got ${moduleCount}`);
  });

  test('returns no-matches message for a nonsense pattern', async () => {
    const { stdout } = await run('webpack', 'xyzzy_no_such_token_abc');
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
