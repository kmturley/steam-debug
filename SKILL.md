---
name: steam-debug
description: Debugging and investigation guide for the Steam Desktop App (CEF/CDP runtime) on any OS. Use when injecting into, inspecting, or diagnosing issues inside the Steam UI runtime — JavaScript errors, React issues, webpack module search, CDP targets, styling problems, or remote Steam Deck debugging. Like opening browser DevTools, but the "browser" is the Steam process.
---

# Steam Desktop App — Debug & Investigation

Steam is built on Chromium Embedded Framework (CEF). With debug flags it exposes a Chrome DevTools Protocol (CDP) endpoint — the same protocol as browser DevTools. The bundled `steam-debug.mjs` wraps that protocol into a CLI. **Requires Node.js 22+ and Chrome for DevTools UI.**

## Start Here — Pick Your Command

| Goal | Command |
|------|---------|
| Is Steam running and ready? | `status` |
| What renderer windows are open? | `targets` |
| Current BPM page + open menu | `page` |
| Navigate BPM to a page | `navigate <home\|settings\|downloads\|…>` |
| Open or close QAM / Main Menu | `menu <QuickAccess\|MainMenu\|Close>` |
| List g_PopupManager popup windows | `popups` |
| Stream live frontend logs (console.log/warn/error + network) | `logs [--level all\|warn\|error]` |
| View backend process logs | Launch Steam in a terminal — see **Log Sources** below |
| Read a JS value / run a snippet | `eval <expr>` |
| Capture runtime errors (point-in-time) | `errors` (run before *and* after reproducing) |
| Find React version + component tree stats | `react` |
| Computed CSS on an element | `styles <selector> [--target <window>]` |
| Find where a component lives in the bundle | `webpack <name> [--ignore-case] [--limit N]` |
| Dump full source of a webpack module | `module <id>` |
| Inspect SteamUIStore sub-stores + properties | `stores` |

---

## Launch Steam in Debug Mode

**Kill any running Steam first** — a running instance ignores new launch arguments silently.

```bash
# macOS:   pkill -f Steam
# Linux:   pkill steam
# Windows: taskkill /IM steam.exe /F
```

Then launch with debug flags:

| Platform | Command |
|----------|---------|
| macOS | `open -a Steam --args -dev -windowed -cef-enable-debugging -gamepadui` |
| Linux | `steam -dev -windowed -cef-enable-debugging -gamepadui` |
| Windows | `steam.exe -dev -windowed -cef-enable-debugging -gamepadui` |
| Steam Deck | Instruct user to enable remote debugging: Settings → System → Developer → CEF Remote Debugging |

**What each flag does:**

| Flag | Effect | Required? |
|------|--------|-----------|
| `-dev` | Developer mode — relaxed security, verbose logging | Yes |
| `-windowed` | Run as a window instead of fullscreen | Recommended |
| `-cef-enable-debugging` | Exposes CDP on port 8080 | **Yes** |
| `-gamepadui` | Forces Big Picture / Steam Deck UI mode | Recommended for debugging Big Picture Mode which is similar to SteamOS UI on Steam Deck |

Omit `-gamepadui` when debugging the regular desktop Steam UI (library, store, settings) — it loads a completely different UI.

**Verify Steam is running:**
```bash
curl http://localhost:8080/json/version
```
A JSON response with `"Browser": "Chrome/..."` means Steam is running and debug mode is enabled correctly.

---

## Command Reference

```bash
S=~/.claude/skills/steam-debug/steam-debug.mjs
# Windows PowerShell: $S = "$env:USERPROFILE\.claude\skills\steam-debug\steam-debug.mjs"
```

| Command | Description |
|---------|-------------|
| `node $S status` | CDP endpoint, target count, webpack module count, Steam init state |
| `node $S targets` | All CDP targets with title, URL, WebSocket URL |
| `node $S eval <expr>` | Evaluate JS; promises auto-awaited; objects returned as JSON |
| `node $S errors` | Install error-capture shim + print captured `console.error` calls |
| `node $S logs` | Stream live `console.*` + network/security events until Ctrl+C |
| `node $S react` | React version, module ID, fiber tree stats |
| `node $S styles <sel>` | Tag, class, layout rect, computed styles, resolved CSS custom properties |
| `node $S webpack <pat>` | Search all webpack module sources (default limit 10) |
| `node $S module <id>` | Dump full source of a webpack module by numeric ID |
| `node $S stores` | Inspect `window.SteamUIStore` sub-store names and their properties |

