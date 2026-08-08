# steam-debug

A **Claude skill** and standalone CLI for inspecting, debugging, and injecting code into a
running **Steam client** — desktop or Steam Deck — via the Chrome DevTools Protocol (CDP).

Steam's UI is a Chromium Embedded Framework (CEF) app. Launched with debug flags it exposes the
same protocol browser DevTools uses, so the entire Steam UI can be inspected and modified at
runtime like a web page. `steam-debug.mjs` wraps that protocol into focused commands — read React
state, search webpack modules, resolve minified class names, inspect computed CSS, drive
navigation, stream logs, and inject custom CSS/JS.

Built for plugin, theme, and integration development against Steam's UI.

**Works on desktop and Steam Deck.** Same commands for both — a desktop client on macOS, Linux or
Windows, and a Deck over the network via `--host`. Both are exercised by the test suite, and any
command can run against both at once. See [reference/remote.md](reference/remote.md).

**Scope.** This is a debugging and development tool. Injection is per-session and disappears on
reload, by design — it exists so you can try a change and see what happens.

Out of scope: making a change persist or load on startup, packaging or distributing plugins, and
anything that runs unattended inside someone's client. That belongs in a plugin loader. The
boundary is simple — this helps you find out what is going on and try a change; making a change
stick is someone else's job.

---

## Using with Claude

Place this directory at `~/.claude/skills/steam-debug/`. Claude Code discovers it via `SKILL.md`.

Describe the task in plain language; Claude selects the commands, interprets output, and follows
the operating procedure in `SKILL.md`:

> *"Why is my injected CSS not showing up in Big Picture Mode?"*
> *"Find the webpack module that defines the DialogButton component."*
> *"Make the Quick Access Menu background darker."*
> *"Something is throwing a React error on the downloads page — find it."*

`SKILL.md` is a strict SOP rather than a tutorial: it gates work behind a preflight check, fixes
which commands may be used, and defines how to verify a result before reporting it — because the
easiest mistake here is a confident answer drawn from the wrong window, a stale route, or a style
that computed but never painted.

---

## Requirements

- **Node.js 22+** — uses built-in `WebSocket` and `fetch`, no dependencies
- **A Steam client with CDP enabled** — either:
  - desktop, launched with `-cef-enable-debugging` (see below), or
  - a Steam Deck with Settings → System → Developer → **CEF Remote Debugging**, reachable on
    your network. Address it with `--host`; SteamOS serves CDP on port 8081.
- **Chrome** — optional, only for the interactive DevTools UI

---

## Launch Steam in debug mode

Launch flags are read **only at startup**. A already-running instance silently ignores them, so
it must be closed first — note that this drops in-progress downloads and running games.

```bash
# macOS
pkill -f Steam
# Linux
pkill steam
# Windows
taskkill /IM steam.exe /F
```

| Platform | Command |
|---|---|
| macOS | `open -a Steam --args -dev -windowed -cef-enable-debugging -gamepadui` |
| Linux | `steam -dev -windowed -cef-enable-debugging -gamepadui` |
| Windows | `steam.exe -dev -windowed -cef-enable-debugging -gamepadui` |
| Steam Deck | Settings → System → Developer → CEF Remote Debugging |

| Flag | Effect |
|---|---|
| `-cef-enable-debugging` | **Required.** Opens CDP on port 8080 (8081 on Steam Deck) |
| `-dev` | Developer mode — relaxed security, verbose logging |
| `-windowed` | Run windowed instead of fullscreen |
| `-gamepadui` | Big Picture Mode. Required for `page`, `menu`, and `stores` |

Omit `-gamepadui` to debug the classic desktop UI, which is a different front end.

```bash
curl http://localhost:8080/json/version   # {"Browser": "Chrome/...", ...}
```

Steam takes 30–90 seconds to fully initialise. Poll `status` until both marks are `✓`.

---

## Usage

```bash
S=~/.claude/skills/steam-debug/steam-debug.mjs

node $S status
node $S help
```

