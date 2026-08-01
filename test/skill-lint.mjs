#!/usr/bin/env node
/**
 * skill-lint — verify the documentation matches the implementation.
 *
 * Catches instruction drift: commands or flags that the docs promise but the CLI does not
 * implement, and the reverse. Runs fully offline — no Steam, no network.
 *
 * Run:
 *   node --test test/skill-lint.mjs
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'steam-debug.mjs'), 'utf8');
const SKILL = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');

// Docs that may only reference commands that actually exist.
const DOC_FILES = [
  'SKILL.md',
  'README.md',
  ...readdirSync(join(ROOT, 'reference')).filter(f => f.endsWith('.md')).map(f => join('reference', f)),
].filter(f => existsSync(join(ROOT, f)));

// ─── Extract ground truth from the implementation ────────────────────────────

/** The COMMANDS registry: name, accepted flags, and the handler function. */
function registry() {
  const block = SOURCE.match(/const COMMANDS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not locate the COMMANDS registry in steam-debug.mjs');
  const rows = [...block[1].matchAll(
    // `streaming` is optional and sits between flags and run.
    /^ {2}(\w+):\s*\{\s*targetAware:\s*(true|false),\s*flags:\s*\[([^\]]*)\],\s*(streaming:\s*true,\s*)?run:\s*\([^)]*\)\s*=>\s*(\w+)\(/gm)];
  assert.ok(rows.length > 0, 'COMMANDS registry found but no entries parsed');
  return rows.map(([, name, aware, flags, streaming, handler]) => ({
    name,
    targetAware: aware === 'true',
    flags: [...flags.matchAll(/'([a-z-]+)'/g)].map(m => m[1]),
    streaming: Boolean(streaming),
    handler,
  }));
}

/** Flags accepted by every command, declared once in the source. */
function universalFlags() {
  const m = SOURCE.match(/const UNIVERSAL_FLAGS = \[([^\]]+)\]/);
  assert.ok(m, 'could not locate UNIVERSAL_FLAGS in steam-debug.mjs');
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map(x => x[1]);
}

const cliCommands = () => registry().map(r => r.name);

/** Flag names from parseArgs(). */
function cliFlags() {
  const valueFlags = SOURCE.match(/const valueFlags = \[([^\]]+)\]/);
  const boolFlags = SOURCE.match(/const boolFlags = \[([^\]]+)\]/);
  assert.ok(valueFlags, 'could not locate valueFlags list in parseArgs()');
  assert.ok(boolFlags, 'could not locate boolFlags list in parseArgs()');
  const parse = s => [...s.matchAll(/'(--[a-z-]+)'/g)].map(m => m[1]);
  return [...parse(valueFlags[1]), ...parse(boolFlags[1])];
}