**Options (apply to most commands):**
- `--target <name>` — named target (`SharedJSContext`, `BigPicture`, `QuickAccess`, `MainMenu`, `NotificationToasts`, `Store`) or any title substring (default: SharedJSContext)
- `--port <n>` — override CDP port (default: tries 8080 then 9222)
- `--level all|warn|error` — filter level for `logs` command (default: `all`)
- `--limit <n>` — max results for `webpack` command (default: 10)
- `--ignore-case` — case-insensitive pattern for `webpack` command

### eval — notes
- Promises are automatically awaited before the result is returned
- Objects/arrays come back as JSON; DOM nodes and functions return `(object)` or `(function)`
- Multi-line: wrap in an IIFE: `eval "(() => { const x = 1; return x + 1; })()"`

### errors — two-phase workflow
1. **Run `errors` first** — installs the capture shim into the running page
2. **Reproduce the problem**
3. **Run `errors` again** — now shows what was captured

The shim does **not** survive a Steam restart. Clear the buffer between test runs:
```bash
node $S eval "window.__steam_debug_errors = []"
```

### logs — what it captures
`logs` streams two CDP channels simultaneously:
- **`Runtime.consoleAPICalled`** — every `console.log`, `console.warn`, `console.error`, `console.info` from page JS
- **`Log.entryAdded`** — browser-level events: network failures, CSP violations, security blocks, worker crashes

Output format: `[LEVEL] (source-file) message`

```bash
node $S logs                          # all levels, SharedJSContext
node $S logs --level error            # errors only
node $S logs --target QuickAccess     # overlay window logs
node $S logs 2>/dev/null | grep CSP   # pipe and filter
```

### react — output fields
- `moduleId` — webpack ID of the React module; use `eval "wr(<id>).toString()"` to dump source
- `fiberTreeFound: false` — no React root mounted yet (UI still loading)
- `maxFiberDepth` > 200 suggests deeply nested components worth investigating

### webpack — notes
- Results are capped at 10 matches. To dump the full source of a matched module:
```bash
node $S module <id>
```

---

## Log Sources

Steam has two independent log streams. Check both when diagnosing an issue — backend failures often don't surface in the frontend and vice versa.

### Backend — Steam process stdio

When launched with `-dev`, Steam writes diagnostic output (service errors, network activity, resource loading, crash info) directly to the terminal's stdout/stderr. This is the first place to look for crashes, blocked connections, and TLS/certificate failures.

**To see backend logs, launch Steam directly in a terminal** (not via GUI or the `open` command):

| Platform | Command |
|----------|---------|
| macOS | `/Applications/Steam.app/Contents/MacOS/steam_osx -dev -windowed -cef-enable-debugging -gamepadui 2>&1` |
| Linux | `steam -dev -windowed -cef-enable-debugging -gamepadui 2>&1` |
| Windows | Run `steam.exe -dev -windowed -cef-enable-debugging -gamepadui` from a Command Prompt |

Save to file while watching live:
```bash
# macOS / Linux
/Applications/Steam.app/Contents/MacOS/steam_osx -dev -windowed -cef-enable-debugging -gamepadui 2>&1 | tee steam.log
```

**Key patterns to watch in error logs:**

| Pattern | Meaning |
|---------|---------|
| `TRANSPORT ERROR` / `WebSocket error` | Backend WebSocket connection failed |
| `SSL` / `certificate` / `ERR_CERT` | TLS handshake or cert trust failure |
| `Failed to load` / `HTTP 4xx/5xx` | Resource blocked or missing |
| `CSP` / `Content-Security-Policy` | Frontend resource blocked by Steam's CSP |
| `[S_API]` / `[Steamworks]` | Steamworks API errors |
| `crash` / `assert` / `SIGSEGV` | Process-level crash |

### Frontend — SharedJSContext console

The frontend log stream is everything printed via `console.log/warn/error` in the SharedJSContext page, plus browser-level events (network failures, CSP blocks, security errors). This is where injected plugin code, Steam's own UI framework, and React errors appear.

**Stream live with the `logs` command:**
```bash
node $S logs                    # all output
node $S logs --level error      # errors + network failures only
node $S logs --level warn       # errors + warnings
```

