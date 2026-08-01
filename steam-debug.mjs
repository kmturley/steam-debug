#!/usr/bin/env node
/**
 * steam-debug — inspect the running Steam Desktop App via Chrome DevTools Protocol.
 *
 * Zero dependencies. Requires Node.js 22+ (uses built-in WebSocket and fetch).
 *
 * Usage:
 *   node steam-debug.mjs <command> [options]
 *
 * Commands:
 *   status                          Check if Steam is running with CDP enabled
 *   targets                         List all active CDP debug targets
 *   eval <expr> [--target <title>]  Evaluate JS in SharedJSContext (or named target)
 *   errors [--target <title>]       Show captured console.error calls
 *   react                           Detect React version in Steam's webpack bundle
 *   styles <selector> [--target t]  Computed styles + layout for a CSS selector
 *   webpack <pattern>               Search webpack modules [--limit N] [--ignore-case]
 *   navigate <page>                 Navigate BPM to a named page (home, settings…)
 *   page                            Show current BPM route, history, open menu
 *   popups                          List all open popup windows from g_PopupManager
 *   module <id>                     Dump full webpack module source by numeric ID
 *   menu <QuickAccess|MainMenu|Close>  Open or close QAM / Main Menu overlay
 *   stores                          Inspect SteamUIStore sub-stores and properties
 *   help                            Show this help
 *
 * Options:
 *   --target <name>   Named target: SharedJSContext, BigPicture, QuickAccess, MainMenu,
 *                     NotificationToasts, Store — or any title substring (default: SharedJSContext).
 *                     Accepted only by eval, errors, logs, styles and module; rejected elsewhere.
 *   --port <port>     Override the CDP port (default: tries 8080 then 9222)
 *
 * Exit codes: 0 success, 1 failure (not found / no matches / no route change), 2 usage error.
 */

import { readFileSync, writeFileSync, watch as fsWatch } from 'node:fs';
import { basename } from 'node:path';
import { inflateSync } from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';

// ─── Configuration ───────────────────────────────────────────────────────────

// 8080 is the desktop default; Steam Deck / SteamOS serves CDP on 8081.
const DEBUG_PORTS = [8080, 8081, 9222];
const CONNECT_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Per-request CDP timeout. Overridable with --timeout: large `module` dumps and slow or remote
 * devices can legitimately exceed the default.
 */
let EVAL_TIMEOUT_MS = 10_000;
const NAV_VERIFY_TIMEOUT_MS = 4_000;
const NAV_POLL_INTERVAL_MS = 250;
const MENU_VERIFY_TIMEOUT_MS = 3_000;
const WATCH_DEBOUNCE_MS = 150;

/** MenuStore side-menu ids, and the names `page` reports for them. */
const MENU_STATES = { 0: 'none', 1: 'MainMenu', 2: 'QuickAccess' };

/** Prefix for every artifact this tool injects, so they can be found and removed. */
const INJECT_PREFIX = 'steam-debug-';

// Exit codes. 0 = the command produced the data that was asked for.
const EXIT_OK = 0;
const EXIT_FAIL = 1;    // operation failed, or produced no result (not found, no matches)
const EXIT_USAGE = 2;   // the invocation itself was wrong

/** Wrong invocation — bad flag, missing argument, unknown command. Exits EXIT_USAGE. */
class UsageError extends Error {}

const LOG_LEVELS = ['all', 'warn', 'error'];
const LOG_SOURCES = ['all', 'console', 'browser'];
const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_INTERVAL_MS = 300;
/** Consecutive matching frame pairs required before the screen counts as settled. */
const SETTLE_STABLE_FRAMES = 3;

/**
 * Print a structured result. An object carrying a string `error` is a failed command:
 * the JSON still goes to stdout so it stays parseable, but the exit code reports failure.
 */
function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.error === 'string') {
    process.exitCode = EXIT_FAIL;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── CdpSession (uses Node.js 22+ built-in WebSocket) ───────────────────────

class CdpSession {
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();
  #ws;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (p) {
          this.#pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.#handlers.get(msg.method)?.forEach(h => h(msg.params));
      }
    });
  }

  static connect(wsUrl, timeoutMs = CONNECT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        reject(new Error(`WebSocket not available: ${e.message}\nRequires Node.js 22+. Run: node --version`));
        return;
      }
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP connect timed out after ${timeoutMs}ms: ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpSession(ws)); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`WebSocket error: ${e.message ?? e}`)); });
    });
  }

  send(method, params, timeoutMs = EVAL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, handler) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(handler);
  }

  close() { this.#ws.close(); }
}

// ─── Steam CDP helpers ───────────────────────────────────────────────────────

const SHARED_CONTEXT_TITLES = new Set([
  'SharedJSContext',
  'Steam Shared Context presented by Valve™',
  'Steam',
  'SP',
]);

function isSharedContext(title, url) {
  return (
    (url.includes('https://steamloopback.host/routes/') ||
     url.includes('https://steamloopback.host/index.html')) &&
    SHARED_CONTEXT_TITLES.has(title)
  );
}

const TARGET_ALIASES = {
  sharedjscontext:    t => isSharedContext(t.title, t.url),
  bigpicture:         t => t.title.toLowerCase().includes('big picture'),
  quickaccess:        t => t.title.toLowerCase().startsWith('quickaccess'),
  mainmenu:           t => t.title.toLowerCase().startsWith('mainmenu'),
  notificationtoasts: t => t.title.toLowerCase().startsWith('notificationtoasts'),
  store:              t => t.title.toLowerCase().includes('store') && !isSharedContext(t.title, t.url),
};

function resolveTarget(targets, nameOrFragment) {
  const key = nameOrFragment.toLowerCase().replace(/\s+/g, '');
  const matcher = TARGET_ALIASES[key];
  if (matcher) {
    const t = targets.find(matcher);
    if (!t) throw new Error(
      `Target "${nameOrFragment}" not found.\n` +
      `Known names: SharedJSContext, BigPicture, QuickAccess, MainMenu, NotificationToasts, Store\n` +
      `Available: ${targets.map(t => t.title).join(', ')}`,
    );
    return t;
  }
  return findByTitle(targets, nameOrFragment);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

async function findEndpoint(opts = {}) {
  const host = opts.host ?? 'localhost';
  const ports = opts.port ? [opts.port] : DEBUG_PORTS;

  if (!LOCAL_HOSTS.has(host)) {
    process.stderr.write(
      `Connecting to ${host} — the CDP endpoint is unauthenticated and grants full ` +
      'JavaScript execution inside Steam. Prefer an SSH tunnel on an untrusted network.\n',
    );
  }

  for (const port of ports) {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`,
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (res.ok) return `http://${host}:${port}`;
    } catch { /* try next */ }
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `No CDP endpoint on ${host} (tried port${ports.length > 1 ? 's' : ''} ${ports.join(', ')}).\n\n` +
      'On the device: Settings → System → Developer → CEF Remote Debugging, then restart Steam.\n' +
      'Check the host is reachable, and that the port is not firewalled.\n',
    );
  }

  throw new Error(
    'Steam is not running with remote debugging enabled.\n\n' +
    'Launch Steam in debug mode:\n' +
    '  macOS:   open -a Steam --args -dev -windowed -cef-enable-debugging -gamepadui\n' +
    '  Linux:   steam -dev -windowed -cef-enable-debugging -gamepadui\n' +
    '  Windows: steam.exe -dev -windowed -cef-enable-debugging -gamepadui\n' +
    '  Deck:    Settings → System → Developer → CEF Remote Debugging\n',
  );
}

/**
 * Point a target's WebSocket URL at the endpoint we actually reached.
 * Steam always advertises localhost, so a remote target's URL is unusable as-is.
 */
function rewriteWsHost(wsUrl, endpoint) {
  const ws = new URL(wsUrl);
  ws.host = new URL(endpoint).host;
  return ws.toString();
}

