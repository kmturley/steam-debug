# Troubleshooting

Log sources, error-pattern tables, and decoding procedures. For connection and readiness
problems, use the Failure Ladder in SKILL.md §6 first.

---

## Three independent log streams

Steam logs in three places that do not overlap. A backend failure often never reaches the
frontend console, and vice versa. `logs` reads all three at once by default; `--source` narrows
to one.

```bash
node $S logs                        # all three, live
node $S logs --source backend       # Steam's own output only
node $S logs --level error          # errors from every stream
```

Every line is tagged, so the stream a message came from is never in doubt:

```
[ERROR] Uncaught TypeError: …                  ← console  (page JS)
[ERROR] (theme.css) Failed to load resource    ← browser  (CEF)
[ERROR] (backend) RaiseJSException: …          ← backend  (Steam itself)
```

### `console` — page JavaScript

Everything from `console.*` in a renderer. This is where injected code, Steam's UI framework, and
React errors appear.

| Pattern | Meaning |
|---|---|
| `Minified React error #NNN` | React error — decode below |
| `TypeError` / `ReferenceError` | JS runtime error in page code |
| your own log prefix | Injected plugin output — always prefix it |

### `browser` — CEF itself

Browser-level events the page never sees: failed requests, CSP blocks, security errors.

| Pattern | Meaning |
|---|---|
| `Failed to load resource` | Asset blocked or missing — check the URL and CSP |
| `Content Security Policy` | Blocked by Steam's CSP headers |
| `WebSocket` / `wss://` errors | Frontend lost its backend connection |

### `backend` — Steam's own spew

Steam's internal output: the same stream you would see running Steam from a terminal with `-dev`,
delivered over CDP through `SteamClient.Console.RegisterForSpewOutput`. No terminal launch, no
SSH, and it works identically on a Steam Deck over `--host`.

**This is the only stream that names the Steam component behind a failure.** A `SteamClient` call
made with the wrong arguments succeeds on the JS side and is rejected in the backend — without
this stream the symptom is "my code ran and nothing happened":

```
[ERROR] (backend) RaiseJSException: Method call failed: Downloads.EnableAllDownloads requires 2 arguments; only 1 given
```

| Pattern | Meaning |
|---|---|
| `RaiseJSException: Method call failed` | A `SteamClient` call the backend refused — the message names the method and the reason |
| `TRANSPORT ERROR` / `WebSocket error` | Backend connection failed |
| `SSL` / `certificate` / `ERR_CERT` | TLS handshake or trust failure |
| `[S_API]` / `[Steamworks]` | Steamworks API error |
| `assert` (spew type `assert`) | An internal invariant failed — often precedes a crash |

Only `SharedJSContext` carries `SteamClient`, so `logs --source backend --target QuickAccess`
has nothing to read. Under `--source all` the backend channel is skipped with a note; asking for
it explicitly on such a target is an error. `--source` takes exactly one value.

`inject` watches this stream automatically for the moment it applies your file, and reports any
backend errors in its `backendErrors` field.

### Asking Steam directly

`console` runs a command in Steam's own developer console and returns what the backend says:

```bash
node $S console list 'log|dump'   # what this build supports
node $S console developer         # read a convar
node $S console log_ipc 1         # turn on IPC tracing, then read it with logs
node $S console app_status 570    # per-app state straight from the client
```

The command table is build-specific — enumerate it with `console list` rather than assuming a
command exists.

---

## Startup and JavaScript errors

Symptoms: module not loading, error on startup, global state missing.

```bash
node $S logs --level error                       # start here
node $S status                                   # webpack loaded? init done?
node $S eval 'document.readyState'
node $S eval 'typeof window.webpackChunksteamui'
node $S eval 'window.App?.BFinishedInitStageOne()'
```

| Symptom | Cause |
|---|---|
| Connection refused on 8080 | Not launched with debug flags, or a pre-existing instance ignored them |
| `webpackChunksteamui` undefined | Still loading — wait and retry |
| `status` hangs or times out | `SharedJSContext` not initialised — run `targets` |
| `window.App` missing | UI context not fully loaded |
| Globals missing on a popup target | Expected — only `SharedJSContext` has them |