**Or use Chrome DevTools** — connect to SharedJSContext via `chrome://inspect`, open the **Console** panel. This gives the same output with filtering and source-link navigation.

**Key patterns to watch in frontend logs:**

| Pattern | Meaning |
|---------|---------|
| `Failed to load resource` | Asset blocked (check URL and CSP) |
| `Content Security Policy` | Resource blocked by Steam's CSP headers |
| `WebSocket` / `wss://` errors | Backend connection failure from frontend |
| `React error #NNN` | Minified React error — decode with `webpack "react.dev/errors"` |
| `TypeError` / `ReferenceError` | JS runtime error in page code |
| `[your-prefix]` | Your own injected code's log output |

---

## CDP Targets

Steam runs multiple CEF renderer processes — each is a separate CDP target, like separate browser tabs. Targets with `about:blank?browserviewpopup` are **isolated renderers with no webpack and no shared React** — use `styles` and Chrome DevTools Elements panel there, not `eval` for JS logic.

| Target | URL pattern | Webpack | Lifetime | Use for |
|--------|-------------|---------|----------|---------|
| `SharedJSContext` | `steamloopback.host/routes/` | ✓ | Always | All JS, webpack, React — **start here** |
| `Steam Big Picture Mode` | `steamloopback.host/routes/` | ✓ | Always | gamepadui layout and navigation |
| `QuickAccess_uid*` | `about:blank?browserviewpopup` | ✗ | Always (shown/hidden) | QAM overlay HTML/CSS |
| `MainMenu_uid*` | `about:blank?browserviewpopup` | ✗ | Always (shown/hidden) | Main menu HTML/CSS |
| `notificationtoasts_uid*` | `about:blank?browserviewpopup` | ✗ | Always (shown/hidden) | Toast / notification HTML/CSS |

Browser-view popup targets (`about:blank?browserviewpopup`) are **always present** from startup — they do not appear or disappear when you open/close the QAM or Main Menu. Their documents persist and can be inspected at any time.

**Open targets in Chrome DevTools:**
```
chrome://inspect → Configure → localhost:8080 → Inspect
```
Use **Chrome** specifically — Firefox DevTools does not speak CDP.

---

## Navigating to Steam Features

**Always navigate to the target feature before inspecting the DOM, console, or CSS.** Elements are only in the DOM while the feature is visible — inspecting the wrong screen gives misleading results.

Steam has two navigation types: **page routes** (loaded in the main BPM window) and **popup overlays** (separate windows opened via JS methods).

### Page Routes — main BPM window

| Feature | URL path | Navigator method |
|---------|----------|-----------------|
| Library home | `/routes/library/home` | `Navigator.Home()` |
| App page | `/routes/gamepage/<appId>` | `Navigator.App(appId)` |
| Downloads | `/routes/downloads` | `Navigator.Downloads()` |
| Settings | `/routes/settings` | `Navigator.Settings()` |
| Account | `/routes/account` | `Navigator.Account()` |
| Chat | `/routes/chat` | `Navigator.Chat()` |
| Game servers | `/routes/gameservers` | `Navigator.GameServers()` |

Page content renders in the `Steam Big Picture Mode` CDP target. Inspect that target after navigating.

**Navigate via CDP:**
```bash
node $S navigate home
node $S navigate settings
node $S navigate downloads
node $S navigate account
node $S navigate chat
node $S navigate steam://open/bigpicture   # any steam:// URL also accepted
```

**Check current page:**
```bash
node $S page    # shows current path, recent history, open menu (none/MainMenu/QAM)
```

### Popup Overlays — separate popup windows

These are separate CDP targets. Because browser-view popups are always loaded (see CDP Targets above), you can inspect them at any time — you do not need to open the popup first to inspect its DOM or styles.

| Feature | CDP target name | How to open (for visual inspection) |
|---------|----------------|--------------------------------------|
| Quick Access Menu (QAM) | `QuickAccess_uid*` | QAM button on controller / Steam Deck right-side button |
| Main Menu (hamburger) | `MainMenu_uid*` | STEAM / home button on controller |

**Open/close overlays:**
```bash
node $S menu QuickAccess    # open Quick Access Menu
node $S menu MainMenu       # open Main Menu
node $S menu Close          # close all menus
```