async function listTargets(endpoint) {
  const res = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Failed to list targets: HTTP ${res.status}`);
  return res.json();
}

function findSharedContext(targets) {
  const t = targets.find(t => t.type === 'page' && isSharedContext(t.title, t.url));
  if (!t) throw new Error(
    'SharedJSContext not found — Steam may still be loading.\n' +
    'Tip: run `steam-debug targets` to see what is available.',
  );
  return t;
}

function findByTitle(targets, fragment) {
  const t = targets.find(t => t.title.toLowerCase().includes(fragment.toLowerCase()));
  if (!t) throw new Error(
    `No target matching "${fragment}".\n` +
    `Available: ${targets.map(t => t.title).join(', ')}`,
  );
  return t;
}

async function openSession(wsUrl) {
  const session = await CdpSession.connect(wsUrl, CONNECT_TIMEOUT_MS);
  await session.send('Runtime.enable', {}, EVAL_TIMEOUT_MS);
  return session;
}

// Resolve a target, open a CDP session, run fn(session, target), then close.
// Default target is SharedJSContext; --target overrides via resolveTarget.
async function withSession(opts, fn) {
  const endpoint = await findEndpoint(opts);
  const targets  = await listTargets(endpoint);
  const target   = opts.target ? resolveTarget(targets, opts.target) : findSharedContext(targets);
  const session  = await openSession(rewriteWsHost(target.webSocketDebuggerUrl, endpoint));
  try {
    return await fn(session, target, targets, endpoint);
  } finally {
    session.close();
  }
}

async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: EVAL_TIMEOUT_MS,
  }, EVAL_TIMEOUT_MS);
  if (result?.result?.subtype === 'error') {
    throw new Error(result.result.description ?? 'JS evaluation error');
  }
  return result?.result?.value;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdStatus(opts) {
  const endpoint = await findEndpoint(opts);
  const targets = await listTargets(endpoint);
  const ctx = targets.find(t => isSharedContext(t.title, t.url));

  // `status` reports state, including bad state, so a not-ready client is still exit 0.
  // Branch on the `ready` field rather than the exit code.
  if (!ctx) {
    emit(opts, {
      endpoint, targetCount: targets.length, sharedContext: null,
      hasWebpack: false, moduleCount: 0, steamInit: false, ready: false,
    }, () => {
      console.log(`CDP endpoint:  ${endpoint}`);
      console.log(`Targets found: ${targets.length}`);
      console.log('SharedJSContext: not found (Steam may still be loading)');
      console.log('\nTip: run `node steam-debug.mjs targets` to see all available targets.');
    });
    return;
  }

  const session = await openSession(rewriteWsHost(ctx.webSocketDebuggerUrl, endpoint));
  try {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const chunk = window.webpackChunksteamui;
      let moduleCount = 0;
      if (chunk) {
        try {
          window.__steam_debug_wr ??= (() => { let r; chunk.push([[Symbol()], {}, _r => { r = _r; }]); return r; })();
          if (window.__steam_debug_wr) moduleCount = Object.keys(window.__steam_debug_wr.m).length;
        } catch {}
      }
      return {
        hasWebpack: !!chunk,
        moduleCount,
        steamInit: !!(window.App?.BFinishedInitStageOne?.()),
        href: location.href,
      };
    })())`);
    const s = JSON.parse(raw);
    emit(opts, {
      endpoint,
      targetCount: targets.length,
      sharedContext: { title: ctx.title, url: ctx.url },
      hasWebpack: s.hasWebpack,
      moduleCount: s.moduleCount,
      steamInit: s.steamInit,
      contextUrl: s.href,
      ready: !!(s.hasWebpack && s.steamInit),
    }, () => {
      console.log(`CDP endpoint:  ${endpoint}`);
      console.log(`Targets found: ${targets.length}`);
      console.log(`SharedJSContext: ${ctx.title}`);
      console.log(`  URL: ${ctx.url}`);
      console.log('');
      console.log('Webpack bundle:  ', s.hasWebpack ? `✓ (${s.moduleCount} modules)` : '✗ not found');
      console.log('Steam init done: ', s.steamInit ? '✓' : '✗');
      console.log('Context URL:     ', s.href);
    });
  } finally {
    session.close();
  }
}

/**
 * Walk the Failure Ladder automatically and report the first thing that is wrong.
 *
 * Mirrors SKILL.md section 6. Checks run in dependency order and stop at the first failure,
 * because everything after it would fail for the same reason.
 */
async function cmdDoctor(opts) {
  const checks = [];
  const add = (name, ok, detail, remedy) => checks.push({ name, ok, detail, remedy });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('Node.js 22+', nodeMajor >= 22, `found ${process.versions.node}`,
    'Upgrade Node — this tool uses the built-in WebSocket and fetch.');

  let endpoint = null;
  try {
    endpoint = await findEndpoint(opts);
    add('CDP endpoint', true, endpoint, null);
  } catch (e) {
    add('CDP endpoint', false, e.message.split('\n')[0],
      'Launch Steam with -cef-enable-debugging. Flags are read only at startup, so an ' +
      'already-running instance ignores them and must be restarted (ask first).');
  }

  let targets = [];
  if (endpoint) {
    try {
      targets = await listTargets(endpoint);
      add('Targets', targets.length > 0, `${targets.length} target(s)`,
        'No renderers yet — Steam is still starting.');
    } catch (e) {
      add('Targets', false, e.message, 'Endpoint answered but target listing failed.');
    }
  }

  const ctx = targets.find(t => isSharedContext(t.title, t.url));
  if (targets.length) {
    add('SharedJSContext', !!ctx, ctx ? ctx.title : 'not found',
      'Steam is still booting — wait and retry rather than relaunching.');
  }

  if (ctx) {
    let session;
    try {
      session = await openSession(rewriteWsHost(ctx.webSocketDebuggerUrl, endpoint));
      const raw = await evaluate(session, `JSON.stringify((() => {
        const chunk = window.webpackChunksteamui;
        return {
          hasWebpack: !!chunk,
          steamInit: !!(window.App?.BFinishedInitStageOne?.()),
          hasStore: !!window.SteamUIStore,
          hasGamepadWindow: !!window.SteamUIStore?.m_WindowStore?.GamepadUIMainWindowInstance,
          injections: Object.keys(window.__steam_debug_injections ?? {}),
          errorShim: !!console.__steam_debug_patched,
        };
      })())`);
      const s = JSON.parse(raw);

      add('Webpack bundle', s.hasWebpack, s.hasWebpack ? 'loaded' : 'not found',
        'UI still loading — wait and retry.');
      add('Steam initialised', s.steamInit, s.steamInit ? 'yes' : 'no',
        'Signed out, or stuck on login/update. Ask the user to finish signing in.');
      add('Big Picture window', s.hasGamepadWindow, s.hasGamepadWindow ? 'present' : 'absent',
        'Launched without -gamepadui. page, menu and stores need Big Picture Mode.');

      // Informational: state this tool may have left behind.
      if (s.injections.length) {
        add('Injections present', true, s.injections.join(', '),
          'Left over from this session — remove with: inject remove <slug>');
      }
      if (s.errorShim) {
        add('console.error shim', true, 'installed by `errors`',
          'Clears on reload; harmless, but it wraps console.error.');
      }
    } catch (e) {
      add('SharedJSContext probe', false, e.message, 'Could not evaluate in the shared context.');
    } finally {
      session?.close();
    }
  }

  const critical = checks.filter(c => !c.ok);
  const healthy = critical.length === 0;

  emit(opts, { healthy, checks }, () => {
    for (const c of checks) {
      console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    }
    console.log('');
    if (healthy) {
      console.log('Ready. All preflight checks passed.');
    } else {
      console.log(`Not ready — ${critical.length} check(s) failed:\n`);
      for (const c of critical) console.log(`  ${c.name}: ${c.remedy}`);
    }
  });

  if (!healthy) process.exitCode = EXIT_FAIL;
}

async function cmdTargets(opts) {
  const endpoint = await findEndpoint(opts);
  const targets = await listTargets(endpoint);

  const list = targets.map(t => ({
    type: t.type,
    title: t.title,
    url: t.url,
    webSocketDebuggerUrl: rewriteWsHost(t.webSocketDebuggerUrl, endpoint),
    isSharedContext: isSharedContext(t.title, t.url),
    isBrowserViewPopup: t.url.includes('browserviewpopup'),
  }));

  emit(opts, { endpoint, targetCount: list.length, targets: list }, () => {
    console.log(`CDP endpoint: ${endpoint}`);
    console.log(`${list.length} target(s):\n`);
    for (const t of list) {
      const marker = t.isSharedContext ? ' ← main JS context' : '';
      console.log(`  [${t.type}] ${t.title}${marker}`);
      console.log(`         URL: ${t.url}`);
      console.log(`         WS:  ${t.webSocketDebuggerUrl}`);
      console.log('');
    }
  });
}

/**
 * Render a CDP RemoteObject for humans.
 *
 * Serialising with returnByValue collapses DOM nodes and functions to `{}`, which reads as
 * "empty result" rather than "not serialisable". Instead we keep a handle and describe it,
 * serialising plain objects in-page via callFunctionOn so the expression is never re-evaluated
 * (re-running it would repeat any side effects, such as an injection).
 */
async function describeRemote(session, r) {
  const plain = (type, text, value) => ({ type, text, value });
  const opaque = (type, text) => ({ type, text, value: undefined });

  if (!r) return opaque('undefined', '(undefined)');

  switch (r.type) {
    case 'undefined':
      return opaque('undefined', '(undefined)');
    case 'string':
      return plain('string', r.value, r.value);
    case 'number':
    case 'boolean':
    case 'bigint':
      return plain(r.type, String(r.value ?? r.description), r.value);
    case 'symbol':
      return opaque('symbol', r.description ?? '(symbol)');
    case 'function': {
      const name = r.description?.match(/(?:function\*?|class)\s+([\w$]+)/)?.[1];
      return opaque('function', name ? `(function ${name})` : '(function)');
    }
    case 'object': {
      if (r.subtype === 'null') return plain('null', 'null', null);
      if (r.subtype === 'node') return opaque('node', `(node ${r.description})`);
      if (!r.objectId) return opaque('object', String(r.description ?? '(object)'));

      const out = await session.send('Runtime.callFunctionOn', {
        objectId: r.objectId,
        functionDeclaration: 'function () { try { return JSON.stringify(this, null, 2); } catch { return null; } }',
        returnByValue: true,
      }, EVAL_TIMEOUT_MS).catch(() => null);

      const json = out?.result?.value;
      if (typeof json === 'string') {
        try { return plain(r.subtype === 'array' ? 'array' : 'object', json, JSON.parse(json)); }
        catch { return opaque('object', json); }
      }
      // Circular, or a host object JSON.stringify refuses — describe it instead.
      return opaque(r.className ?? 'object',
        `(${r.className ?? 'object'}${r.description && r.description !== r.className ? ` ${r.description}` : ''})`);
    }
    default:
      return opaque(r.type, String(r.description ?? r.value ?? `(${r.type})`));
  }
}