| Command | Description |
|---|---|
| `status` | CDP endpoint, target count, webpack module count, init state |
| `doctor` | Diagnose the whole setup and print the remedy for whatever is wrong |
| `targets` | All CDP targets with title, URL, WebSocket URL |
| `eval <expr>` | Evaluate JS; promises awaited; objects returned as JSON |
| `errors` | Install a `console.error` capture shim, print what it caught |
| `logs` | Stream live console, browser and Steam-backend output until Ctrl+C |
| `console <cmd>` / `console list` | Run a Steam developer-console command, or list what exists |
| `restart <js\|client>` | Restart the UI or the whole client, and wait for it to come back |
| `react` | React version, module ID, fiber tree stats |
| `styles <selector>` | Computed styles, layout rect, resolved CSS custom properties |
| `dom <selector>` | Dump an element subtree — structure, sizes, leaf text |
| `webpack <pattern>` | Search every webpack module's source |
| `classes <pattern>` | Resolve minified CSS-module class names by readable name |
| `module <id>` | Dump a webpack module's full source |
| `navigate <page>` | Drive Big Picture Mode to a page |
| `page` | Current route and open menu |
| `menu <name>` | Open or close Quick Access / Main Menu |
| `popups` | Popup windows tracked by `g_PopupManager` |
| `stores` | `window.SteamUIStore` sub-stores and properties |
| `screenshot [selector]` | Capture what is actually painted, as a PNG |
| `inject css\|js <file>` | Inject a stylesheet or script, namespaced and reversible |
| `inject list` / `inject remove <slug>` | List or undo injections |
| `watch css\|js <file>` | Re-inject on every file change until Ctrl+C |

| Option | Applies to | Default |
|---|---|---|
| `--target <name>` | `eval`, `errors`, `logs`, `styles`, `dom`, `module`, `screenshot`, `inject`, `watch` | `SharedJSContext` |
| `--port <n>` | all | tries 8080, 8081, then 9222 |
| `--host <addr>` | all | `localhost` — comma-separate for several devices |
| `--timeout <ms>` | all | `10000` |
| `--json` | all | off |
| `--level <all\|warn\|error>` | `logs` | `all` |
| `--source <all\|console\|browser\|backend>` | `logs` | `all` |
| `--grep <regex>` | `logs` | — |
| `--limit <n>` | `webpack`, `classes`, `console list` | `10` / `20` |
| `--ignore-case` | `webpack`, `classes`, `console list` | off |
| `--depth <n>` | `dom` | `2` |
| `--out <path>` | `screenshot` | derived from target title |
| `--diff <path>` | `screenshot` | — |
| `--settle` | `screenshot` | off |
| `--file <path>` | `eval` | — |
| `--id <slug>` | `inject`, `watch` | derived from filename |
| `--confirm` | `restart`, `console` | off |

**`--json` works on every command** and guarantees machine-readable stdout, so nothing has to be
parsed out of prose. `logs --json` emits one JSON object per line.

**`--host` takes a list**, so any command can run against a desktop client and a Steam Deck
together — the practical way to check a plugin behaves the same on both:

```bash
node $S page --host localhost,steamdeck
node $S inject css theme.css --host localhost,steamdeck --target BigPicture
node $S logs --host localhost,steamdeck --level error   # concurrent, tagged per device
```

Output is labelled per device, `--json` aggregates into `{ devices: [...] }`, `--out` is suffixed
so captures do not overwrite, and the exit code is 0 only if every device succeeded.

---

## Reading Steam's own logs

Three streams, not one. `logs` reads all of them and tags each line with where it came from:

```
[ERROR] Uncaught TypeError: …                  console — page JavaScript
[ERROR] (theme.css) Failed to load resource    browser — CEF
[ERROR] (backend) RaiseJSException: …          backend — Steam itself
```

The backend stream is Steam's own output — the same thing a terminal launch shows with `-dev` —
delivered over CDP through `SteamClient.Console`. **No terminal launch, no SSH, nothing installed,
and it works the same on a Steam Deck over `--host`.**

It matters because it is the only stream that names the Steam component behind a failure. A
`SteamClient` call made with the wrong arguments returns cleanly to JavaScript and is refused in
the backend, so without it the symptom is "my code ran and nothing happened":

```bash
node $S logs --source backend --level error
node $S console list 'log|dump'    # what this build's dev console offers
node $S console app_status 570     # ask the client directly
```

`inject` watches the same stream while it applies your file and reports what it heard in
`backendErrors`.

## Recovering from a crash

Injecting into a live client sometimes takes it down. `logs` and `watch` exit 1 when the CDP
connection drops, and `watch` prints the backend lines it captured first — after a crash that tail
is the only copy left.

```bash
node $S status                     # exit 1 → the client is gone
node $S restart client --confirm   # relaunches with debugging enabled, waits for ready
node $S inject js plugin.js        # re-apply; nothing survived
```

