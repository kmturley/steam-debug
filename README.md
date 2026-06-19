# steam-debug

A **Claude skill** for debugging the running **Steam Desktop App** via Chrome DevTools Protocol (CDP). It gives Claude the ability to inspect, evaluate, and manipulate the Steam UI at runtime — reading React component trees, searching webpack modules, checking CSS, navigating between pages, and streaming live logs — without any manual browser DevTools setup.

Steam is built on Chromium Embedded Framework (CEF). With debug flags enabled it exposes the same WebSocket protocol as browser DevTools. The bundled `steam-debug.mjs` script wraps that protocol into a set of focused CLI commands that Claude invokes on your behalf.

The CLI can also be used directly from a terminal for one-off queries or scripting.

Works on macOS, Linux, Windows, and Steam Deck.

---

## Using with Claude

Install the skill by placing this directory under `~/.claude/skills/steam-debug/`. Claude Code picks it up automatically via `SKILL.md`.

Once installed, describe your Steam debugging task in plain language and Claude will choose the right commands, interpret the output, and guide you through the investigation:

> *"Why is the Quick Access Menu not rendering correctly?"*
> *"What React version is Steam using?"*
> *"Find the webpack module that defines the DialogButton component."*
> *"Navigate to the downloads page and show me the current route."*

Claude uses `steam-debug.mjs` as its tool and `SKILL.md` as its reference guide. You do not need to know the commands — though they are documented below if you want to run them directly.

---

## Requirements

- **Node.js 22+** — uses built-in `WebSocket` and `fetch` (no npm install)
- **Steam** — launched with `-cef-enable-debugging` (see below)
- **Chrome** — for the DevTools UI (`chrome://inspect`), not required for the CLI or Claude

---

## Launch Steam in Debug Mode

Kill any running Steam instance first — a running instance silently ignores new launch flags.

```bash
# macOS
pkill -f Steam

# Linux
pkill steam

# Windows
taskkill /IM steam.exe /F
```

Then launch with debug flags:

| Platform | Command |
|----------|---------|
| macOS | `open -a Steam --args -dev -windowed -cef-enable-debugging -gamepadui` |
| Linux | `steam -dev -windowed -cef-enable-debugging -gamepadui` |
| Windows | `steam.exe -dev -windowed -cef-enable-debugging -gamepadui` |
| Steam Deck | Settings → System → Developer → CEF Remote Debugging |

**What each flag does:**

| Flag | Effect |
|------|--------|
| `-dev` | Developer mode — relaxed security, verbose logging |
| `-windowed` | Run as a window instead of fullscreen |
| `-cef-enable-debugging` | Exposes CDP on port 8080 |
| `-gamepadui` | Forces Big Picture Mode (similar to SteamOS UI on Steam Deck) |

Omit `-gamepadui` when debugging the regular desktop Steam UI.

**Verify it's working:**
```bash
curl http://localhost:8080/json/version
# → {"Browser": "Chrome/...", ...}
```

---

## Usage

```bash
# Shorthand alias (optional)
S=~/.claude/skills/steam-debug/steam-debug.mjs

node $S <command> [options]
node $S help
```

---

## Commands

| Command | Description |
|---------|-------------|
| `status` | CDP endpoint, target count, webpack module count, Steam init state |
| `targets` | All CDP targets with title, URL, and WebSocket URL |
| `eval <expr>` | Evaluate a JS expression; promises auto-awaited; objects returned as JSON |
| `errors` | Install a `console.error` capture shim + print captured calls |
| `logs` | Stream live `console.*` + network/security events until Ctrl+C |
| `react` | React version, webpack module ID, fiber tree stats |
| `styles <selector>` | Tag, class, layout rect, computed styles, resolved CSS custom properties |
| `webpack <pattern>` | Search all webpack module sources for a string |
| `module <id>` | Dump full source of a webpack module by numeric ID |
| `navigate <page>` | Navigate Big Picture Mode to a named page |
| `page` | Current BPM route, recent history, open menu state |
| `menu <name>` | Open or close the Quick Access Menu or Main Menu overlay |
| `popups` | List all popup windows tracked by `g_PopupManager` |
| `stores` | Inspect `window.SteamUIStore` sub-store names and their properties |

---

## Options