async function cmdEval(expr, opts) {
  if (opts.file) {
    if (expr) throw new UsageError('Pass an expression or --file, not both.');
    expr = readSourceFile(opts.file);
  }
  if (!expr) throw new UsageError('Usage: eval <expression> | eval --file <path>');
  await withSession(opts, async (session) => {
    const result = await session.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: false,
      awaitPromise: true,
      timeout: EVAL_TIMEOUT_MS,
    }, EVAL_TIMEOUT_MS);

    const r = result?.result;
    if (result?.exceptionDetails || r?.subtype === 'error') {
      const detail = result?.exceptionDetails;
      const message = r?.description ?? detail?.exception?.description ?? detail?.text ?? 'unknown';
      if (opts.json) printJson({ error: message });
      else console.error('JS Error:', message);
      process.exitCode = EXIT_FAIL;
      return;
    }

    const described = await describeRemote(session, r);
    emit(opts, {
      type: described.type,
      // `value` is absent for anything JSON cannot represent; `text` always describes it.
      ...(described.value === undefined ? {} : { value: described.value }),
      serialisable: described.value !== undefined,
      text: described.text,
    }, () => console.log(described.text));
  });
}

async function cmdErrors(opts) {
  await withSession(opts, async (session, target) => {
    await session.send('Log.enable', {}, EVAL_TIMEOUT_MS);

    const liveErrors = [];
    session.on('Log.entryAdded', p => {
      if (p?.entry?.level === 'error') liveErrors.push(p.entry.text);
    });

    // Install error capture shim (idempotent)
    await evaluate(session, `
      window.__steam_debug_errors ??= [];
      if (!console.__steam_debug_patched) {
        const orig = console.error.bind(console);
        console.error = (...args) => {
          window.__steam_debug_errors.push(args.map(String).join(' '));
          orig(...args);
        };
        console.__steam_debug_patched = true;
      }
      'ok'
    `);

    const captured = JSON.parse(await evaluate(session,
      'JSON.stringify(window.__steam_debug_errors ?? [])'));

    emit(opts, { target: target.title, captured, logErrors: liveErrors }, () => {
      console.log(`Target: ${target.title}\n`);

      if (captured.length) {
        console.log(`Captured console.error calls (${captured.length}):`);
        captured.forEach((e, i) => console.log(`  [${i + 1}] ${e}`));
      } else {
        console.log('No console.error calls captured yet.');
        console.log('(The shim is now installed — re-run this command after reproducing the error.)');
      }

      if (liveErrors.length) {
        console.log('\nLog-level errors:');
        liveErrors.forEach((e, i) => console.log(`  [${i + 1}] ${e}`));
      }
    });
  });
}

async function cmdReact(opts) {
  await withSession({ port: opts.port, host: opts.host }, async (session) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const chunk = window.webpackChunksteamui;
      if (!chunk) return { error: 'webpackChunksteamui not found — is Steam fully loaded?' };

      window.__steam_debug_wr ??= (() => { let r; try { chunk.push([[Symbol()], {}, _r => { r = _r; }]); } catch {} return r; })();
      const wr = window.__steam_debug_wr;
      if (!wr) return { error: 'Failed to capture webpack require' };

      // Detection: React 16+ uses Symbol.for("react.element"), React 19 uses
      // Symbol.for("react.transitional.element"). All ship hook exports (.useState=).
      let reactModuleId = null;
      for (const [id, fn] of Object.entries(wr.m)) {
        const src = fn.toString();
        if (src.includes('Symbol.for("react.') && src.includes('.useState=')) {
          reactModuleId = id;
          break;
        }
      }

      if (!reactModuleId) return { error: 'React not found in webpack bundle' };

      // Load the cached module exports to get version and other props
      let reactExports = null;
      try {
        const numId = parseInt(reactModuleId, 10);
        reactExports = wr(isNaN(numId) ? reactModuleId : numId);
      } catch {}

      const version = reactExports?.version ?? null;

      // Walk the fiber tree — look for __reactContainer or __reactFiber on any mounted root
      const rootEl = document.getElementById('root') ??
        document.querySelector('[id]');
      const fiberKey = rootEl
        ? Object.keys(rootEl).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'))
        : null;
      const fiberRoot = fiberKey ? rootEl[fiberKey] : null;

      let fnComponents = 0, classComponents = 0, hostNodes = 0, maxDepth = 0;
      function walk(fiber, d) {
        if (!fiber) return;
        if (d > maxDepth) maxDepth = d;
        if (typeof fiber.type === 'function') {
          fiber.type.prototype?.isReactComponent ? classComponents++ : fnComponents++;
        } else if (typeof fiber.type === 'string') {
          hostNodes++;
        }
        walk(fiber.child, d + 1);
        walk(fiber.sibling, d);
      }
      if (fiberRoot) walk(fiberRoot, 0);

      return {
        found: true,
        moduleId: reactModuleId,
        version: version ?? 'unknown',
        fiberTreeFound: !!fiberRoot,
        functionComponents: fnComponents,
        classComponents,
        hostNodes,
        maxFiberDepth: maxDepth,
      };
    })())`);
    printJson(JSON.parse(raw));
  });
}

async function cmdStyles(selector, opts) {
  if (!selector) throw new UsageError('Usage: styles <selector> [--target <title>]');
  await withSession(opts, async (session) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'No element matches: ' + ${JSON.stringify(selector)} };

      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const props = [
        'display','visibility','opacity','position','top','left','width','height',
        'margin','padding','background','color','font-size','font-family',
        'border','border-radius','box-shadow','z-index','overflow','flex',
        'align-items','justify-content','pointer-events','cursor',
      ];
      // CSS custom properties actually resolved on this element
      const cssVars = {};
      for (const name of cs) {
        if (name.startsWith('--')) cssVars[name] = cs.getPropertyValue(name).trim();
      }

      return {
        tagName:   el.tagName.toLowerCase(),
        className: el.className,
        rect:      { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        styles:    Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p).trim()]).filter(([, v]) => v)),
        cssVars,
      };
    })())`);
    printJson(JSON.parse(raw));
  });
}

/** Dump an element subtree — the structure, without the noise of full outerHTML. */
async function cmdDom(selector, opts) {
  if (!selector) throw new UsageError('Usage: dom <selector> [--depth <n>] [--target <title>]');
  const depth = opts.depth ?? 2;

  await withSession(opts, async (session) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'No element matches: ' + ${JSON.stringify(selector)} };

      const walk = (el, d) => {
        const r = el.getBoundingClientRect();
        const node = {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          classes: el.classList.length ? [...el.classList] : undefined,
          rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
          childCount: el.children.length,
        };
        const attrs = {};
        for (const a of el.attributes) {
          if (a.name.startsWith('data-') || a.name === 'role' || a.name === 'aria-label') attrs[a.name] = a.value;
        }
        if (Object.keys(attrs).length) node.attrs = attrs;
        if (!el.children.length) {
          const t = (el.textContent ?? '').trim();
          if (t) node.text = t.length > 80 ? t.slice(0, 80) + '…' : t;
        } else if (d > 0) {
          node.children = [...el.children].map(c => walk(c, d - 1));
        }
        return node;
      };
      return walk(root, ${depth});
    })())`);

    const tree = JSON.parse(raw);
    if (tree.error) { printJson(tree); return; }

    emit(opts, tree, () => {
      const render = (node, indent) => {
        const pad = '  '.repeat(indent);
        const cls = node.classes ? `.${node.classes.join('.')}` : '';
        const id = node.id ? `#${node.id}` : '';
        const size = `${node.rect.width}x${node.rect.height}`;
        const hidden = node.rect.width === 0 || node.rect.height === 0 ? ' (no size)' : '';
        console.log(`${pad}${node.tag}${id}${cls}  [${size}]${hidden}`);
        if (node.text) console.log(`${pad}  "${node.text}"`);
        if (node.children) node.children.forEach(c => render(c, indent + 1));
        else if (node.childCount) console.log(`${pad}  … ${node.childCount} child element(s) not shown`);
      };
      render(tree, 0);
    });
  });
}

/**
 * Resolve Steam's minified CSS-module class names.
 *
 * CSS modules compile to objects of the form `ReadableName:"minifiedHash"` in the bundle, so the
 * readable name is searchable even though the class in the DOM is not. Values are matched by
 * shape, which is a heuristic: hash-like, and mixing case with digits.
 */