/** How a handler opens its CDP session: forwarding opts keeps --target, {port} drops it. */
function handlerSessionStyle(fnName) {
  const start = SOURCE.indexOf(`function ${fnName}(`);
  if (start === -1) return 'none';
  const next = SOURCE.slice(start + 1).search(/\n(?:async )?function \w+\(/);
  const body = SOURCE.slice(start, next === -1 ? undefined : start + 1 + next);
  if (/withSession\(\s*opts\s*,/.test(body)) return 'opts';
  if (/withSession\(\s*\{\s*port:/.test(body)) return 'port';
  return 'none';
}

/**
 * Parse the authoritative command table out of SKILL.md section 4.
 *
 * Scoped to that section: other tables elsewhere in the document use the same
 * `| \`name\` | …` row shape and would otherwise overwrite these entries.
 */
function skillTable() {
  const section = SKILL.match(/\n## 4\. [^\n]*\n([\s\S]*?)\n## 5\. /);
  assert.ok(section, 'could not locate section 4 in SKILL.md');
  const rows = [...section[1].matchAll(/^\| `([a-z]+)` \|([^\n]*)\|$/gm)];
  const table = {};
  for (const [, name, rest] of rows) {
    // Split on unescaped pipes only — argument cells contain `\|` alternations.
    const cells = rest.split(/(?<!\\)\|/).map(c => c.trim());
    table[name] = { target: cells[1] ?? '', failure: cells[3] ?? '' };
  }
  return table;
}

/** Every `node $S <command>` (or `node steam-debug.mjs <command>`) invocation across the docs. */
function documentedInvocations() {
  const found = [];
  const re = /node\s+(?:\$S|\$\{S\}|"\$S"|\.?\/?steam-debug\.mjs)\s+([^\s'"`|>&;]+)/g;
  for (const file of DOC_FILES) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(re)) {
      const token = m[1];
      if (token.startsWith('<') || token.startsWith('[') || token.startsWith('-')) continue;
      found.push({ file, command: token });
    }
  }
  return found;
}

/** Every flag used on a line that invokes the CLI. */
function documentedFlags() {
  const found = [];
  for (const file of DOC_FILES) {
    for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
      if (!/node\s+(?:\$S|steam-debug\.mjs)/.test(line)) continue;
      for (const m of line.matchAll(/\s(--[a-z][a-z-]*)/g)) found.push({ file, flag: m[1] });
    }
  }
  return found;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('extraction sanity', () => {
  test('finds a plausible command set in the registry', () => {
    const commands = cliCommands();
    assert.ok(commands.length >= 10, `only found ${commands.length} commands: ${commands}`);
    for (const expected of ['status', 'eval', 'help']) {
      assert.ok(commands.includes(expected), `expected '${expected}' among ${commands}`);
    }
  });

  test('finds the flag set in parseArgs', () => {
    const flags = cliFlags();
    assert.ok(flags.includes('--target'), `--target missing from ${flags}`);
    assert.ok(flags.includes('--port'), `--port missing from ${flags}`);
  });

  test('SKILL.md section 4 table parses', () => {
    assert.ok(Object.keys(skillTable()).length >= 10,
      `SKILL.md command table looks wrong, parsed: ${JSON.stringify(skillTable())}`);
  });
});

describe('registry agrees with the handlers', () => {
  test('target-aware commands forward opts to withSession', () => {
    const bad = registry()
      .filter(r => r.targetAware && handlerSessionStyle(r.handler) !== 'opts')
      .map(r => `  ${r.name}: registry says targetAware, but ${r.handler} does not forward opts`);
    assert.deepEqual(bad, [], `registry and handlers disagree:\n${bad.join('\n')}`);
  });

  test('target-blind commands never forward opts', () => {
    const bad = registry()
      .filter(r => !r.targetAware && handlerSessionStyle(r.handler) === 'opts')
      .map(r => `  ${r.name}: registry says target-blind, but ${r.handler} forwards opts`);
    assert.deepEqual(bad, [], `registry and handlers disagree:\n${bad.join('\n')}`);
  });

  test('every flag a command declares is actually parsed', () => {
    const parsed = new Set(cliFlags().map(f => f.slice(2)));
    const bad = [];
    for (const { name, flags } of registry()) {
      for (const f of flags) {
        if (!parsed.has(f)) bad.push(`  ${name} declares --${f}, but parseArgs does not parse it`);
      }
    }
    for (const f of universalFlags()) {
      if (!parsed.has(f)) bad.push(`  UNIVERSAL_FLAGS declares --${f}, but parseArgs does not parse it`);
    }
    assert.deepEqual(bad, [], `registry declares unparsed flags:\n${bad.join('\n')}`);
  });

  test('every parsed flag is claimed by at least one command', () => {
    const claimed = new Set([...universalFlags(), 'target']);
    for (const { flags } of registry()) flags.forEach(f => claimed.add(f));
    const orphans = cliFlags().map(f => f.slice(2)).filter(f => !claimed.has(f));
    assert.deepEqual(orphans, [],
      `parseArgs parses flags no command accepts, so they would always be rejected: ${orphans}`);
  });
});

describe('docs do not invent commands', () => {
  test('every documented invocation is a real command', () => {
    const commands = new Set(cliCommands());
    const bad = documentedInvocations().filter(i => !commands.has(i.command));
    assert.deepEqual(bad, [],
      `docs reference non-existent commands:\n${bad.map(b => `  ${b.file}: node $S ${b.command}`).join('\n')}`);
  });

  test('every documented flag is a real flag', () => {
    const flags = new Set(cliFlags());
    const bad = documentedFlags().filter(f => !flags.has(f.flag));
    assert.deepEqual(bad, [],
      `docs reference non-existent flags:\n${bad.map(b => `  ${b.file}: ${b.flag}`).join('\n')}`);
  });
});

describe('SKILL.md section 4 matches the implementation', () => {
  test('table lists every implemented command', () => {
    const table = skillTable();
    const missing = cliCommands().filter(c => !(c in table));
    assert.deepEqual(missing, [], `commands implemented but undocumented: ${missing}`);
  });

  test('table lists no command that does not exist', () => {
    const commands = new Set(cliCommands());
    const extra = Object.keys(skillTable()).filter(c => !commands.has(c));
    assert.deepEqual(extra, [], `documented but not implemented: ${extra}`);
  });

  test('--target column matches the registry', () => {
    const documented = skillTable();
    const mismatches = [];
    for (const { name, targetAware } of registry()) {
      const cell = documented[name]?.target ?? '';
      const saysYes = cell.includes('**yes**');
      const saysRejected = cell.includes('rejected');
      if (targetAware !== saysYes || targetAware === saysRejected) {
        mismatches.push(`  ${name}: SKILL.md says "${cell}", registry says targetAware=${targetAware}`);
      }
    }
    assert.deepEqual(mismatches, [],
      `SKILL.md section 4 --target column is stale:\n${mismatches.join('\n')}`);
  });

  test('no failure signal still claims exit 0', () => {
    // Every failure path now exits non-zero; a lingering "exit 0" means the docs regressed.
    const stale = Object.entries(skillTable())
      .filter(([, cells]) => /exit 0/.test(cells.failure))
      .map(([name, cells]) => `  ${name}: "${cells.failure}"`);
    assert.deepEqual(stale, [],
      `section 4 still documents exit 0 as a failure signal:\n${stale.join('\n')}`);
  });

  test('hard rule R3 names exactly the target-aware commands', () => {
    const aware = registry().filter(r => r.targetAware).map(r => r.name).sort();
    const r3 = SKILL.match(/\*\*R3 — Target discipline\.\*\*([\s\S]*?)\n\n/);
    assert.ok(r3, 'R3 not found in SKILL.md');
    const named = [...r3[1].matchAll(/`(\w+)`/g)].map(m => m[1])
      .filter(w => w !== 'target').sort();
    assert.deepEqual(named, aware,
      `R3 lists [${named}] but the registry says target-aware commands are [${aware}]`);
  });
});

describe('help output matches the registry', () => {
  // `help` needs no CDP connection, so this stays an offline check.
  const helpText = execFileSync(process.execPath, [join(ROOT, 'steam-debug.mjs'), 'help'],
    { encoding: 'utf8' });

  test('every command appears in help', () => {
    const missing = cliCommands().filter(c => !new RegExp(`^\\s+${c}\\b`, 'm').test(helpText));
    assert.deepEqual(missing, [], `implemented but absent from \`help\`: ${missing}`);
  });

  test('every flag appears in help', () => {
    const missing = cliFlags().filter(f => !helpText.includes(f));
    assert.deepEqual(missing, [], `parsed but absent from \`help\`: ${missing}`);
  });
});

describe('README stays in step with the command surface', () => {
  const readme = existsSync(join(ROOT, 'README.md'))
    ? readFileSync(join(ROOT, 'README.md'), 'utf8') : '';

  test('every command is listed', () => {
    // `help` is developer-facing plumbing rather than a documented workflow step.
    const missing = cliCommands()
      .filter(c => c !== 'help')
      .filter(c => !new RegExp(`\`${c}[\\s\`|]`).test(readme));
    assert.deepEqual(missing, [], `commands missing from README: ${missing}`);
  });

  test('every flag is listed', () => {
    const missing = cliFlags().filter(f => !readme.includes(f));
    assert.deepEqual(missing, [], `flags missing from README: ${missing}`);
  });
});

describe('reference index integrity', () => {
  test('every reference file named in SKILL.md exists', () => {
    const referenced = [...SKILL.matchAll(/`(reference\/[a-z-]+\.md)`/g)].map(m => m[1]);
    assert.ok(referenced.length > 0, 'SKILL.md references no reference files');
    const missing = [...new Set(referenced)].filter(p => !existsSync(join(ROOT, p)));
    assert.deepEqual(missing, [], `SKILL.md points at missing files: ${missing}`);
  });

  test('every reference file is linked from SKILL.md', () => {
    const onDisk = readdirSync(join(ROOT, 'reference')).filter(f => f.endsWith('.md'));
    const orphans = onDisk.filter(f => !SKILL.includes(`reference/${f}`));
    assert.deepEqual(orphans, [], `reference files not linked from SKILL.md: ${orphans}`);
  });
});
