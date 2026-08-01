# Troubleshooting

Log sources, error-pattern tables, and decoding procedures. For connection and readiness
problems, use the Failure Ladder in SKILL.md §6 first.

---

## Two independent log streams

Steam logs in two places that do not overlap. A backend failure often never reaches the frontend
console, and vice versa. When a cause is not obvious, check both.

### Frontend — CEF console

Everything from `console.*` in a renderer, plus browser-level events (failed requests, CSP
blocks, security errors). This is where injected code, Steam's UI framework, and React errors
appear.

```bash
node $S logs                    # live, all levels
node $S logs --level error      # errors and network failures only
node $S logs --target QuickAccess
```

Or use Chrome DevTools (`chrome://inspect`) for filtering and source navigation.

| Pattern | Meaning |
|---|---|
| `Failed to load resource` | Asset blocked or missing — check the URL and CSP |
| `Content Security Policy` | Blocked by Steam's CSP headers |
| `WebSocket` / `wss://` errors | Frontend lost its backend connection |
| `Minified React error #NNN` | React error — decode below |
| `TypeError` / `ReferenceError` | JS runtime error in page code |
| your own log prefix | Injected plugin output — always prefix it |

### Backend — Steam process stdio

With `-dev`, Steam writes service errors, network activity, resource loading, and crash info to
stdout/stderr. First place to look for crashes, blocked connections, and TLS failures.

This requires launching Steam **from a terminal** — output is lost when started from a GUI or via
`open`:

| Platform | Command |
|---|---|
| macOS | `/Applications/Steam.app/Contents/MacOS/steam_osx -dev -windowed -cef-enable-debugging -gamepadui 2>&1` |
| Linux | `steam -dev -windowed -cef-enable-debugging -gamepadui 2>&1` |
| Windows | Run `steam.exe -dev -windowed -cef-enable-debugging -gamepadui` from a Command Prompt |

Watch live and keep a copy:

```bash
/Applications/Steam.app/Contents/MacOS/steam_osx -dev -windowed -cef-enable-debugging -gamepadui 2>&1 | tee steam.log
```

| Pattern | Meaning |
|---|---|
| `TRANSPORT ERROR` / `WebSocket error` | Backend WebSocket connection failed |
| `SSL` / `certificate` / `ERR_CERT` | TLS handshake or trust failure |
| `Failed to load` / `HTTP 4xx/5xx` | Resource blocked or missing |
| `CSP` / `Content-Security-Policy` | Frontend resource blocked |
| `[S_API]` / `[Steamworks]` | Steamworks API error |
| `crash` / `assert` / `SIGSEGV` | Process-level crash |

Switching to terminal launch means restarting Steam — get consent first (R9).

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
| UI renders but looks wrong | Frontend console + `styles` |
| UI blank or partly missing | Frontend console errors, then `react` |
| Steam won't start or crashes | Backend stdio |
| Downloads or logins fail | Backend stdio (TLS, transport) |
| Injected code did nothing | Frontend console, then verify the target (R3) |
| Command returns `{"error":…}` | SKILL.md §6, not the logs |