async function cmdClasses(pattern, opts) {
  if (!pattern) throw new UsageError('Usage: classes <pattern> [--limit <n>] [--ignore-case]');
  const limit = opts.limit ?? 20;
  const ignoreCase = opts['ignore-case'] === true;

  await withSession({ port: opts.port, host: opts.host }, async (session) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const chunk = window.webpackChunksteamui;
      if (!chunk) return { error: 'webpackChunksteamui not found' };
      window.__steam_debug_wr ??= (() => { let r; try { chunk.push([[Symbol()], {}, _r => { r = _r; }]); } catch {} return r; })();
      const wr = window.__steam_debug_wr;
      if (!wr) return { error: 'Failed to capture webpack require' };

      const pat = ${JSON.stringify(pattern)};
      const ic = ${JSON.stringify(ignoreCase)};
      const needle = ic ? pat.toLowerCase() : pat;
      const lim = ${JSON.stringify(limit)};

      // ReadableName:"hash" — key may be quoted or bare.
      const pairRe = /["']?([A-Za-z_$][\\w$-]*)["']?\\s*:\\s*"([A-Za-z_][\\w-]{10,})"/g;
      const looksMinified = v =>
        /[0-9]/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v) && !/\\s/.test(v);

      const seen = new Set();
      const matches = [];
      for (const [id, fn] of Object.entries(wr.m)) {
        const src = fn.toString();
        if (src.indexOf(':"') === -1) continue;
        for (const m of src.matchAll(pairRe)) {
          const [, name, className] = m;
          if (!looksMinified(className)) continue;
          const hay = ic ? name.toLowerCase() : name;
          if (!hay.includes(needle)) continue;
          const key = name + '|' + className;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({ name, className, moduleId: id });
          if (matches.length >= lim) break;
        }
        if (matches.length >= lim) break;
      }
      return { pattern: pat, matchCount: matches.length, matches };
    })())`);

    const result = JSON.parse(raw);
    if (result.error) {
      if (opts.json) printJson(result); else console.error('Error:', result.error);
      process.exitCode = EXIT_FAIL;
      return;
    }

    emit(opts, { ...result, ignoreCase, limit }, () => {
      const icNote = ignoreCase ? ' (case-insensitive)' : '';
      console.log(`Pattern "${result.pattern}"${icNote} — ${result.matchCount} class name(s):\n`);
      for (const m of result.matches) {
        console.log(`  ${m.name}`);
        console.log(`    .${m.className}   (module ${m.moduleId})`);
      }
      if (result.matchCount === 0) {
        console.log('  (no matches — try a shorter pattern or add --ignore-case)');
      } else {
        console.log('\nVerify one with: styles ".<className>" --target <window>');
      }
    });
    if (result.matchCount === 0) process.exitCode = EXIT_FAIL;
  });
}

async function cmdWebpack(pattern, opts) {
  if (!pattern) throw new UsageError('Usage: webpack <pattern> [--limit <n>] [--ignore-case]');
  const limit = opts.limit ?? 10;   // validateOpts() guarantees a positive integer
  const ignoreCase = opts['ignore-case'] === true;
  await withSession({ port: opts.port, host: opts.host }, async (session) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const chunk = window.webpackChunksteamui;
      if (!chunk) return { error: 'webpackChunksteamui not found' };

      window.__steam_debug_wr ??= (() => { let r; try { chunk.push([[Symbol()], {}, _r => { r = _r; }]); } catch {} return r; })();
      const wr = window.__steam_debug_wr;
      if (!wr) return { error: 'Failed to capture webpack require' };

      const pat = ${JSON.stringify(pattern)};
      const ic  = ${JSON.stringify(ignoreCase)};
      const lim = ${JSON.stringify(limit)};
      const needle = ic ? pat.toLowerCase() : pat;
      const matches = [];
      for (const [id, fn] of Object.entries(wr.m)) {
        const src = fn.toString();
        const haystack = ic ? src.toLowerCase() : src;
        const idx = haystack.indexOf(needle);
        if (idx === -1) continue;
        matches.push({
          moduleId: id,
          snippet: src.slice(Math.max(0, idx - 60), idx + pat.length + 80).replace(/\\s+/g, ' ').trim(),
        });
        if (matches.length >= lim) break;
      }
      return { pattern: pat, totalModules: Object.keys(wr.m).length, matchCount: matches.length, matches };
    })())`);
    const result = JSON.parse(raw);
    if (result.error) {
      console.error('Error:', result.error);
      process.exitCode = EXIT_FAIL;
      return;
    }
    emit(opts, { ...result, ignoreCase, limit }, () => {
      const icNote = ignoreCase ? ' (case-insensitive)' : '';
      console.log(`Pattern "${result.pattern}"${icNote} — ${result.matchCount} match(es) in ${result.totalModules} modules:\n`);
      for (const m of result.matches) {
        console.log(`  Module ${m.moduleId}:`);
        console.log(`    ...${m.snippet}...`);
        console.log('');
      }
      if (result.matchCount === 0) {
        console.log('  (no matches — try a shorter pattern or add --ignore-case)');
      }
    });
    if (result.matchCount === 0) process.exitCode = EXIT_FAIL;
  });
}

/**
 * Navigation aliases. `expect` is the route prefix the Big Picture window should land on;
 * null means the URL is known not to move the Big Picture route (it opens elsewhere, or
 * does nothing in gamepad UI).
 */
const NAV_ALIASES = {
  // Expectations must be specific enough not to match a sibling route: '/library' would also
  // match '/library/downloads', so navigating home from downloads would report success wrongly.
  home:      { url: 'steam://open/library',   expect: '/library/home' },
  library:   { url: 'steam://open/library',   expect: '/library/home' },
  downloads: { url: 'steam://open/downloads', expect: '/library/downloads' },
  settings:  { url: 'steam://open/settings',  expect: '/settings' },
  store:     { url: 'steam://store',          expect: '/steamweb' },
  account:   { url: 'steam://open/account',   expect: null },
  chat:      { url: 'steam://open/friends',   expect: null },
  friends:   { url: 'steam://open/friends',   expect: null },
};

/** Which side menu is open: 'none', 'MainMenu', 'QuickAccess', or null if unavailable. */
async function readOpenMenu(session) {
  try {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const id = window.SteamUIStore?.m_WindowStore?.GamepadUIMainWindowInstance
        ?.m_MenuStore?.m_eOpenSideMenu;
      return id === undefined ? null : (${JSON.stringify(MENU_STATES)}[id] ?? id);
    })())`);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Current Big Picture route, or null when there is no gamepad UI window to ask. */
async function readCurrentPath(session) {
  try {
    const raw = await evaluate(session, 'JSON.stringify(window.SteamUIStore?.m_WindowStore' +
      '?.GamepadUIMainWindowInstance?.m_history?.location?.pathname ?? null)');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function cmdNavigate(page, opts) {
  if (!page) {
    throw new UsageError(`Usage: navigate <${Object.keys(NAV_ALIASES).join('|')}|steam://url>`);
  }
  const isRawUrl = page.startsWith('steam://');
  const alias = isRawUrl ? null : NAV_ALIASES[page.toLowerCase()];
  const url = isRawUrl ? page : (alias?.url ?? `steam://open/${page}`);
  const expect = alias?.expect ?? null;

  await withSession({ port: opts.port, host: opts.host }, async (session) => {
    const before = await readCurrentPath(session);
    await evaluate(session, `SteamClient.URL.ExecuteSteamURL(${JSON.stringify(url)})`);

    // Without a gamepad UI window there is no route to compare against.
    if (before === null) {
      emit(opts, { url, verified: false, before: null, after: null, changed: null }, () => {
        process.stderr.write(`Executed: ${url}\n`);
        process.stderr.write('Route not verified — no Big Picture window (is -gamepadui set?)\n');
      });
      return;
    }

    // The URL is handled asynchronously, so poll rather than assuming it took effect.
    const deadline = Date.now() + NAV_VERIFY_TIMEOUT_MS;
    let after = before;
    while (Date.now() < deadline) {
      after = await readCurrentPath(session);
      if (after !== before) break;
      if (expect && after?.startsWith(expect)) break;
      await sleep(NAV_POLL_INTERVAL_MS);
    }

    const arrived = (expect && after?.startsWith(expect)) || after !== before;
    const alreadyThere = arrived && after === before;

    emit(opts, { url, verified: true, before, after, changed: after !== before, arrived }, () => {
      if (arrived) {
        process.stderr.write(`Navigated: ${url} -> ${after}${alreadyThere ? ' (already there)' : ''}\n`);
      } else {
        process.stderr.write(`Executed: ${url}\n`);
        process.stderr.write(`Route unchanged (${after}) — no-op in the current UI mode.\n`);
      }
    });

    if (!arrived) process.exitCode = EXIT_FAIL;
  });
}

async function cmdPage(opts) {
  await withSession({ port: opts.port, host: opts.host }, async (session) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const win = window.SteamUIStore?.m_WindowStore?.GamepadUIMainWindowInstance;
      if (!win) return { error: 'GamepadUIMainWindowInstance not found — is -gamepadui flag set?' };
      const menuNames = ${JSON.stringify(MENU_STATES)};
      const openMenuId = win.m_MenuStore?.m_eOpenSideMenu ?? -1;
      return {
        currentPath:  win.m_history?.location?.pathname ?? null,
        // Backstack entries are plain path strings; the old object mapping yielded all nulls.
        recentPaths:  (win.m_arrBackstack ?? [])
          .map(e => (typeof e === 'string' ? e : (e?.pathname ?? e?.path ?? null)))
          .slice(-5),
        openMenu:     menuNames[openMenuId] ?? openMenuId,
      };
    })())`);
    printJson(JSON.parse(raw));
  });
}

async function cmdPopups(opts) {
  await withSession({ port: opts.port, host: opts.host }, async (session) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const pm = window.g_PopupManager;
      if (!pm?.m_mapPopups) return { error: 'g_PopupManager not found' };
      const result = [];
      for (const [k, v] of pm.m_mapPopups) {
        result.push({
          key:   k,
          title: v.m_popup?.document?.title ?? null,
          url:   (v.m_popup?.location?.href ?? '').split('?')[0],
        });
      }
      return result;
    })())`);
    printJson(JSON.parse(raw));
  });
}