---

## React errors

Symptoms: component not rendering, `Minified React error #NNN`, hook violation.

```bash
node $S react                        # version, module id, fiber stats
node $S webpack 'react.dev/errors'   # locate the error-message formatter
node $S module <id>                  # read the lookup table
```

Steam ships a production React build, so error text is replaced by codes. There is no
`window.React` global.

| Code | Meaning |
|---|---|
| `#321` | Hook called outside a function component's render |
| `#310` | Hook order changed between renders — usually a conditional hook |
| `#130` | Invalid element type passed to `createElement` — often a bad import |
| `#185` | `setState` loop causing infinite re-render |

Codes are React-version-specific. Confirm the version with `react`, then check the official
decoder at `https://react.dev/errors/<NNN>` rather than trusting the table above.

`fiberTreeFound: false` means no root is mounted yet — the UI is still loading, not broken.
A `maxFiberDepth` above ~200 is normal for Steam's tree.

---

## Styling problems

Symptoms: wrong colours, broken layout, invisible text, clipped content.

```bash
node $S styles 'body' --target BigPicture         # theme vars in cssVars
node $S styles '.MyComponent' --target QuickAccess
node $S classes 'DialogButton'                     # resolve minified class names
```

| Symptom | Cause |
|---|---|
| `{"error": "No element matches"}` | Wrong target or wrong route — check `page`, then `targets` |
| Wrong light/dark colours | Read `cssVars` on `body`; theme is driven by CSS custom properties |
| Content clipped | Check `overflow` — the QAM panel scrolls vertically |
| Invisible text | Compare `color` against `background` |
| Style computed but not visible | CEF paint trap — see `injection.md` § Why paint disappears |

That last row is the one that wastes the most time: `styles` reporting your value proves the rule
matched, not that anything was painted.

---

## Deciding which stream to trust

| Observation | Read this |
|---|---|
| UI renders but looks wrong | `--source console` + `styles` |
| UI blank or partly missing | `--source console`, then `react` |
| Steam won't start or crashes | `--source backend` |
| Downloads or logins fail | `--source backend` (TLS, transport) |
| Injected code ran but nothing happened | `--source backend` — a refused `SteamClient` call reports only there |
| Injected code threw | `--source console`, then verify the target (R3) |
| Command returns `{"error":…}` | SKILL.md §6, not the logs |

---

## When Steam crashes mid-session

A crash takes CDP with it, so nothing can be read from the client afterwards — the only surviving
evidence is what was already streamed out. That is why `watch` keeps the backend stream open: on a
dropped connection it prints the last lines it received and exits 1.

```
CDP connection dropped — Steam crashed, restarted, or closed.

Last 4 backend line(s) before the drop:
  [ERROR] (backend) …
```

Recovery, without a human at the keyboard:

```bash
node $S status                          # exit 1 → the client is gone
node $S restart client --confirm        # relaunches with debugging enabled, waits for ready
node $S inject js plugin.js             # re-apply; nothing survived
```

`restart client` handles an already-crashed client: an unreachable endpoint means there is nothing
to shut down, so it goes straight to launching. It refuses while a game is running or a download
is in progress, and it will not run over `--host` — see `remote.md`.

**Did it restart while you were not looking?** `status` reports `contextStarted`. A different value
between two calls means the UI context was replaced, so every injection is gone even if nothing
else looks different.

### Why `restart client` relaunches rather than asking Steam to

`SteamClient.User.StartRestart()` does restart Steam, but the relaunched process drops
`-cef-enable-debugging` from its arguments — measured on macOS. The client comes back alive and
unreachable, which ends the debugging session. `restart client` therefore shuts Steam down and
launches it again itself, with the Phase 0 flags.

Use `restart js` where it is enough: it restarts only the UI context, keeps the client and CDP
alive, works remotely, and returns in about a second.
