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

/** Source text of one top-level function, from its declaration to the next one. */
function bodyOf(fnName) {
  const start = SOURCE.indexOf(`function ${fnName}(`);
  if (start === -1) return '';
  const next = SOURCE.slice(start + 1).search(/\n(?:async )?function \w+\(/);
  return SOURCE.slice(start, next === -1 ? undefined : start + 1 + next);
}

/** Every top-level function name in the implementation. */
function allFunctionNames() {
  return [...SOURCE.matchAll(/^(?:async )?function (\w+)\(/gm)].map(m => m[1]);
}

/** How a handler opens its CDP session: forwarding opts keeps --target, {port} drops it. */
function handlerSessionStyle(fnName) {
  const body = bodyOf(fnName);
  if (!body) return 'none';
  if (/withSession\(\s*opts\s*,/.test(body)) return 'opts';
  if (/withSession\(\s*\{\s*port:/.test(body)) return 'port';
  return 'none';
}

/**
 * Every function reachable from a handler, following calls to functions defined in this file.
 *
 * Handlers delegate — `cmdRestart` splits into `cmdRestartJs`/`cmdRestartClient`, `cmdConsole`
 * into `cmdConsoleList` — so a failure exit is often set one level down from the entry point.
 */
function reachableFrom(entry) {
  const known = new Set(allFunctionNames());
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const fn = queue.shift();
    if (seen.has(fn) || !known.has(fn)) continue;
    seen.add(fn);
    for (const m of bodyOf(fn).matchAll(/\b(\w+)\s*\(/g)) {
      if (known.has(m[1]) && !seen.has(m[1])) queue.push(m[1]);
    }
  }
  return [...seen];
}

/**
 * Can this command set a failure exit code?
 *
 * `printJson` counts: it sets EXIT_FAIL for any payload carrying an `error` key, which is how
 * the JSON-returning commands report "found nothing" without going through the handler.
 */
function canExitFail(handler) {
  return reachableFrom(handler).some(fn => /EXIT_FAIL/.test(bodyOf(fn)));
}

/** Can this command raise a usage error from its own handler (not from global flag parsing)? */
function throwsUsageError(handler) {
  return reachableFrom(handler).some(fn => /throw new UsageError\(/.test(bodyOf(fn)));
}

/**
 * Flags whose values `validateOpts` rejects. These raise EXIT_USAGE before any handler runs,
 * so a command can document an exit 2 that its own handler never throws — `logs` and `--level`.
 */
function globallyValidatedFlags() {
  const body = bodyOf('validateOpts');
  assert.ok(body, 'could not locate validateOpts in steam-debug.mjs');
  return [...body.matchAll(/opts\.([a-z]+) !== undefined|opts\.([a-z]+)\)/g)]
    .map(m => m[1] ?? m[2]).filter(Boolean);
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

describe('behaviour that is easy to "simplify" back into a bug', () => {
  test('restart client relaunches Steam rather than asking Steam to restart itself', () => {
    // Steam's own restart drops -cef-enable-debugging, so the client returns alive and
    // unreachable and the crash-recovery loop stops working. Measured on macOS.
    const start = SOURCE.indexOf('function cmdRestartClient(');
    assert.ok(start !== -1, 'cmdRestartClient not found — was restart client removed?');
    const next = SOURCE.slice(start + 1).search(/\n(?:async )?function \w+\(/);
    const body = SOURCE.slice(start, next === -1 ? undefined : start + 1 + next);

    assert.ok(!/SteamClient\.User\.StartRestart/.test(body),
      'cmdRestartClient must not use SteamClient.User.StartRestart — it relaunches Steam ' +
      'without -cef-enable-debugging, leaving the client unreachable.');
    assert.ok(/spawn\(/.test(body),
      'cmdRestartClient must launch Steam itself so it comes back debuggable');
  });

  test('the documented --source values match the implementation', () => {
    const m = SOURCE.match(/const LOG_SOURCES = \[([^\]]+)\]/);
    assert.ok(m, 'could not locate LOG_SOURCES in steam-debug.mjs');
    const implemented = [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]);

    const documented = SKILL.match(/`--source <([^>]+)>`/);
    assert.ok(documented, 'SKILL.md section 4 does not document --source values');
    const named = documented[1].split('\\|').map(s => s.trim());

    assert.deepEqual(named, implemented,
      `SKILL.md documents --source ${named} but the CLI accepts ${implemented}`);
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

  // Maintenance checklist 4b. The table used to list only the usage error for `menu` and
  // `watch` while both handlers could also set EXIT_FAIL, so R4 ("read the exit code") was
  // being asked to work against an incomplete table.
  test('every command that can fail documents an exit 1 condition', () => {
    const table = skillTable();
    const undocumented = registry()
      .filter(r => canExitFail(r.handler))
      .filter(r => !/\b1 —/.test(table[r.name]?.failure ?? ''))
      .map(r => `  ${r.name}: ${r.handler} can set EXIT_FAIL, but section 4 says ` +
        `"${table[r.name]?.failure ?? '(no row)'}"`);
    assert.deepEqual(undocumented, [],
      `section 4 omits a failure exit the handler can actually set:\n${undocumented.join('\n')}`);
  });

  test('every documented exit 2 has a real usage error behind it', () => {
    const table = skillTable();
    // Universal flags are deliberately excluded: --port and --timeout are value-checked for
    // every command, so counting them would give each row a free excuse and make this vacuous.
    const validated = new Set(globallyValidatedFlags().filter(f => !universalFlags().includes(f)));
    const phantom = registry()
      .filter(r => /\b2 —/.test(table[r.name]?.failure ?? ''))
      // Either the handler raises it, or a flag specific to this command is value-checked.
      .filter(r => !throwsUsageError(r.handler) && !r.flags.some(f => validated.has(f)))
      .map(r => `  ${r.name}: section 4 claims "${table[r.name].failure}", but ${r.handler} ` +
        'throws no UsageError and accepts no command-specific validated flag');
    assert.deepEqual(phantom, [],
      `section 4 documents a usage error that cannot happen:\n${phantom.join('\n')}`);
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
