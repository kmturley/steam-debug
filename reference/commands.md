# Command Reference

Full semantics for `steam-debug.mjs`. `SKILL.md` §4 holds the authoritative summary table;
this file adds per-command detail and worked examples.

All examples assume `S=~/.claude/skills/steam-debug/steam-debug.mjs`.

> Sample outputs below are illustrative, captured from one Steam build on macOS. Module IDs,
> class names, versions, and counts differ on every build — never quote these as fact (SKILL.md R6).

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The requested data was produced |
| `1` | Failed, or found nothing — not found, no matches, no route change |
| `2` | Wrong invocation — unknown command, missing argument, invalid flag value |

An empty result is exit 1, not exit 0, so "searched and found nothing" never reads as success.
That covers `webpack` with no matches and `screenshot --diff` finding no change. Commands that
return JSON still print `{"error": …}` on stdout when they fail, so the payload remains parseable
alongside the status code.

`status` is the deliberate exception: reporting a not-ready client is its job, so it exits 0 and
carries a `ready` boolean. Branch on that field, not on its exit code.

## Several devices at once

`--host` takes a comma-separated list, so any command can run against a desktop client and a
Steam Deck together. Each entry may carry its own port, which matters because SteamOS serves 8081:

```bash
node $S page --host localhost,steamdeck
node $S status --host localhost,steamdeck:8081 --json
node $S inject css theme.css --host localhost,steamdeck --target BigPicture
```

This is the practical way to check a plugin behaves the same on both — inject once, compare, then
remove from both with a single `inject remove`.

| | Behaviour |
|---|---|
| Ordering | Sequential, so a slow device cannot interleave with a fast one |
| Output | Labelled per device with a `━━━ host ━━━` header |
| `--json` | One object: `{ "devices": [ { host, ok, exitCode, result } ] }` |
| Failure | One device failing never stops the others; each carries its own `exitCode` |
| Exit code | 0 only if **every** device succeeded |
| `--out` | Suffixed per device, so `after.png` becomes `after.localhost.png` and `after.steamdeck.png` rather than one overwriting the other |

`logs` and `watch` never return, so they run **concurrently** instead, with every line tagged:

```
[localhost] [LOG  ] MULTIPROBE from desktop
[steamdeck] [LOG  ] MULTIPROBE from deck
```

A single `--host` behaves exactly as before — nothing is labelled or aggregated.

## `--json`

Every command accepts `--json` and guarantees machine-readable stdout under it. Prefer it to
regex-parsing human output.

```bash
node $S status --json | jq .ready
node $S targets --json | jq '.targets[] | select(.isSharedContext)'
node $S webpack DialogButton --json | jq '.matches[].moduleId'
node $S logs --level error --json          # one JSON object per line (NDJSON)
```

`eval --json` reports the value plus how it was rendered:

```json
{ "type": "object", "value": { "a": 1 }, "serialisable": true, "text": "{\n  \"a\": 1\n}" }
{ "type": "node", "serialisable": false, "text": "(node body)" }
```

`value` is absent whenever JSON cannot represent the result; `text` always describes it.

## Flags

| Flag | Applies to | Default | Notes |
|---|---|---|---|
| `--target <name>` | `eval`, `errors`, `logs`, `styles`, `module`, `screenshot`, `inject`, `watch` | `SharedJSContext` | Rejected (exit 2) by every other command |
| `--port <n>` | all | tries `8080`, `8081`, then `9222` | 8081 is the Steam Deck default |
| `--host <addr>` | all | `localhost` | One or more machines — see `remote.md` and § Several devices at once |
| `--timeout <ms>` | all | `10000` | Per-request CDP timeout |
| `--json` | all | off | Machine-readable stdout |
| `--level <all\|warn\|error>` | `logs` | `all` | Any other value is rejected |
| `--source <all\|console\|browser>` | `logs` | `all` | Which CDP channel to stream |
| `--grep <regex>` | `logs` | — | Only lines matching this pattern |
| `--limit <n>` | `webpack`, `classes` | `10` / `20` | Must be a positive integer |
| `--ignore-case` | `webpack`, `classes` | off | Boolean, takes no value |
| `--depth <n>` | `dom` | `2` | Subtree depth |
| `--out <path>` | `screenshot` | derived from target title | Output PNG path |
| `--diff <path>` | `screenshot` | — | Baseline PNG to compare against |
| `--settle` | `screenshot` | off | Wait for the screen to stop changing first |
| `--file <path>` | `eval` | — | Read the expression from a file |
| `--id <slug>` | `inject`, `watch` | derived from filename | Alphanumeric and dashes only |