`restart js --confirm` is the cheaper step when only the UI is wedged — about a second, and CDP
survives. Both refuse while a game is running, and `restart client` also refuses during a
download.

`restart client` shuts Steam down and launches it again itself rather than calling
`SteamClient.User.StartRestart()`, because Steam's own restart drops `-cef-enable-debugging` and
the client would come back unreachable.

Full semantics in [reference/commands.md](reference/commands.md).

---

## Targets

Steam runs several CEF renderers. Each is a separate CDP target — effectively separate browser
tabs that cannot see each other's JavaScript.

| Name | webpack | `SteamUIStore` | Use for |
|---|---|---|---|
| `SharedJSContext` | **yes** | **yes** | All JS, webpack, React, stores — start here |
| `BigPicture` | no | no | Big Picture DOM and CSS |
| `QuickAccess` | no | no | Quick Access Menu DOM and CSS |
| `MainMenu` | no | no | Main Menu DOM and CSS |
| `NotificationToasts` | no | no | Toast DOM and CSS |

**Only `SharedJSContext` has webpack and `SteamUIStore`** — the others return `undefined` for
both, so run logic there and use the rest for DOM/CSS only. A `Store` alias also exists but
resolves only while a store window is open.

The popup windows are loaded from startup and persist for the whole session, so their DOM can be
inspected without opening them. Their *layout*, though, may not exist until the menu has been
shown once — measured directly on a Steam Deck. `NotificationToasts` is created lazily and may
not exist yet on either platform. On a Deck the viewport is 854×534 at 1.5× rather than 1280×800
at 2×. Details in
[reference/targets.md](reference/targets.md) and [reference/remote.md](reference/remote.md).

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The requested data was produced |
| `1` | Failed, or found nothing — not found, no matches, no route change |
| `2` | Wrong invocation — unknown command, missing argument, invalid flag value |

An empty result is exit 1, so "searched and found nothing" never reads as success. Commands
returning JSON still print `{"error": …}` on stdout when they fail, so the payload stays
parseable alongside the status code.

Invalid input is rejected rather than ignored — a flag the command does not act on, an
unrecognised `--level`, a non-numeric `--limit`, or a flag with no value all exit 2 with an
explanatory message. `navigate` and `menu` both verify their own result and exit 1 if the state
did not actually change, so a no-op cannot be mistaken for success.

## Verifying a visual change

**A computed style is not proof of a visible change.** CEF drops some paints entirely, so
`styles` can report exactly the value you asked for while the screen is unchanged. `screenshot`
captures what the compositor actually drew, and `--diff` turns "nothing happened" into an exit
code:

```bash
node $S screenshot --target BigPicture --out before.png --settle
node $S inject css theme.css --target BigPicture
node $S screenshot --target BigPicture --out after.png --settle --diff before.png
# Changed: 20312 of 4096000 px (0.4959%), bounding box 265x104 at 66,732
```

`--diff` exits 1 when the images are identical. The bounding box localises the change, which is a
fast way to confirm you affected the element you meant to.

Pass `--settle` on both captures. Big Picture keeps repainting for seconds after a route change —
it loads hero artwork progressively — so an unsettled baseline registers that animation as your
change.

The usual cause of an invisible change is Steam's `.BasicUI` layer — an opaque, full-viewport
element that covers anything painted on `body` or any ancestor above it. Style the leaf element
that owns the pixels instead. Details in [reference/injection.md](reference/injection.md).

`screenshot` cannot capture `QuickAccess`, `MainMenu`, or `NotificationToasts` — they are
composited outside the page tree and CDP capture hangs on them.

The usual cause is Steam's `.BasicUI` layer covering anything painted on `body` — style the leaf
element that owns the pixels instead.

---

## Injecting code

Write the CSS or JS to a file and let `inject` handle namespacing and reversal:

```bash
node $S inject css theme.css --target BigPicture    # id defaults to the filename: "theme"
node $S inject list          --target BigPicture
node $S inject remove theme  --target BigPicture
```

Every artifact gets a `steam-debug-<slug>` id and is registered so it can be listed and undone.
Injection is remove-then-add, so re-running never accumulates duplicates. A JS file should
`return` a teardown function — `inject` stores it and calls it on removal.

While iterating, `watch` re-injects on every save until you stop it:

```bash
node $S watch css theme.css --target BigPicture
```

Injections live in page memory and are **lost on reload or restart**.