| Option | Commands | Description |
|--------|----------|-------------|
| `--target <name>` | `eval`, `errors`, `logs`, `styles`, `module` | Named target window (see [Targets](#targets) below) or any title substring. Default: `SharedJSContext` |
| `--port <n>` | All | Override CDP port. Default: tries 8080 then 9222 |
| `--level all\|warn\|error` | `logs` | Filter log level. Default: `all` |
| `--limit <n>` | `webpack` | Max number of matches to return. Default: `10` |
| `--ignore-case` | `webpack` | Case-insensitive pattern matching |

---

## Targets

Steam runs multiple CEF renderer processes. Each is a separate CDP target — like separate browser tabs.

| Name | Matches | Has webpack | Use for |
|------|---------|-------------|---------|
| `SharedJSContext` | `steamloopback.host/routes/` | ✓ | All JS, webpack, React — **start here** |
| `BigPicture` | `Steam Big Picture Mode` | ✓ | Gamepad UI layout and navigation |
| `QuickAccess` | `QuickAccess_uid*` | ✗ | Quick Access Menu HTML/CSS |
| `MainMenu` | `MainMenu_uid*` | ✗ | Main Menu HTML/CSS |
| `NotificationToasts` | `notificationtoasts_uid*` | ✗ | Toast notification HTML/CSS |
| `Store` | title includes "store" | ✓ | Steam Store page |

`QuickAccess`, `MainMenu`, and `NotificationToasts` are **always loaded** from startup — they persist even when the overlay is closed. You can inspect them at any time without opening them first.

---

## Examples

```bash
# Check if Steam is ready
node $S status

# List all open CEF windows
node $S targets

# Run arbitrary JS in SharedJSContext
node $S eval "window.App?.BFinishedInitStageOne()"
node $S eval "({ version: window.webpackChunksteamui?.length })"

# Stream errors only
node $S logs --level error

# Navigate Big Picture Mode
node $S navigate library
node $S navigate downloads
node $S navigate steam://open/friends

# Check current page and open menu
node $S page

# Open/close Quick Access Menu
node $S menu QuickAccess
node $S menu Close

# Open Main Menu overlay on the QuickAccess target
node $S styles "body" --target QuickAccess

# Find a component in the webpack bundle
node $S webpack "DialogButton"
node $S webpack "dialogbutton" --ignore-case
node $S webpack "useState" --limit 3

# Dump the React module source (get ID from react command)
node $S react
node $S module <moduleId>

# Inspect Steam's MobX store tree
node $S stores

# Two-phase error capture
node $S errors            # installs shim
# ... reproduce the bug ...
node $S errors            # prints what was captured

# Reset error buffer
node $S eval "window.__steam_debug_errors = []"

# Inspect computed styles + CSS custom properties on an element
node $S styles ".SomeComponent"
node $S styles "#QuickAccess-Menu" --target QuickAccess
```

---

## CDP Targets — Browser DevTools

To use the full Chrome DevTools UI (Elements, Sources, Network):

```
chrome://inspect → Configure → localhost:8080 → Inspect
```

Use **Chrome** specifically — Firefox DevTools does not speak CDP.

---

## Remote Debugging — Steam Deck

Enable on device: **Settings → System → Developer → CEF Remote Debugging**

```bash
# SSH tunnel — lets you use the script normally
ssh -L 8080:localhost:8080 deck@steamdeck

# Then in a separate terminal:
node $S status
```

---

## Testing

The smoke test suite auto-launches Steam in debug mode if it is not already running.

```bash
node --test test/smoke.mjs
```

If Steam is running **without** `-cef-enable-debugging`, kill it first:

```bash
# macOS
pkill -f steam_osx

# Linux
pkill steam
```

The suite covers: CDP reachability, `eval`, `navigate`+`page` round-trip, `menu`+`page` round-trip, all named target enum names, `react`, `styles`, `popups`, `targets`, `webpack` (with `--limit` and `--ignore-case`), `module`, `errors` (shim install + reset), and `stores`.

---

## How It Works

Steam's CEF runtime exposes a standard Chrome DevTools Protocol WebSocket endpoint on port 8080. `steam-debug.mjs` connects to this endpoint, sends `Runtime.evaluate` commands, and parses the results — the same protocol Chrome DevTools uses internally. The script uses only Node.js 22+ built-ins (`WebSocket`, `fetch`) with no external dependencies.

Key globals available in `SharedJSContext`:

```js
window.webpackChunksteamui          // Steam's webpack chunk array
window.App?.BFinishedInitStageOne() // true once Steam is fully initialised
window.SteamUIStore                 // MobX store tree (navigation, menus, windows)
window.SteamClient                  // Native Steam client API
window.g_PopupManager               // Popup window registry
window.__steam_debug_wr             // Cached webpack require (set by this tool)
```

---

## License

[CC0 1.0 Universal](LICENSE) — public domain dedication.