After opening, inspect the overlay's own CDP target:
```bash
node $S styles "body" --target QuickAccess   # QAM styles
node $S styles "body" --target MainMenu      # Main Menu styles
```

> **Note:** QAM and MainMenu targets have no webpack — use `styles` and Chrome DevTools Elements panel there, not `eval` for JS logic.

### Verify what's currently visible

Before inspecting, confirm the right route and popup state:
```bash
node $S page     # current BPM path, recent history, open menu (none/MainMenu/QAM)
node $S popups   # popup windows tracked by g_PopupManager (key, title, URL)
```

---

## Debugging Recipes

### Reverse-engineer a Steam UI component
```bash
node $S webpack "ComponentName"          # find module IDs
node $S module <id>                      # dump full module source
node $S styles "<selector>" --target <window>  # get class names + computed styles
```
Steam uses obfuscated class names (e.g. `_1zGXSZJ-SkOi-pxNGiYxU`). Find the CSS module via `webpack`, copy the class name into your component.

### JS / boot errors

**Symptoms:** Module not loading, runtime error on startup, global state missing.

```bash
node $S logs --level error      # start here — stream errors from both CDP channels
node $S status                  # check webpack loaded + Steam init done
node $S errors                  # point-in-time error dump (install shim first, then reproduce)
node $S eval "document.readyState"
node $S eval "typeof window.webpackChunksteamui"
```

Key globals in SharedJSContext:
```js
window.webpackChunksteamui          // Steam's webpack chunk array — must exist
window.App?.BFinishedInitStageOne() // true once Steam is fully initialised
```

| Symptom | Cause |
|---------|-------|
| Connection refused on port 8080 | Steam not launched with debug flags, or old instance still running |
| `webpackChunksteamui` is undefined | Steam still loading — wait and retry |
| `status` hangs or times out | SharedJSContext not yet initialised — run `targets` to see what is available |
| `window.App` missing | UI context not yet fully loaded |

### React errors

**Symptoms:** Component not rendering, `Minified React error #NNN`, hook violation.

```bash
node $S react                        # version, module ID, fiber tree stats
node $S webpack "react.dev/errors"   # find error message formatter in bundle
```

Note: Steam's minified bundle strips internal React strings. **`window.React` does not exist as a global** — React lives only inside webpack. Use the `react` command or `webpack "Symbol.for(\"react."` to locate it.

**Common React error codes:**

| Error | Meaning |
|-------|---------|
| `#321` | Component called as a plain function instead of via `createElement` |
| `#310` | Hook called conditionally — must run same number of times every render |
| `#130` | Invalid element type passed to `createElement` |
| `#185` | Hook called outside a React function component |

**Decode a minified error — get the formatter from the bundle:**
```bash
node $S webpack "react.dev/errors"   # find the module ID
node $S module <id>                  # read the error text lookup function
```

### Styling issues

**Symptoms:** Wrong colours, broken layout, invisible text, clipped content.

```bash
node $S styles "body"                          # CSS custom properties (theme vars) in cssVars field
node $S styles ".MyComponent" --target QuickAccess   # computed styles on overlay
node $S webpack "DialogButton"                 # find obfuscated class names
```

`styles` output fields: `tagName`, `className`, `rect` (layout bounds in px), `styles` (computed properties), `cssVars` (first 10 rules containing `--`).

| Symptom | Cause |
|---------|-------|
| Wrong dark/light mode colours | Use `styles body` → look at `cssVars` for `--` custom properties that change per theme |
| Content clipped | Check `overflow` in `styles` output — QAM panel scrolls vertically |
| Invisible text | Check `color` vs `background` in `styles` output for contrast |

### CSS rendering gotchas — BPM window

These apply when injecting CSS into the `Steam Big Picture Mode` window:

**`outline` can be invisible on full-viewport elements.**
CEF does not render outlines on elements whose border box fills the entire viewport.
- Fix: use `box-shadow: inset 0 0 0 3px <color>` instead (see below).

**`box-shadow: inset` is invisible on full-viewport `display: flex` containers.**
Inset shadows work on full-viewport block elements, but on flex containers the flex children (which have opaque backgrounds) are painted on top of the parent's background layer, hiding the shadow. `outline` has the same problem. Changing `display: flex` → `display: block` makes the shadow visible but breaks layout.
- Fix: target the direct children instead of the flex container using a child selector: `parent > child { box-shadow: inset 0 0 0 3px <color> }`. If the children are block elements the shadow should be visible on them.

