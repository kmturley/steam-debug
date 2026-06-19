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
 *                     NotificationToasts, Store — or any title substring (default: SharedJSContext)
 *   --port <port>     Override the CDP port (default: tries 8080 then 9222)
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const DEBUG_PORTS = [8080, 9222];
const CONNECT_TIMEOUT_MS = 5_000;
const EVAL_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;

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

async function findEndpoint(overridePort) {
  const ports = overridePort ? [overridePort] : DEBUG_PORTS;
  for (const port of ports) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`,
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (res.ok) return `http://localhost:${port}`;
    } catch { /* try next */ }
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
  const endpoint = await findEndpoint(opts.port);
  const targets  = await listTargets(endpoint);
  const target   = opts.target ? resolveTarget(targets, opts.target) : findSharedContext(targets);
  const session  = await openSession(target.webSocketDebuggerUrl);
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
  const endpoint = await findEndpoint(opts.port);
  const targets = await listTargets(endpoint);

  console.log(`CDP endpoint:  ${endpoint}`);
  console.log(`Targets found: ${targets.length}`);

  const ctx = targets.find(t => isSharedContext(t.title, t.url));
  if (!ctx) {
    console.log('SharedJSContext: not found (Steam may still be loading)');
    console.log('\nTip: run `node steam-debug.mjs targets` to see all available targets.');
    return;
  }

  console.log(`SharedJSContext: ${ctx.title}`);
  console.log(`  URL: ${ctx.url}`);

  const session = await openSession(ctx.webSocketDebuggerUrl);
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
    console.log('');
    console.log('Webpack bundle:  ', s.hasWebpack ? `✓ (${s.moduleCount} modules)` : '✗ not found');
    console.log('Steam init done: ', s.steamInit ? '✓' : '✗');
    console.log('Context URL:     ', s.href);
  } finally {
    session.close();
  }
}

async function cmdTargets(opts) {
  const endpoint = await findEndpoint(opts.port);
  const targets = await listTargets(endpoint);

  console.log(`CDP endpoint: ${endpoint}`);
  console.log(`${targets.length} target(s):\n`);
  for (const t of targets) {
    const marker = isSharedContext(t.title, t.url) ? ' ← main JS context' : '';
    console.log(`  [${t.type}] ${t.title}${marker}`);
    console.log(`         URL: ${t.url}`);
    console.log(`         WS:  ${t.webSocketDebuggerUrl}`);
    console.log('');
  }
}

async function cmdEval(expr, opts) {
  if (!expr) { console.error('Usage: eval <expression>'); process.exit(1); }
  await withSession(opts, async (session) => {
    const result = await session.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      timeout: EVAL_TIMEOUT_MS,
    }, EVAL_TIMEOUT_MS);
    const r = result?.result;
    if (r?.subtype === 'error') {
      console.error('JS Error:', r.description);
      process.exit(1);
    }
    if (r?.value !== undefined) {
      console.log(typeof r.value === 'object' ? JSON.stringify(r.value, null, 2) : String(r.value));
    } else {
      console.log(`(${r?.type ?? 'undefined'})`);
    }
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
}

async function cmdReact(opts) {
  await withSession({ port: opts.port }, async (session) => {
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
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  });
}

async function cmdStyles(selector, opts) {
  if (!selector) { console.error('Usage: styles <selector> [--target <title>]'); process.exit(1); }
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
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  });
}