async function cmdModule(id, opts) {
  if (!id) throw new UsageError('Usage: module <moduleId>');
  await withSession(opts, async (session) => {
    // Envelope so a missing module is distinguishable from source that happens to look
    // like an error string. Previously "Module X not found" printed to stdout and exited 0.
    const raw = await evaluate(session, `JSON.stringify((() => {
      const chunk = window.webpackChunksteamui;
      if (!chunk) return { error: 'webpackChunksteamui not found' };
      window.__steam_debug_wr ??= (() => { let r; try { chunk.push([[Symbol()], {}, _r => { r = _r; }]); } catch {} return r; })();
      const wr = window.__steam_debug_wr;
      if (!wr) return { error: 'Failed to capture webpack require' };
      const fn = wr.m[${JSON.stringify(id)}];
      if (!fn) return { error: 'Module ${id} not found' };
      return { src: fn.toString() };
    })())`);
    const result = JSON.parse(raw);
    if (result.error) {
      if (opts.json) printJson({ moduleId: id, error: result.error });
      else console.error(result.error);
      process.exitCode = EXIT_FAIL;
      return;
    }
    emit(opts, { moduleId: id, length: result.src.length, source: result.src },
      () => console.log(result.src));
  });
}

async function cmdStores(opts) {
  await withSession({ port: opts.port, host: opts.host }, async (session) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const root = window.SteamUIStore;
      if (!root) return { error: 'window.SteamUIStore not found — is -gamepadui flag set?' };

      // One level deep: for each sub-store, list its non-function property names.
      const result = {};
      for (const key of Object.keys(root)) {
        const sub = root[key];
        if (typeof sub === 'function') continue;
        if (sub !== null && typeof sub === 'object') {
          result[key] = Object.keys(sub)
            .filter(k => typeof sub[k] !== 'function')
            .slice(0, 15);
        } else {
          result[key] = sub;
        }
      }
      return result;
    })())`);
    printJson(JSON.parse(raw));
  });
}

async function cmdMenu(which, opts) {
  if (!which) throw new UsageError('Usage: menu <QuickAccess|MainMenu|Close>');
  const menuIds = { quickaccess: 2, mainmenu: 1, close: 0, none: 0 };
  const menuId = menuIds[which.toLowerCase().replace(/\s+/g, '')];
  if (menuId === undefined) {
    throw new UsageError(`Unknown menu "${which}". Use: QuickAccess, MainMenu, Close`);
  }
  const expected = MENU_STATES[menuId];

  await withSession({ port: opts.port, host: opts.host }, async (session) => {
    await evaluate(session,
      `window.SteamUIStore.m_WindowStore.GamepadUIMainWindowInstance.m_MenuStore.OpenSideMenu(${menuId})`);

    // Verify rather than assume — the call returns before the menu state settles.
    const deadline = Date.now() + MENU_VERIFY_TIMEOUT_MS;
    let actual = null;
    while (Date.now() < deadline) {
      actual = await readOpenMenu(session);
      if (actual === expected) break;
      await sleep(NAV_POLL_INTERVAL_MS);
    }

    const ok = actual === expected;
    emit(opts, { requested: which, expected, openMenu: actual, ok }, () => {
      if (ok) process.stderr.write(`Menu: ${expected}\n`);
      else process.stderr.write(
        `Requested ${which}, but openMenu is "${actual}" — expected "${expected}".\n`);
    });
    if (!ok) process.exitCode = EXIT_FAIL;
  });
}

async function cmdLogs(opts) {
  await withSession(opts, async (session, target) => {
    const level = (opts.level ?? 'all').toLowerCase();
    const showAll   = level === 'all';
    const showWarn  = showAll || level === 'warn';
    const showError = showAll || level === 'error' || showWarn;

    const source = (opts.source ?? 'all').toLowerCase();
    const wantConsole = source === 'all' || source === 'console';
    const wantBrowser = source === 'all' || source === 'browser';
    const grep = opts.grep ? new RegExp(opts.grep) : null;

    process.stderr.write(`Streaming logs from: ${target.title}\n`);
    process.stderr.write(`Level filter: ${level}  (--level all|warn|error)\n`);
    if (source !== 'all') process.stderr.write(`Source filter: ${source}\n`);
    if (grep) process.stderr.write(`Pattern: ${opts.grep}\n`);
    process.stderr.write('Ctrl+C to stop.\n\n');

    // Runtime.consoleAPICalled — console.log/warn/error/info/debug etc.
    session.on('Runtime.consoleAPICalled', (params) => {
      if (!wantConsole) return;
      const type = params.type ?? 'log';
      if (type === 'error' && !showError) return;
      if (type === 'warning' && !showWarn) return;
      if (!showAll && type !== 'error' && type !== 'warning') return;

      const msg = (params.args ?? []).map(a => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        return `(${a.type})`;
      }).join(' ');
      if (grep && !grep.test(msg)) return;

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ channel: 'console', level: type, text: msg })}\n`);
        return;
      }
      const tag = { error: 'ERROR', warning: 'WARN ', info: 'INFO ', debug: 'DEBUG' }[type] ?? 'LOG  ';
      process.stdout.write(`[${tag}] ${msg}\n`);
    });

    // Log.entryAdded — network failures, CSP violations, security errors, worker crashes
    session.on('Log.entryAdded', (params) => {
      const e = params?.entry;
      if (!e || !wantBrowser) return;
      if (e.level === 'error' && !showError) return;
      if (e.level === 'warning' && !showWarn) return;
      if (!showAll && e.level !== 'error' && e.level !== 'warning') return;
      if (grep && !grep.test(e.text ?? '')) return;

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({
          channel: 'log', level: e.level, text: e.text, url: e.url ?? null, source: e.source ?? null,
        })}\n`);
        return;
      }
      const tag = { error: 'ERROR', warning: 'WARN ', info: 'INFO ', verbose: 'TRACE' }[e.level] ?? 'LOG  ';
      const src = e.url ? ` (${e.url.split('/').pop()})` : '';
      process.stdout.write(`[${tag}]${src} ${e.text}\n`);
    });

    await session.send('Log.enable', {}, EVAL_TIMEOUT_MS);

    await new Promise(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  });
  process.exit(0);
}

// ─── Minimal PNG decode, for screenshot --diff ───────────────────────────────
// Only what CDP emits: 8-bit RGB or RGBA, non-interlaced. Anything else is refused rather
// than guessed at.

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file');

  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(
      `unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
  }

  const channels = colorType === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec section 9.2).
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`unknown PNG scanline filter ${filter}`);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Per-pixel comparison. `threshold` ignores encoding noise on any single channel. */
function diffPng(a, b, threshold = 8) {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      comparable: false,
      reason: `size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    };
  }

  let changedPixels = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;

  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      if (Math.abs(a.data[ia] - b.data[ib]) > threshold ||
          Math.abs(a.data[ia + 1] - b.data[ib + 1]) > threshold ||
          Math.abs(a.data[ia + 2] - b.data[ib + 2]) > threshold) {
        changedPixels++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  const totalPixels = a.width * a.height;
  return {
    comparable: true,
    changed: changedPixels > 0,
    changedPixels,
    totalPixels,
    percentChanged: Number(((changedPixels / totalPixels) * 100).toFixed(4)),
    boundingBox: changedPixels
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null,
  };
}

async function capturePng(session, clip) {
  const { data } = await session.send('Page.captureScreenshot',
    { format: 'png', ...(clip ? { clip } : {}) }, EVAL_TIMEOUT_MS);
  return Buffer.from(data, 'base64');
}

/**
 * Capture repeatedly until two consecutive frames match.
 *
 * Big Picture keeps repainting for seconds after a route change — the library hero and artwork
 * settle asynchronously — so a naive capture measures the animation rather than the state you
 * care about. Returns the last frame either way; a screen that never settles is reported, not
 * treated as an error, since something may animate forever.
 */
async function settleScreen(session, clip) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let prev = await capturePng(session, clip);
  let stableRuns = 0;

  while (Date.now() < deadline) {
    await sleep(SETTLE_INTERVAL_MS);
    const next = await capturePng(session, clip);
    // Byte equality is the fast path; fall back to a pixel compare so a non-deterministic
    // encoder cannot spin this loop forever.
    const same = prev.equals(next) || !diffPng(decodePng(prev), decodePng(next)).changed;
    prev = next;

    // Require several consecutive matches: a single pair can match during a momentary pause in
    // an animation that is still running, which was observed after a route change.
    stableRuns = same ? stableRuns + 1 : 0;
    if (stableRuns >= SETTLE_STABLE_FRAMES) return { png: next, settled: true };
  }
  return { png: prev, settled: false };
}

/**
 * Capture what the compositor actually painted.
 *
 * This is the only way to confirm a visual change: computed styles prove a rule matched, but
 * CEF drops some paints entirely (see reference/injection.md), so `styles` can report a value
 * that is nowhere on screen.
 */
async function cmdScreenshot(selector, opts) {
  await withSession(opts, async (session, target) => {
    // Browser-view popups are composited outside the page tree, so Page.captureScreenshot
    // never returns for them — it hangs until the CDP timeout rather than erroring.
    if (target.url.includes('browserviewpopup')) {
      console.error(
        `"${target.title}" is a browser-view popup and cannot be captured — CDP screenshot ` +
        'hangs on these targets.\n' +
        'Capture the BigPicture target instead. Note that it shows the popup\'s backdrop effect ' +
        'but not the popup itself, which is composited separately.',
      );
      process.exitCode = EXIT_FAIL;
      return;
    }

    await session.send('Page.enable', {}, EVAL_TIMEOUT_MS);

    let clip;
    if (selector) {
      const raw = await evaluate(session, `JSON.stringify((() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })())`);
      const rect = JSON.parse(raw);
      if (!rect) {
        console.error(`No element matches: ${selector}`);
        process.exitCode = EXIT_FAIL;
        return;
      }
      if (rect.width === 0 || rect.height === 0) {
        console.error(
          `Element "${selector}" has zero size (${rect.width}x${rect.height}) — ` +
          'it is present but not laid out, so there is nothing to capture.');
        process.exitCode = EXIT_FAIL;
        return;
      }
      clip = { ...rect, scale: 1 };
    }

    let png;
    let settled = null;
    if (opts.settle) {
      const result = await settleScreen(session, clip);
      png = result.png;
      settled = result.settled;
      if (!settled) {
        process.stderr.write(
          `Screen never stopped changing within ${SETTLE_TIMEOUT_MS}ms — capturing anyway. ` +
          'Something on screen animates continuously.\n');
      }
    } else {
      png = await capturePng(session, clip);
    }

    const out = opts.out ?? `steam-${target.title.replace(/[^\w.-]+/g, '-').toLowerCase()}.png`;
    writeFileSync(out, png);

    // The PNG is in device pixels, so on a HiDPI display it is larger than the CSS region.
    const dpr = Number(await evaluate(session, 'window.devicePixelRatio')) || 1;
    const region = clip ? `${Math.round(clip.width)}x${Math.round(clip.height)} CSS px` : 'viewport';
    const scaleNote = dpr === 1 ? '' : ` at ${dpr}x device scale`;

    if (!opts.diff) {
      emit(opts, {
        path: out, target: target.title, region, deviceScale: dpr, clip: clip ?? null, settled,
      }, () => {
        process.stderr.write(`Captured ${region}${scaleNote} from ${target.title}\n`);
        console.log(out);
      });
      return;
    }

    // --diff: answer "did anything actually change?" without a human looking.
    let comparison;
    try {
      comparison = diffPng(decodePng(readFileSync(opts.diff)), decodePng(png));
    } catch (e) {
      throw new Error(`Cannot compare against ${opts.diff}: ${e.message}`);
    }

    if (!comparison.comparable) {
      emit(opts, { path: out, target: target.title, baseline: opts.diff, ...comparison },
        () => process.stderr.write(`Not comparable — ${comparison.reason}\n`));
      process.exitCode = EXIT_FAIL;
      return;
    }

    emit(opts, {
      path: out, target: target.title, baseline: opts.diff, deviceScale: dpr, settled, ...comparison,
    },
      () => {
        if (comparison.changed) {
          const b = comparison.boundingBox;
          process.stderr.write(
            `Changed: ${comparison.changedPixels} of ${comparison.totalPixels} px ` +
            `(${comparison.percentChanged}%), bounding box ` +
            `${b.width}x${b.height} at ${b.x},${b.y}\n`);
        } else {
          process.stderr.write(`Identical to ${opts.diff} — nothing was painted differently.\n`);
        }
        console.log(out);
      });

    // No difference is an empty result, which is exit 1 by the same rule as `webpack`.
    if (!comparison.changed) process.exitCode = EXIT_FAIL;
  });
}

/** Turn a file path into a DOM-safe slug: styles/dark-theme.css -> dark-theme */
function slugFromPath(file) {
  const base = basename(file).replace(/\.[^.]+$/, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new UsageError(`Cannot derive an id from "${file}" — pass --id explicitly.`);
  return slug;
}

function readSourceFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`Cannot read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`);
  }
}

/**
 * Build the in-page expression that installs an injection.
 *
 * Always remove-then-add, so applying the same slug repeatedly replaces rather than stacks —
 * which is what makes `watch` safe to run in a loop.
 */
function buildInjectExpression(mode, source, slug) {
  const domId = INJECT_PREFIX + slug;

  if (mode === 'css') {
    return `JSON.stringify((() => {
      const ID = ${JSON.stringify(domId)};
      document.getElementById(ID)?.remove();
      const el = document.createElement('style');
      el.id = ID;
      el.textContent = ${JSON.stringify(source)};
      document.head.appendChild(el);
      (window.__steam_debug_injections ??= {})[${JSON.stringify(slug)}] =
        { type: 'css', at: Date.now() };
      return { ok: !!document.getElementById(ID), rules: el.sheet?.cssRules?.length ?? null };
    })())`;
  }

  // The file's source is embedded literally rather than passed as a string: Steam's CSP can
  // block new Function/eval, and this keeps stack traces pointing at real code.
  return `JSON.stringify((() => {
    const reg = (window.__steam_debug_injections ??= {});
    const prev = reg[${JSON.stringify(slug)}];
    if (prev?.teardown) { try { prev.teardown(); } catch (e) {} }
    const result = (function () {
${source}
    }).call(window);
    reg[${JSON.stringify(slug)}] =
      { type: 'js', at: Date.now(), teardown: typeof result === 'function' ? result : null };
    return { ok: true, hasTeardown: typeof result === 'function' };
  })())`;
}

/**
 * Inject CSS or JS, list what is injected, or remove it.
 *
 * Every artifact is namespaced and registered in window.__steam_debug_injections so it can be
 * enumerated and reversed. Injection is always remove-then-add, so re-running is safe.
 * Nothing here survives a page reload.
 */
async function cmdInject(rest, opts) {
  const [mode, arg] = rest;
  const USAGE = 'Usage: inject <css|js> <file> [--id <slug>] | inject list | inject remove <slug>';
  if (!mode) throw new UsageError(USAGE);

  if (mode === 'list') return cmdInjectList(opts);
  if (mode === 'remove') {
    if (!arg) throw new UsageError('Usage: inject remove <slug>');
    return cmdInjectRemove(arg, opts);
  }
  if (mode !== 'css' && mode !== 'js') throw new UsageError(USAGE);
  if (!arg) throw new UsageError(USAGE);

  const source = readSourceFile(arg);
  const slug = opts.id ?? slugFromPath(arg);
  const expression = buildInjectExpression(mode, source, slug);

  await withSession(opts, async (session, target) => {
    const result = JSON.parse(await evaluate(session, expression));
    if (!result.ok) {
      console.error(`Injection failed for "${slug}".`);
      process.exitCode = EXIT_FAIL;
      return;
    }

    process.stderr.write(`Injected ${mode} "${slug}" into ${target.title}\n`);
    if (mode === 'css' && result.rules === 0) {
      process.stderr.write('Warning: stylesheet parsed to 0 rules — check the CSS is valid.\n');
    }
    if (mode === 'js' && !result.hasTeardown) {
      process.stderr.write(
        'Warning: no teardown. Return a function from the file to make removal possible.\n');
    }
    process.stderr.write(`Remove with: inject remove ${slug}\n`);
    process.stderr.write('Injections do not survive a page reload or Steam restart.\n');

    printJson({ id: slug, type: mode, target: target.title });
  });
}

async function cmdInjectList(opts) {
  await withSession(opts, async (session, target) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const reg = window.__steam_debug_injections ?? {};
      const entries = Object.entries(reg).map(([id, v]) => ({
        id,
        type: v.type,
        hasTeardown: !!v.teardown,
        injectedAt: v.at ? new Date(v.at).toISOString() : null,
      }));
      // Style tags without a registry entry: injected by hand, still ours to report.
      const orphans = [...document.querySelectorAll('[id^=${JSON.stringify(INJECT_PREFIX).slice(1, -1)}]')]
        .map(el => el.id.slice(${INJECT_PREFIX.length}))
        .filter(id => !(id in reg))
        .map(id => ({ id, type: 'css', hasTeardown: false, injectedAt: null, unregistered: true }));
      return [...entries, ...orphans];
    })())`);
    const list = JSON.parse(raw);
    process.stderr.write(`${list.length} injection(s) in ${target.title}\n`);
    printJson(list);
  });
}