**⚠️ Do not use `::after { position: fixed; pointer-events: none }` as a workaround.**
Even though `pointer-events: none` prevents mouse events, Steam's gamepad input routing does NOT respect it. A `position: fixed` overlay will block gamepad scrolling on the targeted page even when the element appears inert.

**Decision tree for injecting a visible highlight:**

```
Is the element display: flex AND full-viewport (1280×800)?
  YES → target its children: selector > .Panel { box-shadow: inset 0 0 0 3px color }
  NO  → use box-shadow: inset 0 0 0 3px color on the element directly
         (outline also works if the element is not full-viewport)
```

**Diagnosing highlight not showing — quick checklist:**
1. `node $S styles "<selector>"` → check `rect`. If `width: 1280, height: 800` it's full-viewport → `outline` won't work.
2. Check `display`. If `flex` + full-viewport → `box-shadow: inset` also won't work on the element itself.
3. Temporarily change `display` to `block` to confirm: if shadow appears, flex children are covering it.
4. Fix: use `selector > .Panel` to target children instead of the flex root.

**`filter` on BPM `body` makes QAM and MainMenu browser-view popups invisible.**
CSS `filter` promotes `body` to its own GPU compositing layer. In CEF, this layer renders on top of the browser-view popup windows (QuickAccess, MainMenu), hiding them completely. Users also lose access to Settings dialogs since fixed-position overlays break under a filtered body.
- **Never use `filter`, `transform`, `will-change`, or `opacity < 1` on BPM `body` or any full-viewport ancestor** if you want popups to remain visible.
- Safe alternatives: `::after` overlay (above), `font-family`, `color`, `background-color`.

**`background-color` is visible even on full-viewport flex containers** (painted before children, not covered by them).

### Browser-view popup windows — always loaded

`QuickAccess_uid*`, `MainMenu_uid*`, and `notificationtoasts_uid*` are **always loaded as CDP targets** from Steam startup. They are shown and hidden, never created or destroyed on open/close. Their documents persist even when the popup is not visible.

```bash
node $S targets    # both QuickAccess_uid2 and MainMenu_uid2 appear even before opening them
node $S styles "#QuickAccess-Menu" --target QuickAccess   # inspect QAM content any time
```

**Accessing the QAM/MainMenu document from injected JS (same-origin access):**
From SharedJSContext or BPM (both at `steamloopback.host`), you can reach the QAM document via the named-window mechanism since they share a browsing context group. The window name is `QuickAccess_uid<BPMBrowserID>` (typically `QuickAccess_uid2`).

⚠️ **Phantom-window trap:** Calling `window.open('', 'QuickAccess_uid2')` when the QAM is NOT loaded creates a **new blank window** that claims the name. Steam then fails to open the real QAM popup (the name is already taken). Always guard against this:
```javascript
const win = window.open('', 'QuickAccess_uid2');
if (win && win.document?.title === 'QuickAccess_uid2') {
  // Window exists with content — safe to use
  const doc = win.document;
} else if (win) {
  // We accidentally created a blank phantom — close it immediately
  win.close();
}
```

**Key selectors confirmed visible in QAM document:**
```css
#QuickAccess-Menu          /* 854×720 panel — outline works here */
#QuickAccess-NA            /* position: absolute, top/left: 0 — the BasicUI root */
```

**g_PopupManager does not contain QAM or MainMenu** on macOS BPM. Only `SP BPM_uid0` appears. The BPM BrowserID is 2, so the QAM window name is always `QuickAccess_uid2` and MainMenu is `MainMenu_uid2`.

---

## Remote Debugging — Steam Deck

Enable on device: **Settings → System → Developer → CEF Remote Debugging**

**Easiest approach — SSH tunnel** (lets you use the debug script normally):
```bash
ssh -L 8080:localhost:8080 deck@steamdeck
# In a separate terminal, now use the script as normal:
node $S status
```

**Without SSH** — probe manually then connect via Chrome:
```bash
curl http://steamdeck:8080/json/list    # or :8081
# If both fail, ask the user for the device IP
```
Then open: `chrome://inspect` → Configure → add `steamdeck:8080`.