Flags are rejected rather than ignored, in two ways. A flag the command does not act on exits 2
(`status --limit 5` is an error, not a no-op). So does an invalid value — an unrecognised
`--level`, a non-numeric `--limit`, or a flag with no value after it.

### `--target` resolution order

1. **Alias** (case- and space-insensitive): `SharedJSContext`, `BigPicture`, `QuickAccess`,
   `MainMenu`, `NotificationToasts`, `Store`.
2. **Substring** of a target title, if no alias matches.
3. Unmatched → error listing available titles, exit 1.

`Store` resolves only while a Steam store window is open; in Big Picture Mode there usually
isn't one, and the alias fails.

### Flag parsing limits

Flags are matched as whole `argv` entries anywhere in the command line, so an unquoted expression
containing `--limit` would be eaten. Always single-quote `eval` expressions. A flag in last
position with no value exits 2 rather than falling back to the default.

---

## `status`

Preflight gate (SKILL.md R1). Resolves the endpoint, counts targets, and reports readiness.

```
CDP endpoint:  http://localhost:8080
Targets found: 5
SharedJSContext: SharedJSContext
  URL: https://steamloopback.host/routes/library/home

Webpack bundle:   ✓ (2560 modules)
Steam init done:  ✓
```

Both `✓` marks are required before any other work. `Webpack bundle: ✗` means the UI is still
loading; `Steam init done: ✗` usually means signed out or stuck at login.

## `doctor`

Walks the Failure Ladder (SKILL.md §6) automatically and reports the first thing that is wrong.
Checks run in dependency order — Node version, CDP endpoint, targets, `SharedJSContext`, webpack,
Steam init, Big Picture window — because everything after a failure would fail for the same reason.

```
  ✓ Node.js 22+: found 25.9.0
  ✓ CDP endpoint: http://localhost:8080
  ✓ Targets: 5 target(s)
  ✓ SharedJSContext: SharedJSContext
  ✓ Webpack bundle: loaded
  ✓ Steam initialised: yes
  ✓ Big Picture window: present

Ready. All preflight checks passed.
```

A failure prints the remedy, not just the symptom. Exits 1 if any check failed, which makes it a
better preflight gate than `status` — `status` deliberately exits 0 while reporting a bad state.

It also surfaces state this tool may have left in the page: active injections, and whether
`errors` has wrapped `console.error`. Those are informational and never fail the run.

## `targets`

Lists every CDP target with type, title, URL, and WebSocket URL. Run it whenever a `--target`
lookup fails, and to confirm which windows exist before inspecting DOM.

The URL shown is the target's *creation* URL. For popup windows this stays `about:blank?...`
even after the document has loaded real content — see `targets.md`.

## `eval <expr>`

Evaluates JavaScript in the chosen target. Promises are awaited automatically.

```bash
node $S eval 'document.readyState'
node $S eval '({ webpack: typeof window.webpackChunksteamui })'
node $S eval 'location.href' --target BigPicture
```

Return-value encoding:

| Returned | Printed | Exit |
|---|---|---|
| primitive | the value | 0 |
| object / array | pretty JSON | 0 |
| `null` | `null` | 0 |
| `undefined` | `(undefined)` | 0 |
| DOM node | `(node <description>)` | 0 |
| function | `(function <name>)` | 0 |
| circular or otherwise unserialisable | `(<ClassName>)` | 0 |
| throws | `JS Error: <message>` | 1 |

A `(…)` descriptor tells you *what the value is* when it cannot be serialised — it is not an
empty result. Objects are serialised in the page itself, so the expression is evaluated exactly
once and any side effects (such as an injection) never run twice.

To get at a node's contents, return primitives:

```bash
node $S eval 'document.body.className'                    # the value itself
node $S eval 'document.querySelectorAll(".Panel").length' # a count
node $S eval 'document.body'                              # (node body) — identifies, doesn't dump
```

Multi-line work goes in an IIFE, single-quoted:

```bash
node $S eval '(() => { const n = document.querySelectorAll("div").length; return { divs: n }; })()'
```

## `errors`

Two-phase, point-in-time capture of `console.error`.

1. Run `errors` — installs the capture shim.
2. Reproduce the problem.
3. Run `errors` again — prints what was captured.

```bash
node $S errors                                  # install
node $S errors                                  # read back
node $S eval 'window.__steam_debug_errors = []' # reset buffer
```

The shim permanently replaces `console.error` on that page until reload, and does not survive a
Steam restart. Disclose this when you leave it installed (SKILL.md Phase 5). For live streaming,
prefer `logs`.

## `logs`