async function cmdInjectRemove(slug, opts) {
  await withSession(opts, async (session, target) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const slug = ${JSON.stringify(slug)};
      const reg = window.__steam_debug_injections ?? {};
      const entry = reg[slug];
      const el = document.getElementById(${JSON.stringify(INJECT_PREFIX)} + slug);
      if (!entry && !el) return { removed: false, reason: 'not found' };
      let teardownError = null;
      if (entry?.teardown) {
        try { entry.teardown(); } catch (e) { teardownError = String(e); }
      }
      el?.remove();
      delete reg[slug];
      return { removed: true, teardownError };
    })())`);
    const result = JSON.parse(raw);

    if (!result.removed) {
      console.error(`No injection "${slug}" in ${target.title}.`);
      process.exitCode = EXIT_FAIL;
      return;
    }
    if (result.teardownError) {
      process.stderr.write(`Teardown threw: ${result.teardownError}\n`);
    }
    process.stderr.write(`Removed "${slug}" from ${target.title}\n`);
    printJson({ id: slug, removed: true });
  });
}

/**
 * Re-inject on every file change until interrupted, over one persistent CDP session.
 *
 * A failing edit (invalid CSS, a syntax error) is reported and the watch continues — losing the
 * loop on every typo would defeat the point.
 */
async function cmdWatch(rest, opts) {
  const [mode, file] = rest;
  const USAGE = 'Usage: watch <css|js> <file> [--id <slug>]';
  if (mode !== 'css' && mode !== 'js') throw new UsageError(USAGE);
  if (!file) throw new UsageError(USAGE);

  readSourceFile(file);   // fail fast on an unreadable path, before opening a session
  const slug = opts.id ?? slugFromPath(file);

  await withSession(opts, async (session, target) => {
    let applying = false;
    let coalesced = false;

    const apply = async (reason) => {
      if (applying) { coalesced = true; return; }
      applying = true;
      const stamp = new Date().toLocaleTimeString();
      try {
        const source = readFileSync(file, 'utf8');
        const result = JSON.parse(
          await evaluate(session, buildInjectExpression(mode, source, slug)));
        if (result.ok && mode === 'css' && result.rules === 0) {
          process.stderr.write(`[${stamp}] ${reason}: applied, but 0 rules parsed — check the CSS\n`);
        } else if (result.ok) {
          process.stderr.write(`[${stamp}] ${reason}: applied\n`);
        } else {
          process.stderr.write(`[${stamp}] ${reason}: injection reported failure\n`);
        }
      } catch (e) {
        process.stderr.write(`[${stamp}] ${reason}: ${e.message}\n`);
      } finally {
        applying = false;
        if (coalesced) { coalesced = false; await apply('coalesced change'); }
      }
    };

    await apply('initial');
    process.stderr.write(
      `Watching ${file} -> "${slug}" in ${target.title}. Ctrl+C to stop.\n`);

    let debounce = null;
    let watcher = null;
    const startWatching = () => {
      watcher = fsWatch(file, (eventType) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => apply('changed'), WATCH_DEBOUNCE_MS);
        // Editors that save by rename detach the watch from the old inode; re-establish it.
        if (eventType === 'rename') {
          watcher.close();
          setTimeout(() => { try { startWatching(); } catch { /* file went away */ } }, WATCH_DEBOUNCE_MS);
        }
      });
    };
    startWatching();

    await new Promise(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });

    clearTimeout(debounce);
    watcher?.close();
    process.stderr.write(
      `\nStopped. "${slug}" is still injected — remove with: inject remove ${slug}\n`);
  });
  process.exit(EXIT_OK);
}

function cmdHelp() {
  console.log(`