async function cmdWebpack(pattern, opts) {
  if (!pattern) { console.error('Usage: webpack <pattern> [--limit <n>] [--ignore-case]'); process.exit(1); }
  const limit = parseInt(opts.limit ?? '10', 10);
  const ignoreCase = opts['ignore-case'] === true;
  await withSession({ port: opts.port }, async (session) => {
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
    if (result.error) { console.error('Error:', result.error); process.exit(1); }
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
}

async function cmdNavigate(page, opts) {
  if (!page) {
    console.error('Usage: navigate <home|settings|downloads|account|chat|library|store|<steam://url>>');
    process.exit(1);
  }
  const urlMap = {
    home:      'steam://open/library',
    library:   'steam://open/library',
    settings:  'steam://open/settings',
    downloads: 'steam://open/downloads',
    account:   'steam://open/account',
    chat:      'steam://open/friends',
    store:     'steam://store',
    friends:   'steam://open/friends',
  };
  const url = page.startsWith('steam://') ? page : (urlMap[page.toLowerCase()] ?? `steam://open/${page}`);
  await withSession({ port: opts.port }, async (session) => {
    await evaluate(session, `SteamClient.URL.ExecuteSteamURL(${JSON.stringify(url)})`);
    process.stderr.write(`Navigated: ${url}\n`);
  });
}

async function cmdPage(opts) {
  await withSession({ port: opts.port }, async (session) => {
    const raw = await evaluate(session, `JSON.stringify((() => {
      const win = window.SteamUIStore?.m_WindowStore?.GamepadUIMainWindowInstance;
      if (!win) return { error: 'GamepadUIMainWindowInstance not found — is -gamepadui flag set?' };
      const menuNames = { 0: 'none', 1: 'MainMenu', 2: 'QuickAccess' };
      const openMenuId = win.m_MenuStore?.m_eOpenSideMenu ?? -1;
      return {
        currentPath:  win.m_history?.location?.pathname ?? null,
        recentPaths:  (win.m_arrBackstack ?? []).map(e => e.pathname ?? e.path).slice(-5),
        openMenu:     menuNames[openMenuId] ?? openMenuId,
      };
    })())`);
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  });
}

async function cmdPopups(opts) {
  await withSession({ port: opts.port }, async (session) => {
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
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  });
}

async function cmdModule(id, opts) {
  if (!id) { console.error('Usage: module <moduleId>'); process.exit(1); }
  await withSession(opts, async (session) => {
    const src = await evaluate(session, `(() => {
      const chunk = window.webpackChunksteamui;
      if (!chunk) return 'webpackChunksteamui not found';
      window.__steam_debug_wr ??= (() => { let r; try { chunk.push([[Symbol()], {}, _r => { r = _r; }]); } catch {} return r; })();
      const wr = window.__steam_debug_wr;
      if (!wr) return 'Failed to capture webpack require';
      const fn = wr.m[${JSON.stringify(id)}];
      return fn ? fn.toString() : 'Module ${id} not found';
    })()`);
    console.log(src);
  });
}

async function cmdStores(opts) {
  await withSession({ port: opts.port }, async (session) => {
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
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  });
}

async function cmdMenu(which, opts) {
  if (!which) {
    console.error('Usage: menu <QuickAccess|MainMenu|Close>');
    process.exit(1);
  }
  const menuIds = { quickaccess: 2, mainmenu: 1, close: 0, none: 0 };
  const menuId = menuIds[which.toLowerCase().replace(/\s+/g, '')];
  if (menuId === undefined) {
    console.error(`Unknown menu "${which}". Use: QuickAccess, MainMenu, Close`);
    process.exit(1);
  }
  await withSession({ port: opts.port }, async (session) => {
    await evaluate(session,
      `window.SteamUIStore.m_WindowStore.GamepadUIMainWindowInstance.m_MenuStore.OpenSideMenu(${menuId})`);
    process.stderr.write(`Menu set: ${which} (id=${menuId})\n`);
  });
}

async function cmdLogs(opts) {
  await withSession(opts, async (session, target) => {
    const level = (opts.level ?? 'all').toLowerCase();
    const showAll   = level === 'all';
    const showWarn  = showAll || level === 'warn';
    const showError = showAll || level === 'error' || showWarn;

    process.stderr.write(`Streaming logs from: ${target.title}\n`);
    process.stderr.write(`Level filter: ${level}  (--level all|warn|error)\n`);
    process.stderr.write('Ctrl+C to stop.\n\n');

    // Runtime.consoleAPICalled — console.log/warn/error/info/debug etc.
    session.on('Runtime.consoleAPICalled', (params) => {
      const type = params.type ?? 'log';
      if (type === 'error' && !showError) return;
      if (type === 'warning' && !showWarn) return;
      if (!showAll && type !== 'error' && type !== 'warning') return;

      const msg = (params.args ?? []).map(a => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        return `(${a.type})`;
      }).join(' ');

      const tag = { error: 'ERROR', warning: 'WARN ', info: 'INFO ', debug: 'DEBUG' }[type] ?? 'LOG  ';
      process.stdout.write(`[${tag}] ${msg}\n`);
    });

    // Log.entryAdded — network failures, CSP violations, security errors, worker crashes
    session.on('Log.entryAdded', (params) => {
      const e = params?.entry;
      if (!e) return;
      if (e.level === 'error' && !showError) return;
      if (e.level === 'warning' && !showWarn) return;
      if (!showAll && e.level !== 'error' && e.level !== 'warning') return;

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

function cmdHelp() {
  console.log(`
steam-debug — inspect the Steam Desktop App via Chrome DevTools Protocol
Requires Node.js 22+. Zero external dependencies.

Usage:
  node steam-debug.mjs <command> [options]

Commands:
  status                          Check if Steam is running with CDP enabled
  targets                         List all active CDP debug targets
  eval <expr> [--target <t>]      Evaluate a JS expression (default: SharedJSContext)
  errors [--target <t>]           Show captured console.error calls (point-in-time)
  logs [--target <t>] [--level]   Stream live console output until Ctrl+C
  react                           Detect React in Steam's webpack bundle
  styles <selector> [--target t]  Computed styles + layout rect for a CSS selector
  webpack <pattern>               Search webpack modules [--limit N] [--ignore-case]
  navigate <page>                 Navigate BPM to a page (home, settings, downloads…)
  page                            Show current BPM route, recent history, open menu
  popups                          List all open popup windows (g_PopupManager)
  module <id>                     Dump full webpack module source by numeric ID
  menu <QuickAccess|MainMenu|Close>  Open or close the QAM / Main Menu overlay
  stores                          Inspect SteamUIStore sub-stores and their properties

Options:
  --target <name>   Named target: SharedJSContext, BigPicture, QuickAccess, MainMenu,
                    NotificationToasts, Store — or any title substring
  --port <n>        Override CDP port (default: tries 8080 then 9222)
  --level <l>       Log level filter for 'logs' command: all (default), warn, error
  --limit <n>       Max results for 'webpack' command (default: 10)
  --ignore-case     Case-insensitive search for 'webpack' command

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

  for (const flag of ['--target', '--port', '--level', '--limit']) {
    const i = args.indexOf(flag);
    if (i !== -1) {
      opts[flag.slice(2)] = args[i + 1];
      args.splice(i, 2);
    }
  }

  const boolFlags = ['--ignore-case'];
  for (const flag of boolFlags) {
    const i = args.indexOf(flag);
    if (i !== -1) {
      opts[flag.slice(2)] = true;
      args.splice(i, 1);
    }
  }

  return { command: args[0] ?? 'status', rest: args.slice(1), opts };
}

async function main() {
  const { command, rest, opts } = parseArgs(process.argv);

  const commands = {
    status:   () => cmdStatus(opts),
    targets:  () => cmdTargets(opts),
    eval:     () => cmdEval(rest.join(' '), opts),
    errors:   () => cmdErrors(opts),
    logs:     () => cmdLogs(opts),
    react:    () => cmdReact(opts),
    styles:   () => cmdStyles(rest[0], opts),
    webpack:  () => cmdWebpack(rest[0], opts),
    navigate: () => cmdNavigate(rest[0], opts),
    page:     () => cmdPage(opts),
    popups:   () => cmdPopups(opts),
    module:   () => cmdModule(rest[0], opts),
    menu:     () => cmdMenu(rest[0], opts),
    stores:   () => cmdStores(opts),
    help:     () => { cmdHelp(); },
  };

  const fn = commands[command];
  if (!fn) {
    console.error(`Unknown command: ${command}`);
    console.error(`Available: ${Object.keys(commands).join(', ')}`);
    process.exit(1);
  }

  await fn();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