Streams until interrupted. Combines two CDP channels:

- `Runtime.consoleAPICalled` — page `console.log/warn/error/info/debug`
- `Log.entryAdded` — browser-level events: failed requests, CSP violations, security blocks

```bash
node $S logs                            # everything
node $S logs --level error              # errors only
node $S logs --level warn               # warnings and errors
node $S logs --target QuickAccess       # a popup window's console
node $S logs --grep 'CSP|Content-Sec'   # filter by pattern, no piping needed
node $S logs --source browser           # network/CSP/security only, no console.*
node $S logs --json                     # one JSON object per line
```

`--grep` takes a JavaScript regular expression and is matched against the message text on both
channels. An invalid pattern is rejected at startup rather than silently matching nothing.

`--source` picks the channel: `console` is page `console.*`, `browser` is `Log.entryAdded`
(failed requests, CSP violations, security blocks). Default `all`.

`--level warn` includes errors. Any other value exits 2 with a message; it used to stream nothing
at all, which looked exactly like a quiet system.

## `react`

Finds React inside the webpack bundle and walks the fiber tree. Always runs against
`SharedJSContext`; `--target` is rejected.

```json
{
  "found": true,
  "moduleId": "51745",
  "version": "19.1.1",
  "fiberTreeFound": true,
  "functionComponents": 1311,
  "classComponents": 260,
  "hostNodes": 1123,
  "maxFiberDepth": 224
}
```

`fiberTreeFound: false` means no root is mounted yet — the UI is still loading. There is **no
`window.React` global**; React exists only inside the bundle. Feed `moduleId` to `module` to read
its source.

## `styles <selector>`

Computed styles plus layout for the first matching element.

```bash
node $S styles 'body' --target BigPicture
node $S styles '#QuickAccess-Menu' --target QuickAccess
```