steam-debug — inspect the Steam Desktop App via Chrome DevTools Protocol
Requires Node.js 22+. Zero external dependencies.

Usage:
  node steam-debug.mjs <command> [options]

Commands:
  status                          Check if Steam is running with CDP enabled
  doctor                          Diagnose the whole setup and report what to fix
  targets                         List all active CDP debug targets
  eval <expr> [--target <t>]      Evaluate a JS expression (default: SharedJSContext)
  errors [--target <t>]           Show captured console.error calls (point-in-time)
  logs [--target <t>] [--level]   Stream live console output until Ctrl+C
  react                           Detect React in Steam's webpack bundle
  styles <selector> [--target t]  Computed styles + layout rect for a CSS selector
  dom <selector> [--depth N]      Dump an element subtree (structure, sizes, text)
  webpack <pattern>               Search webpack modules [--limit N] [--ignore-case]
  classes <pattern>               Resolve minified CSS-module class names by readable name
  navigate <page>                 Navigate BPM to a page (home, settings, downloads…)
  page                            Show current BPM route, recent history, open menu
  popups                          List all open popup windows (g_PopupManager)
  module <id>                     Dump full webpack module source by numeric ID
  menu <QuickAccess|MainMenu|Close>  Open or close the QAM / Main Menu overlay
  stores                          Inspect SteamUIStore sub-stores and their properties
  screenshot [selector] [--out f] Capture what is actually painted (PNG)
             [--diff base.png]    Compare against a baseline; exit 1 if identical
             [--settle]           Wait for the screen to stop changing before capturing
  inject css|js <file> [--id s]   Inject a stylesheet or script, namespaced and reversible
  inject list                     List injected artifacts
  inject remove <slug>            Remove an injection and run its teardown
  watch css|js <file> [--id s]    Re-inject on every file change until Ctrl+C
  help                            Show this help

Options:
  --target <name>   Named target: SharedJSContext, BigPicture, QuickAccess, MainMenu,
                    NotificationToasts, Store — or any title substring.
                    Accepted only by: eval, errors, logs, styles, module.
                    Every other command always runs against SharedJSContext and
                    rejects --target rather than silently ignoring it.
  --port <n>        Override CDP port (default: tries 8080 then 9222)
  --host <addr>     Connect to another machine, e.g. a Steam Deck (default: localhost).
                    The endpoint is unauthenticated — prefer an SSH tunnel.
                    Comma-separate to run the same command on several devices, each
                    optionally with its own port:  --host localhost,steamdeck:8081
                    Output is labelled per device; exit 0 only if all succeeded.
  --level <l>       Log level filter for 'logs': all (default), warn, error
  --source <s>      Log channel for 'logs': all (default), console, browser
  --grep <regex>    Only show log lines matching this pattern
  --limit <n>       Max results for 'webpack' and 'classes' (positive integer)
  --ignore-case     Case-insensitive search for 'webpack' and 'classes'
  --depth <n>       Subtree depth for 'dom' (default: 2)
  --out <path>      Output file for 'screenshot'
  --diff <path>     Baseline PNG to compare a new capture against
  --file <path>     Read the expression for 'eval' from a file
  --id <slug>       Override the injection id (default: derived from the filename)
  --timeout <ms>    Per-request CDP timeout (default: 10000)
  --json            Machine-readable stdout. Accepted by every command; 'logs' emits
                    one JSON object per line.

Flags are rejected by commands that do not act on them, rather than ignored.

Exit codes:
  0  success — the requested data was produced
  1  failure — no CDP endpoint, target or module not found, no matches,
     selector matched nothing, JS threw, or navigate did not change the route
  2  usage  — unknown command, missing argument, or an invalid flag value

Launching Steam with CDP enabled:
  macOS:   open -a Steam --args -dev -windowed -cef-enable-debugging -gamepadui
  Linux:   steam -dev -windowed -cef-enable-debugging -gamepadui
  Windows: steam.exe -dev -windowed -cef-enable-debugging -gamepadui
  Deck:    Settings → System → Developer → CEF Remote Debugging
`);
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = [...argv.slice(2)];
  const opts = {};

  const valueFlags = ['--target', '--port', '--host', '--level', '--limit', '--out', '--file',
    '--id', '--timeout', '--diff', '--depth', '--grep', '--source'];
  for (const flag of valueFlags) {
    const i = args.indexOf(flag);
    if (i !== -1) {
      const value = args[i + 1];
      // A missing value used to become undefined and silently fall back to the default.
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${flag} requires a value.`);
      }
      opts[flag.slice(2)] = value;
      args.splice(i, 2);
    }
  }

  const boolFlags = ['--ignore-case', '--json', '--settle'];
  for (const flag of boolFlags) {
    const i = args.indexOf(flag);
    if (i !== -1) {
      opts[flag.slice(2)] = true;
      args.splice(i, 1);
    }
  }

  validateOpts(opts);
  return { command: args[0] ?? 'status', rest: args.slice(1), opts };
}

/** Reject flag values that would otherwise fail quietly and return a plausible wrong answer. */
function validateOpts(opts) {
  if (opts.level !== undefined && !LOG_LEVELS.includes(opts.level.toLowerCase())) {
    throw new UsageError(
      `--level must be one of ${LOG_LEVELS.join(', ')} — got "${opts.level}".\n` +
      'An unrecognised level used to stream nothing at all.',
    );
  }

  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new UsageError(
        `--limit must be a positive integer — got "${opts.limit}".\n` +
        'A non-numeric limit used to silently return exactly one result.',
      );
    }
    opts.limit = n;
  }

  if (opts.port !== undefined) {
    const n = Number(opts.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new UsageError(`--port must be a valid port number — got "${opts.port}".`);
    }
    opts.port = n;
  }

  if (opts.depth !== undefined) {
    const n = Number(opts.depth);
    if (!Number.isInteger(n) || n < 0) {
      throw new UsageError(`--depth must be a non-negative integer — got "${opts.depth}".`);
    }
    opts.depth = n;
  }

  if (opts.source !== undefined && !LOG_SOURCES.includes(opts.source.toLowerCase())) {
    throw new UsageError(
      `--source must be one of ${LOG_SOURCES.join(', ')} — got "${opts.source}".`);
  }

  if (opts.grep !== undefined) {
    try { new RegExp(opts.grep); }
    catch (e) { throw new UsageError(`--grep is not a valid regular expression: ${e.message}`); }
  }

  if (opts.timeout !== undefined) {
    const n = Number(opts.timeout);
    if (!Number.isInteger(n) || n < 1) {
      throw new UsageError(`--timeout must be a positive number of milliseconds — got "${opts.timeout}".`);
    }
    opts.timeout = n;
    EVAL_TIMEOUT_MS = n;
  }

  if (opts.id !== undefined && !/^[a-z0-9][a-z0-9-]*$/i.test(opts.id)) {
    throw new UsageError(
      `--id must be alphanumeric with dashes — got "${opts.id}".\n` +
      'It becomes part of a DOM id, so it has to be a valid selector fragment.',
    );
  }
}