Steam's class names are minified per build and must be re-resolved every time — use `classes` to
look one up rather than reusing it from notes. Full playbook in
[reference/injection.md](reference/injection.md).

---

## Documentation

| File | Contents |
|---|---|
| [SKILL.md](SKILL.md) | Operating procedure — guardrails, phases, command contract |
| [reference/commands.md](reference/commands.md) | Per-command semantics and output shapes |
| [reference/targets.md](reference/targets.md) | Windows, popups, routes, navigation |
| [reference/injection.md](reference/injection.md) | CSS/JS injection, CEF paint traps, plugin patterns |
| [reference/troubleshooting.md](reference/troubleshooting.md) | Log streams, error tables, React decoding, crash recovery |
| [reference/steam-client-api.md](reference/steam-client-api.md) | Calling a `SteamClient` API the CLI does not wrap |
| [reference/remote.md](reference/remote.md) | Steam Deck / SteamOS — verified on hardware |
| [reference/launch-options.md](reference/launch-options.md) | Full Steam command-line reference — optional, rarely needed |
| [docs/steam-client/](docs/steam-client/) | TypeScript definitions for the whole `SteamClient` surface |

---

## Testing

```bash
node --test test/skill-lint.mjs            # offline: docs vs implementation
node --test test/smoke.mjs                 # live, desktop
node test/run-devices.mjs desktop deck     # live, both devices in sequence
```

`skill-lint.mjs` needs neither Steam nor a network. It fails when documentation drifts from code —
a command or flag named in the docs that does not exist, a stale `--target` column in `SKILL.md`,
an implemented command that is undocumented, `help` or this README missing a command, or a broken
reference link.

`smoke.mjs` exercises the whole command surface against a real client: reachability, `eval`,
`navigate`/`page` and `menu`/`page` round-trips, every named target alias, `screenshot` with
`--diff` and `--settle`, the full `inject` lifecycle including teardown, `watch` hot-reload,
`doctor`, `dom`, `classes`, log filtering, and the usage/failure exit codes.

It also covers the debug loop end to end: `console` against Steam's own command table, backend
spew arriving over `logs --source backend`, `inject` reporting a deliberately-refused
`SteamClient` call, every `restart` guardrail, and — on desktop only — an actual `restart js` that
must replace the JS context and come back ready.

### Choosing the device

| | Desktop | Steam Deck |
|---|---|---|
| Select with | *(default)* | `STEAM_DEBUG_DEVICE=deck` |
| Connection | localhost, default ports | `STEAM_DECK_HOST` (default `steamdeck`) port 8081 |
| Steam auto-launched | yes | **never** |

Every command in the suite gets the device's `--host`/`--port` automatically, so the same tests
validate both. The only device-aware case is `restart js`, which is skipped anywhere the suite is
not allowed to launch Steam — it must never restart someone else's device.

```bash
STEAM_DEBUG_DEVICE=deck node --test test/smoke.mjs
STEAM_DECK_HOST=192.168.1.42 node test/run-devices.mjs deck
```

On desktop, Steam is launched with debug flags if it is not already running; if it is running
*without* `-cef-enable-debugging`, kill it first (`pkill -f steam_osx` on macOS, `pkill steam` on
Linux).

A Deck is **never** launched or restarted by the suite — enable
Settings → System → Developer → CEF Remote Debugging first. Note the suite navigates, opens menus
and injects CSS, so expect to see it working on the device. It cleans up after itself.

---

## How it works

Steam's CEF runtime exposes a CDP WebSocket on port 8080, or 8081 on a Steam Deck. `steam-debug.mjs` connects, issues
`Runtime.evaluate` and related commands, and formats the results — the same protocol Chrome
DevTools speaks. Node 22+ built-ins only.

Globals available in `SharedJSContext`:

```js
window.webpackChunksteamui          // webpack chunk array — presence means the bundle loaded
window.App?.BFinishedInitStageOne() // true once Steam has finished initialising
window.SteamUIStore                 // MobX state: navigation, menus, windows
window.SteamClient                  // native client API bridge
window.g_PopupManager               // popup window registry
window.__steam_debug_wr             // cached webpack require — set by this tool
```

`window.React` does not exist; React lives inside the bundle. Use `react` to find its module ID.

The tool leaves `window.__steam_debug_wr` behind on most commands, and `errors` permanently wraps
`console.error`. Both clear on reload.

---

## License

[CC0 1.0 Universal](LICENSE) — public domain dedication.