Fields: `tagName`, `className`, `rect` (rounded px), `styles` (curated property set), `cssVars`
(every CSS custom property resolved on the element — the practical way to read Steam's theme).

A missing selector prints `{"error": "No element matches: …"}` on stdout and exits 1. That almost
always means wrong target or wrong route, not a genuinely absent element.

A value here proves the style was *computed*, not that it was *painted* — see `injection.md`.

## `dom <selector>`

Dumps an element subtree — structure, sizes, and leaf text — without the noise of full
`outerHTML`.

```bash
node $S dom '#QuickAccess-Menu' --target QuickAccess
node $S dom 'body' --depth 4 --target BigPicture
```

```
div#QuickAccess-Menu.V0cr-SAnDhzAWmPZdrJQJ.Panel  [854x720]
  div._3k5MHjpKaOv6C29MKPgd6x  [348x0] (no size)
  div._1gJzx0OgstpPqW34DFUKC6.Panel  [854x720]
    … 2 child element(s) not shown
```

Each node reports its layout rect, and `(no size)` marks anything with zero width or height —
usually the reason an element "exists" but cannot be seen or styled. Depth defaults to 2;
children beyond it are counted rather than expanded. `data-*`, `role` and `aria-label` attributes
are included since they make more durable selectors than minified classes.

## `webpack <pattern>`

Substring search across every module's source. Always `SharedJSContext`; `--target` rejected.

```bash
node $S webpack 'DialogButton'
node $S webpack 'dialogbutton' --ignore-case
node $S webpack 'useState' --limit 3
```

Prints module id and a one-line snippet per match. Zero matches prints a hint and exits 1, so an
empty search is distinguishable from a successful one. Because the bundle is minified, search for
strings that survive minification — user-facing text, CSS class names, API endpoints,
`Symbol.for("react.…")` — not local variable names.

## `classes <pattern>`

Resolves Steam's minified CSS-module class names by their readable source name — the practical
answer to "what class do I actually target?"

```bash
node $S classes QuickAccessMenu
node $S classes dialogbutton --ignore-case --limit 5
```

```
Pattern "QuickAccessMenu" — 4 class name(s):

  QuickAccessMenu
    .V0cr-SAnDhzAWmPZdrJQJ   (module 34544)
  QuickAccessMenuEmbedded
    ._3jjfFMZJhEc6EObgwDcVvL   (module 34544)
```

CSS modules compile to `ReadableName:"minifiedHash"` pairs in the bundle, so the readable name
stays searchable even though only the hash appears in the DOM. Matching is a **heuristic**:
values are accepted when they look hash-like — mixed case, containing digits, no whitespace.
That can miss an unusual class and can occasionally admit a non-class string, so confirm before
relying on one:

```bash
node $S styles '.V0cr-SAnDhzAWmPZdrJQJ' --target QuickAccess
```

Results are ordered by module id, not relevance, and stop at `--limit`. If the name you expect is
missing, narrow the pattern rather than raising the limit. Class names change on every Steam
build — re-resolve them, never reuse one from notes (R6).

## `module <id>`

Dumps a module's full source. Takes the id from `webpack` or `react`.

```bash
node $S module 51745
```

An unknown id prints `Module <id> not found` to stderr and exits 1, keeping stdout clean so it can
be piped safely. Output can be hundreds of KB — redirect to a file or `grep` rather than reading
it inline.

## `navigate <page|steam://url>`

Drives Big Picture Mode via `SteamClient.URL.ExecuteSteamURL`, then **verifies the result**: it
reads the route before and after, polls for up to 4 seconds, and reports what actually happened.
All output goes to **stderr**; stdout is empty. `--target` rejected.

Verified behaviour in Big Picture Mode:

| Argument | Resulting route | Outcome |
|---|---|---|
| `library`, `home` | `/library/home` | exit 0 |
| `downloads` | `/library/downloads` | exit 0 |
| `settings` | `/settings/system` | exit 0 |
| `store` | `/steamweb` | exit 0 |
| `account` | unchanged | **exit 1 — no-op** |
| `chat`, `friends` | unchanged | **exit 1 — no-op** |

Any `steam://` URL is passed through unchanged. An unrecognised name becomes
`steam://open/<name>`.

Three possible messages:

```
Navigated: steam://open/downloads -> /library/downloads                  # moved
Navigated: steam://open/downloads -> /library/downloads (already there)  # already correct
Executed: steam://open/account
Route unchanged (/library/home) — no-op in the current UI mode.          # exit 1
```

Without a Big Picture window there is no route to compare, so it reports
`Route not verified` and exits 0 rather than guessing.

## `page`

Current Big Picture route and menu state. Requires `-gamepadui`.

```json
{
  "currentPath": "/settings/system",
  "recentPaths": ["/library/home", "/library/downloads", "/settings/system"],
  "openMenu": "none"
}
```

`openMenu` is one of `none`, `MainMenu`, `QuickAccess`. `recentPaths` is the last five backstack
entries, oldest first, ending with the current route.

Without `-gamepadui`: `{"error": "GamepadUIMainWindowInstance not found — is -gamepadui flag set?"}`.

## `popups`

Windows tracked by `g_PopupManager`. Returns an array; `[]` is valid.

This registry does **not** include the Quick Access Menu or Main Menu — those are browser views,
not popups. Typically only the Big Picture window itself appears. Use `targets` to find QAM and
MainMenu.

## `menu <QuickAccess|MainMenu|Close>`

Opens or closes an overlay via `MenuStore.OpenSideMenu`. Name is case- and space-insensitive;
`Close` and `None` both close. Confirmation on **stderr**. Unknown name exits 1.

```bash
node $S menu QuickAccess && node $S page   # verify openMenu changed (R5)
node $S menu Close
```

Opening a menu changes what the user sees. Restore it afterwards (Phase 5).

## `stores`

One level of `window.SteamUIStore`: each sub-store with up to 15 non-function property names.
Requires `-gamepadui`; `--target` rejected.

The map of Steam's runtime state — navigation, windows, audio, gamepad routing, text filtering.
Use it to discover a store, then read specifics with `eval`:

```bash
node $S stores
node $S eval 'window.SteamUIStore.m_WindowStore.GamepadUIMainWindowInstance.m_history.location.pathname'
```

## `screenshot [selector]`

Captures what the compositor actually painted, as a PNG. Prints the output path on stdout.

```bash
node $S screenshot --target BigPicture                      # whole viewport
node $S screenshot --target BigPicture --out after.png      # explicit path
node $S screenshot '.SomePanel' --target BigPicture         # clipped to one element
```

This is the only way to confirm a visual change. `styles` proves a rule matched and was computed;
CEF drops some paints entirely, so a correct computed value can accompany an unchanged screen.
See `injection.md` for why.

The PNG is in **device pixels**, so on a HiDPI display it is larger than the CSS region — a
1280x800 viewport at 2x produces a 2560x1600 file. The reported size is the CSS region.

Fails with exit 1 when:

| Situation | Message |
|---|---|
| Target is a browser-view popup | Cannot be captured — CDP hangs on these targets |
| Selector matches nothing | `No element matches: …` |
| Element has zero size | Present but not laid out, so there is nothing to capture |

**`QuickAccess`, `MainMenu`, and `NotificationToasts` cannot be captured at all.** They are
composited outside the page tree. Capturing `BigPicture` with the Quick Access Menu open shows
its backdrop effect on the library behind it, but not the panel.

### `--diff <baseline.png>`

Captures, then compares against a baseline, so "did that change anything?" can be answered
without a human looking:

```bash
node $S screenshot --target BigPicture --out before.png
node $S inject css theme.css --target BigPicture
node $S screenshot --target BigPicture --out after.png --diff before.png
```

```
Changed: 20312 of 4096000 px (0.4959%), bounding box 265x104 at 66,732
```

The bounding box is in device pixels and localises the change, which is a quick way to confirm
you affected the element you meant to. `--json` returns `changed`, `changedPixels`,
`totalPixels`, `percentChanged`, and `boundingBox`.

**Exit 1 when the images are identical** — no difference is an empty result, the same rule
`webpack` follows. Mismatched dimensions are refused with `Not comparable` rather than guessed at.

Comparison ignores per-channel differences of 8/255 or less, so JPEG-style encoding noise does not
register as a change. A diff proves *something* moved, not that it is *correct*; look at the image
when that distinction matters.

### `--settle`

An idle Big Picture screen is pixel-stable, but after a route change the library keeps repainting
for several seconds — it loads hero artwork progressively, at up to ~75% of pixels changing.
Diffing during that window measures the animation rather than your change.

`--settle` captures repeatedly until several consecutive frames are identical, then returns that
frame. **Pass it on both sides of a comparison:**

```bash
node $S screenshot --target BigPicture --out before.png --settle
node $S inject css theme.css --target BigPicture
node $S screenshot --target BigPicture --out after.png --settle --diff before.png
```

It requires more than one matching pair, because a single pair can match during a momentary pause
in an animation that is still running — observed directly after a route change.

If the screen never stops changing within 15 seconds it reports `settled: false`, warns, and
captures anyway rather than failing: something may animate forever, and the last frame is still
the best available.

**`settled: false` means the comparison is not trustworthy.** On a quiet screen, two settled
captures are reliably identical. After a route change the library can keep loading artwork for
longer than the settle window — two captures taken 15 seconds apart were measured differing by
3.6% with nothing injected. So check the flag: if it comes back false, wait and retry rather than
attributing the difference to your change.

## `watch <css|js> <file>`

Re-injects on every file change until interrupted. One CDP session is held open for the whole
run, so reloads are fast.

```bash
node $S watch css theme.css --target BigPicture
```

```
[08:37:38] initial: applied
Watching theme.css -> "theme" in Steam Big Picture Mode. Ctrl+C to stop.
[08:37:41] changed: applied
```

Identical semantics to `inject` — same slug derivation, same remove-then-add — so a watch loop
never stacks duplicates. Rapid saves are debounced and coalesced.

A failing edit is reported and **the watch continues**; losing the loop on every typo would
defeat the point. Editors that save by renaming are handled by re-establishing the watch.

On exit the injection is deliberately left in place, and the removal command is printed. Stopping
a watch is not the same as undoing the change.

## `inject <css|js> <file>` / `inject list` / `inject remove <slug>`

Injects a stylesheet or script, namespaced and reversible. See `injection.md` for the full
playbook.

```bash
node $S inject css theme.css --target BigPicture     # id defaults to "theme"
node $S inject js plugin.js  --target BigPicture --id my-plugin
node $S inject list          --target BigPicture
node $S inject remove theme  --target BigPicture
```

Every artifact gets a `steam-debug-<slug>` DOM id and an entry in
`window.__steam_debug_injections`. Injection is always remove-then-add, so re-running is safe and
never accumulates duplicates.

A JS file should `return` a teardown function; it is stored and called on removal, and before
re-injection. `inject` warns when a script returns nothing, because the change then cannot be
undone without a reload. It also warns when a stylesheet parses to zero rules.

`inject list` reports registry entries plus any `steam-debug-*` style tags without one — those are
marked `unregistered` and usually mean a hand-rolled `eval` injection.

Nothing injected survives a page reload or a Steam restart.

## `help`

Prints usage. Useful as a drift check against SKILL.md §4.

---

## Page state this tool mutates

Disclose these when relevant (SKILL.md Phase 5). All clear on reload.

| Global | Set by | Effect |
|---|---|---|
| `window.__steam_debug_wr` | `status`, `react`, `webpack`, `module` | Cached webpack require handle |
| `window.__steam_debug_errors` | `errors` | Captured error strings |
| `console.error` | `errors` | Permanently wrapped until reload |
| `console.__steam_debug_patched` | `errors` | Guard flag preventing double-patching |