/** Flags every command understands. Anything else must be declared per command. */
const UNIVERSAL_FLAGS = ['port', 'host', 'timeout', 'json'];

/**
 * Emit a result: machine-readable under --json, human-readable otherwise.
 * Every command supports --json, so an agent never has to parse prose.
 */
function emit(opts, value, renderHuman) {
  if (opts.json) printJson(value);
  else renderHuman(value);
}

/** Reject flags the command does not act on, rather than accepting and ignoring them. */
function validateFlagsForCommand(command, entry, opts) {
  // --target has its own message: being sent to the wrong window is the costly mistake.
  if (opts.target !== undefined && !entry.targetAware) {
    const aware = Object.entries(COMMANDS).filter(([, c]) => c.targetAware).map(([n]) => n);
    throw new UsageError(
      `--target is not supported by "${command}" — it always runs against SharedJSContext.\n` +
      `Target-aware commands: ${aware.join(', ')}`,
    );
  }

  const allowed = new Set([
    ...UNIVERSAL_FLAGS,
    ...(entry.flags ?? []),
    ...(entry.targetAware ? ['target'] : []),
  ]);
  const rejected = Object.keys(opts).filter(f => !allowed.has(f));
  if (rejected.length) {
    const accepted = [...allowed].map(f => `--${f}`).join(', ');
    throw new UsageError(
      `${rejected.map(f => `--${f}`).join(', ')} ${rejected.length > 1 ? 'are' : 'is'} not ` +
      `supported by "${command}".\nAccepted: ${accepted}`,
    );
  }
}

/**
 * Command registry. `targetAware` declares whether --target is meaningful: commands that always
 * run against SharedJSContext reject it rather than accepting and discarding it.
 * This table is the source of truth for test/skill-lint.mjs.
 */
const COMMANDS = {
  status:     { targetAware: false, flags: [],                     run: (rest, opts) => cmdStatus(opts) },
  doctor:     { targetAware: false, flags: [],                     run: (rest, opts) => cmdDoctor(opts) },
  targets:    { targetAware: false, flags: [],                     run: (rest, opts) => cmdTargets(opts) },
  eval:       { targetAware: true,  flags: ['file'],               run: (rest, opts) => cmdEval(rest.join(' '), opts) },
  errors:     { targetAware: true,  flags: [],                     run: (rest, opts) => cmdErrors(opts) },
  logs:       { targetAware: true,  flags: ['level', 'grep', 'source'], streaming: true, run: (rest, opts) => cmdLogs(opts) },
  react:      { targetAware: false, flags: [],                     run: (rest, opts) => cmdReact(opts) },
  styles:     { targetAware: true,  flags: [],                     run: (rest, opts) => cmdStyles(rest[0], opts) },
  dom:        { targetAware: true,  flags: ['depth'],              run: (rest, opts) => cmdDom(rest[0], opts) },
  webpack:    { targetAware: false, flags: ['limit', 'ignore-case'], run: (rest, opts) => cmdWebpack(rest[0], opts) },
  classes:    { targetAware: false, flags: ['limit', 'ignore-case'], run: (rest, opts) => cmdClasses(rest[0], opts) },
  navigate:   { targetAware: false, flags: [],                     run: (rest, opts) => cmdNavigate(rest[0], opts) },
  page:       { targetAware: false, flags: [],                     run: (rest, opts) => cmdPage(opts) },
  popups:     { targetAware: false, flags: [],                     run: (rest, opts) => cmdPopups(opts) },
  module:     { targetAware: true,  flags: [],                     run: (rest, opts) => cmdModule(rest[0], opts) },
  menu:       { targetAware: false, flags: [],                     run: (rest, opts) => cmdMenu(rest[0], opts) },
  stores:     { targetAware: false, flags: [],                     run: (rest, opts) => cmdStores(opts) },
  screenshot: { targetAware: true,  flags: ['out', 'diff', 'settle'], run: (rest, opts) => cmdScreenshot(rest[0], opts) },
  inject:     { targetAware: true,  flags: ['id'],                 run: (rest, opts) => cmdInject(rest, opts) },
  watch:      { targetAware: true,  flags: ['id'], streaming: true, run: (rest, opts) => cmdWatch(rest, opts) },
  help:       { targetAware: false, flags: [],                     run: () => cmdHelp() },
};

/**
 * Parse --host into one or more devices.
 *
 * Accepts a comma-separated list, each entry optionally carrying its own port, so a desktop and
 * a Deck (which serves 8081) can be addressed together: `--host localhost,steamdeck:8081`.
 */
function parseDevices(opts) {
  if (!opts.host) return [{ host: undefined, port: opts.port }];

  return opts.host.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const withPort = entry.match(/^(.+?):(\d+)$/);
    if (withPort) return { host: withPort[1], port: Number(withPort[2]) };
    return { host: entry, port: opts.port };
  });
}

const deviceLabel = d => (d.host ?? 'localhost') + (d.port ? `:${d.port}` : '');

/** Per-device output tag, carried across awaits so concurrent streams stay attributable. */
const deviceTags = new AsyncLocalStorage();

/** Collect everything a command writes to stdout, so it can be labelled or aggregated. */
async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

/**
 * Run one command against several devices.
 *
 * Streaming commands run concurrently with each line tagged by device; everything else runs in
 * sequence so output stays readable and a slow device cannot interleave with a fast one. One
 * device failing never stops the others — the exit code reports whether all of them succeeded.
 */
async function runMultiDevice(command, entry, rest, opts, devices) {
  if (entry.streaming) {
    process.stderr.write(`Streaming from ${devices.length} devices — Ctrl+C to stop.\n`);

    // One writer for the whole process, resolving the tag from async context. Swapping
    // process.stdout.write per device would nest the wrappers, since concurrent tasks each
    // capture whatever the previous one installed.
    const write = { out: process.stdout.write.bind(process.stdout),
                    err: process.stderr.write.bind(process.stderr) };
    const tagged = (original) => (chunk, encoding, callback) => {
      const tag = deviceTags.getStore();
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      return original(tag ? text.replace(/^(?=.)/gm, tag) : text, encoding, callback);
    };
    process.stdout.write = tagged(write.out);
    process.stderr.write = tagged(write.err);

    try {
      await Promise.all(devices.map((device) => {
        const tag = `[${deviceLabel(device)}] `;
        return deviceTags.run(tag, async () => {
          try {
            await entry.run(rest, { ...opts, ...device });
          } catch (e) {
            write.err(`${tag}${e.message}\n`);
            process.exitCode = EXIT_FAIL;
          }
        });
      }));
    } finally {
      process.stdout.write = write.out;
      process.stderr.write = write.err;
    }
    return;
  }

  const results = [];
  for (const device of devices) {
    const label = deviceLabel(device);
    // A shared --out would have each device overwrite the last.
    const out = opts.out ? opts.out.replace(/(\.[^.]+)?$/, `.${label.replace(/[^\w.-]+/g, '-')}$&`) : undefined;
    const deviceOpts = { ...opts, ...device, ...(out ? { out } : {}) };

    process.exitCode = EXIT_OK;
    let stdout = '';
    let error = null;
    try {
      stdout = await captureStdout(() => entry.run(rest, deviceOpts));
    } catch (e) {
      error = e.message;
    }
    const exitCode = error ? EXIT_FAIL : (process.exitCode ?? EXIT_OK);
    results.push({ host: label, ok: exitCode === EXIT_OK && !error, exitCode, stdout, error });
  }

  process.exitCode = results.every(r => r.ok) ? EXIT_OK : EXIT_FAIL;

  if (opts.json) {
    console.log(JSON.stringify({
      devices: results.map(({ host, ok, exitCode, stdout, error }) => {
        const entryOut = { host, ok, exitCode };
        if (error) return { ...entryOut, error };
        try { return { ...entryOut, result: JSON.parse(stdout) }; }
        catch { return { ...entryOut, output: stdout.trimEnd() }; }
      }),
    }, null, 2));
    return;
  }

  for (const r of results) {
    console.log(`\n━━━ ${r.host}${r.ok ? '' : `  (failed, exit ${r.exitCode})`} ━━━`);
    if (r.error) console.log(`  ${r.error.split('\n').join('\n  ')}`);
    else if (r.stdout.trim()) console.log(r.stdout.trimEnd());
    else console.log('  (no output)');
  }
}

async function main() {
  const { command, rest, opts } = parseArgs(process.argv);

  const entry = COMMANDS[command];
  if (!entry) {
    throw new UsageError(
      `Unknown command: ${command}\nAvailable: ${Object.keys(COMMANDS).join(', ')}`,
    );
  }

  validateFlagsForCommand(command, entry, opts);

  // A misspelled flag never reaches opts, so without this it would survive as a positional and
  // be silently ignored — `status --hots deck` would quietly run against localhost.
  // `eval` is exempt: its expression is free-form and may legitimately begin with `--`.
  if (command !== 'eval') {
    const unknown = rest.filter(a => a.startsWith('--'));
    if (unknown.length) {
      throw new UsageError(
        `Unknown flag${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n` +
        'Run `help` for the list of flags.');
    }
  }

  const devices = parseDevices(opts);
  if (devices.length > 1) {
    await runMultiDevice(command, entry, rest, opts, devices);
    return;
  }

  await entry.run(rest, { ...opts, ...devices[0] });
}

main().catch(err => {
  console.error(err.message);
  process.exit(err instanceof UsageError ? EXIT_USAGE : EXIT_FAIL);
});
