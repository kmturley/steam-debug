#!/usr/bin/env node
/**
 * Run the smoke suite against one or more devices, in sequence.
 *
 *   node test/run-devices.mjs                 # desktop (default)
 *   node test/run-devices.mjs deck            # a Steam Deck
 *   node test/run-devices.mjs desktop deck    # both
 *
 * Each device runs in its own process so a failure on one still reports the other, and the
 * per-device output stays readable. Exits non-zero if any device failed.
 *
 * Deck runs need STEAM_DECK_HOST (default "steamdeck") reachable, with
 * Settings → System → Developer → CEF Remote Debugging enabled. The suite navigates, opens
 * menus and injects CSS, all visible on the device while it runs.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const KNOWN = ['desktop', 'deck'];

const devices = process.argv.slice(2).map(d => d.toLowerCase());
if (devices.length === 0) devices.push('desktop');

const unknown = devices.filter(d => !KNOWN.includes(d));
if (unknown.length) {
  console.error(`Unknown device(s): ${unknown.join(', ')}. Use: ${KNOWN.join(', ')}`);
  process.exit(2);
}

function runSuite(device) {
  return new Promise(resolve => {
    console.log(`\n${'━'.repeat(72)}\n  ${device.toUpperCase()}\n${'━'.repeat(72)}`);
    const child = spawn(
      process.execPath,
      ['--test', join(HERE, 'smoke.mjs')],
      { stdio: 'inherit', env: { ...process.env, STEAM_DEBUG_DEVICE: device } },
    );
    const started = Date.now();
    child.on('close', code => {
      resolve({ device, code, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

const results = [];
for (const device of devices) results.push(await runSuite(device));

console.log(`\n${'━'.repeat(72)}\n  SUMMARY\n${'━'.repeat(72)}`);
for (const r of results) {
  console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.device.padEnd(8)} ${r.seconds}s`);
}

process.exit(results.some(r => r.code !== 0) ? 1 : 0);
