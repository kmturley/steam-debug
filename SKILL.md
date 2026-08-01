---
name: steam-debug
description: Inspect, debug, and inject custom code into a running Steam client — desktop (macOS, Linux, Windows) or Steam Deck over the network — through its Chromium Embedded Framework (CEF) Chrome DevTools Protocol endpoint. Use when developing Steam UI plugins, mods, themes, or integrations — injecting CSS/JS to try a change, locating webpack modules and obfuscated class names, reading React or SteamUIStore state, inspecting Big Picture / Quick Access Menu windows, screenshotting what actually rendered, streaming console logs, or diagnosing runtime errors in Steam's UI. The same commands run against either device, or both at once. Injection is per-session and for development only. Not for building a plugin loader or making changes persist across restarts, Steamworks game SDK work, game development, or scraping the public Steam web store.
---

# Steam Client — Runtime Debug & Injection SOP

Steam's UI is a Chromium (CEF) app. Launched with debug flags it exposes a Chrome DevTools
Protocol endpoint, so the whole UI can be inspected and modified at runtime the way a web page
can. `steam-debug.mjs` wraps that protocol as a CLI.

Works against a **desktop client** (macOS, Linux, Windows) and a **Steam Deck** over the network —
the same commands, selected with `--host`. Both are verified by the test suite.

This document is an operating procedure, not a tutorial. Follow the phases in order.
Section 1 rules are binding; Section 2 defaults may be overridden with a stated reason.

**Scope.** This skill inspects and debugs a running Steam client — desktop or Steam Deck — and
lets you try changes against it. Injection is per-session and disappears on reload; that is
deliberate.

Out of scope, and not to be improvised: making a change persist or load on startup, packaging or
distributing plugins, and anything that runs unattended inside someone's client. That is a plugin
loader's job. If a request needs it, say so and stop.

The boundary is simple — this skill helps you *find out what is going on* and *try a change*.
Making a change stick is someone else's job.

**Requires Node.js 22+.** Chrome is optional (only for the interactive DevTools UI).

---

## 0. Session setup

Run once per session, before anything else:

```bash
S=~/.claude/skills/steam-debug/steam-debug.mjs
# Windows PowerShell: $S = "$env:USERPROFILE\.claude\skills\steam-debug\steam-debug.mjs"
```

Every command in this document assumes `$S` is set. Never hardcode a different path.

---

## 1. Hard rules — MUST

Violating any of these produces an answer that is wrong even if it looks right.

**R1 — Preflight gate.** Do not run any inspect, navigate, or inject command until `status`
has reported `Webpack bundle: ✓` **and** `Steam init done: ✓` in this session. If either is `✗`,
go to the Failure Ladder (§6). Never skip this because Steam "looks" open.

**R2 — Closed command surface.** Only the commands and flags listed in §4 exist. Never invent a
command, flag, subcommand, or alias, and never infer one from a pattern. If a task needs
something outside that surface, say so explicitly and fall back to `eval`.

**R3 — Target discipline.** `--target` is accepted only by `eval`, `errors`, `logs`, `styles`,
`dom`, `module`, `screenshot`, `inject`, and `watch`. Every other command always runs against the
shared JS context and rejects `--target` outright. Never state or imply that a result came from a
window the command cannot reach.

**R4 — Read the exit code *and* the payload.** 0 means the data you asked for was produced; 1
means the command failed or found nothing; 2 means the invocation was wrong. An empty result is
exit 1, so "no matches" never reads as success. Commands returning JSON also print
`{"error": "..."}` on stdout when they fail.

**R5 — Verify state changes.** `navigate` verifies itself: it polls the route and exits 1 if
nothing moved, so a no-op cannot be mistaken for success. `menu` does **not** — it reports
success without checking. Confirm any `menu` with `page` before drawing a conclusion.

**R6 — Never fabricate build-specific identifiers.** Webpack module IDs, obfuscated CSS class
names, React version, and module counts change with every Steam build. Every such value you
report must come from a command you ran in this session. Never reuse one from memory, from this
document's examples, or from a previous session.

**R7 — Confirm visibility before inspecting the DOM.** Elements exist only while their feature is
rendered and only inside the window that owns them. Before any DOM or CSS conclusion, confirm
the route with `page` and confirm you are querying the correct target (§5 of
`reference/targets.md`).

**R8 — Injection hygiene.** Use the `inject` command, which namespaces, registers, and makes the
change reversible for you. Do not hand-roll injection through `eval` unless `inject` cannot
express it, and if you do, match its contract: a `steam-debug-<slug>` id and remove-then-add.
Always give the user the removal command, and never describe an injection as persistent — every
one is lost on reload or restart.

**R9 — Never restart or kill Steam without explicit user confirmation.** A restart drops
in-progress downloads, running games, and Remote Play sessions. Relaunching is the last rung of
the Failure Ladder, not a first response.

**R10 — Report observed values verbatim.** Quote real IDs, counts, selectors, and versions from
command output. Do not round, paraphrase, or reconstruct them from memory.

---

## 2. Soft defaults — SHOULD

Sensible defaults. Override when the task calls for it, and say why.

- Start every investigation at `SharedJSContext`; it is the only target with webpack and
  `SteamUIStore`.
- For a bug you can reproduce on demand, prefer `logs --level error` (live stream). Use `errors`
  only for point-in-time capture of what already happened.
- Narrow `webpack` searches before widening them. Try an exact pattern first, then
  `--ignore-case`, then a shorter substring.
- Answer CSS questions with `styles` rather than a hand-written `eval` of `getComputedStyle`.
- Use the CLI for scripted or repeatable checks; point the user at Chrome DevTools
  (`chrome://inspect`) for open-ended visual exploration.
- Keep `-gamepadui` set when working on Big Picture / Steam Deck-style UI; omit it when the
  target is the classic desktop UI, which is a different front end entirely.

---

## 3. Routing — intent to entry point

| User intent | Entry point |
|---|---|
| "Is Steam ready / why can't you connect?" | `doctor`, then §6 Failure Ladder |
| "Change how Steam looks", theme, custom CSS | Phase 3 → `reference/injection.md` |
| "Add a feature / build a plugin", custom JS | Phase 3 → `reference/injection.md` |
| "Make my change load on startup / persist" | **Out of scope** — say so; that is the plugin loader's job |
| "What class name do I target?" | `classes <ReadableName>`, then `styles` to confirm |
| "What does this part of the UI look like structurally?" | `dom <selector> --target <win>` |
| "Find the component / module for X" | Phase 2 → `webpack`, `module` |
| "Something is broken / erroring" | Phase 2 → `logs`, `errors` → `reference/troubleshooting.md` |
| "Why does my CSS not show up?" | `reference/injection.md` § Why paint disappears |
| "Inspect the Quick Access Menu / Main Menu" | `reference/targets.md` |
| "What state does Steam hold?" | `stores`, `page`, `popups` |
| "Debug my Steam Deck" | `reference/remote.md` |

---

## 4. Verified command surface — authoritative

This table is the single source of truth. It is verified against the implementation by
`test/skill-lint.mjs`. Do not extend it from memory.

| Command | Argument | `--target`? | stdout on success | Non-zero exit when |
|---|---|---|---|---|
| `status` | — | rejected | human text | 1 — no CDP endpoint (see note) |
| `doctor` | — | rejected | checklist | 1 — any check failed |
| `targets` | — | rejected | human text | 1 — no CDP endpoint |
| `eval` | `<expr>` | **yes** | value, JSON, or a `(…)` descriptor | 1 — the expression threw |
| `errors` | — | **yes** | human text | 1 — connect failure |
| `logs` | — | **yes** | live `[LEVEL] message` stream | 2 — invalid `--level` |
| `react` | — | rejected | JSON | 1 — React not found |
| `styles` | `<selector>` | **yes** | JSON | 1 — selector matched nothing |
| `dom` | `<selector>` | **yes** | tree, or JSON | 1 — selector matched nothing |
| `webpack` | `<pattern>` | rejected | human text | 1 — no matches |
| `classes` | `<pattern>` | rejected | human text | 1 — no matches |
| `module` | `<id>` | **yes** | raw module source | 1 — module not found |
| `navigate` | `<page\|steam://url>` | rejected | *(stderr only)* | 1 — route did not change |
| `page` | — | rejected | JSON | 1 — no Big Picture window |
| `popups` | — | rejected | JSON array | 1 — registry unavailable |
| `menu` | `<QuickAccess\|MainMenu\|Close>` | rejected | *(stderr only)* | 2 — unknown menu name |
| `stores` | — | rejected | JSON | 1 — no Big Picture window |
| `screenshot` | `[selector]` | **yes** | PNG path | 1 — popup target, selector missing or zero-size, or `--diff` found no change |
| `inject` | `<css\|js> <file>`, `list`, `remove <slug>` | **yes** | JSON | 1 — injection failed, or slug not found |
| `watch` | `<css\|js> <file>` | **yes** | *(stderr only)* | 2 — bad mode or unreadable file |
| `help` | — | rejected | human text | — |

**Flags:** `--target <name>`, `--port <n>`, `--host <addr>`, `--timeout <ms>`, `--json`,
`--level <all\|warn\|error>`, `--source <all\|console\|browser>`, `--grep <regex>`, `--limit <n>`,
`--ignore-case`, `--depth <n>`, `--out <path>`, `--diff <path>`, `--settle`, `--file <path>`,
`--id <slug>`. There are no others. A flag sent to a command that does not act on it is rejected,
not ignored, and invalid values are rejected too.

**`--json` is accepted by every command** and guarantees machine-readable stdout — prefer it over
parsing human text. `logs` emits one JSON object per line.

**`--host` accepts a comma-separated list**, so any command can run on several devices at once —
`--host localhost,steamdeck`. Output is labelled per device, `--json` aggregates into
`{ devices: [...] }`, and the exit code is 0 only if every device succeeded. Use it to check a
change behaves the same on desktop and on a Deck; see `reference/commands.md`.

**`status` is the one command that reports failure with exit 0**, because reporting a not-ready
client is its job. Branch on its `ready` field. `doctor` is the opposite: it exits 1 when
anything is wrong, and names the remedy.

---

## 5. Output contract

**Exit codes.**

| Code | Meaning |
|---|---|
| `0` | The requested data was produced |
| `1` | The command failed, or found nothing — not found, no matches, no route change |
| `2` | The invocation was wrong — unknown command, missing argument, invalid flag value |

Exit 1 covers "searched successfully, found nothing" as well as hard failure, so an empty result
never reads as success. Commands returning JSON still print `{"error": …}` on stdout when they
fail, so the payload stays parseable; check both the code and the payload.

**Reading `eval` results.** Primitives print bare. Plain objects and arrays print as JSON.
Values that cannot be serialised print as a descriptor rather than being flattened: `(undefined)`,
`(node body)`, `(function open)`, `(Object)` for a circular structure. A descriptor means "here is
what it is", not "empty" — to get at contents, return primitives:
`document.body.className`, `el.getBoundingClientRect().width`.

**Nothing fails silently any more.** Flag validation, `navigate`, and `menu` all self-report, and
`screenshot --diff` turns "the CSS computed but never painted" into an exit code. The one
judgement left to you: a diff proves *something* changed, not that it changed *correctly* — look
at the image when the answer matters.

**Streams.** `navigate` and `menu` print only to stderr; piping their stdout yields nothing.
`logs` prints its banner to stderr and log lines to stdout, so `logs 2>/dev/null | grep …` is safe.

**Always-quote `eval`.** Wrap the whole expression in single quotes so the shell cannot split it
and so `--` inside CSS custom properties is not parsed as a flag. Object literals need parentheses:
`'({ a: 1 })'`.

---

## 6. Failure Ladder

**Run `doctor` first** — it walks rungs 1–8 automatically, in dependency order, and prints the
remedy for whatever failed:

```bash
node $S doctor
```

It also reports state this tool may have left behind (injections, the `console.error` shim). Use
the table below when `doctor` passes but something still looks wrong, or to understand a remedy
it gave you. Work top to bottom; stop at the first rung that resolves the symptom.

| # | Symptom | Check | Action |
|---|---|---|---|
| 1 | `Steam is not running with remote debugging enabled` | `curl -s http://localhost:8080/json/version` | If it answers, the port differs — retry with `--port`. If not, rung 2. |
| 2 | No CDP endpoint at all | `ps aux \| grep -i steam` | Steam not running → launch it (§7 Phase 0). Steam running *without* debug flags → rung 3. |
| 3 | Steam running, port closed | — | Flags are only read at startup; a running instance ignores them. **Ask the user before restarting (R9)**, then relaunch with debug flags. |
| 4 | `SharedJSContext not found` | `targets` | Steam is still booting. Wait and retry; do not relaunch. |
| 5 | `Webpack bundle: ✗` | `status` | UI still loading. Wait and retry. Persisting → rung 3. |
| 6 | `Steam init done: ✗` | `status` | Signed out, or stuck on login/update. Ask the user to complete sign-in. |
| 7 | `{"error": "GamepadUIMainWindowInstance not found"}` | `page`, `stores` | Steam was launched without `-gamepadui`. These commands need Big Picture Mode. |
| 8 | `{"error": "window.SteamUIStore not found"}` | `stores` | Same as rung 7, or command ran against a non-shared target. |
| 9 | `No target matching "X"` | `targets` | Use an exact name from `targets` output. `Store` resolves only when a store window is open. |
| 10 | `styles` returns `{"error": "No element matches"}` | `page` | Wrong route or wrong target. Navigate to the feature, then query the window that owns it. |
| 11 | `webpack` finds nothing (exit 1) | — | Pattern too long or wrong case. Shorten it, add `--ignore-case`. Minified builds rename most identifiers. |
| 12 | Injected CSS has no visible effect | `styles` | Computed value present but nothing on screen → CEF paint trap. See `reference/injection.md`. |
| 13 | `--target is not supported by "<cmd>"` (exit 2) | — | That command always uses the shared context. Drop the flag; for window-specific work use `eval`, `styles`, or `module`. |
| 14 | `--level`/`--limit` rejected (exit 2) | — | Invalid flag value. Use `all\|warn\|error`, or a positive integer. |
| 15 | `Route unchanged (…) — no-op` (exit 1) | `page` | That alias does not move Big Picture; `account`, `chat`, and `friends` never do. Pick a route that exists. |

---

## 7. Execution phases

### Phase 0 — Preflight *(mandatory, R1)*

```bash
node $S doctor      # or: node $S status
```

`doctor` exits 0 only when everything needed is in place, and names the remedy otherwise —
prefer it. If you use `status` instead, proceed only when both `Webpack bundle: ✓` and
`Steam init done: ✓`. Anything else → §6.

If Steam is not running, launch it — killing an existing instance first only with user
consent (R9), because launch flags are read only at startup:

| Platform | Command |
|---|---|
| macOS | `open -a Steam --args -dev -windowed -cef-enable-debugging -gamepadui` |
| Linux | `steam -dev -windowed -cef-enable-debugging -gamepadui` |
| Windows | `steam.exe -dev -windowed -cef-enable-debugging -gamepadui` |
| Steam Deck | Settings → System → Developer → CEF Remote Debugging, then `reference/remote.md` |

`-cef-enable-debugging` is the only strictly required flag; it opens CDP on port 8080 (8081 on a Steam Deck). `-dev`
enables verbose logging, `-windowed` avoids fullscreen, `-gamepadui` selects Big Picture Mode
and is required for `page`, `menu`, and `stores`.

Steam can take 30–90 s to reach `Steam init done: ✓`. Poll `status`; do not relaunch.

### Phase 1 — Scope

State in one line what will be answered or changed, and which window owns it. Route via §3.
Classify the task as **inspect** (read-only) or **inject** (mutates the user's running client).
For inject tasks, name the removal path before writing anything.

### Phase 2 — Locate

Establish position before drawing conclusions:

```bash
node $S targets   # which windows exist
node $S page      # current route + open menu   (R5, R7)
```

Then locate the subject:

| Looking for | Command |
|---|---|
| Bundle source | `webpack <pattern>`, then `module <id>` |
| The real class name behind a readable one | `classes <ReadableName>` |
| A rendered element's computed style | `styles <selector> --target <win>` |
| The shape of a subtree | `dom <selector> --target <win>` |
| Application state | `stores`, then `eval` for specifics |

Depth in `reference/targets.md`.

### Phase 3 — Act

**Inspect:** run the narrowest command that answers the question. Prefer `styles` over `eval`
for CSS, `webpack` + `module` over guessing at bundle contents.

**Inject:** write the CSS or JS to a file, then let `inject` handle namespacing and reversal (R8):

```bash
node $S inject css theme.css --target BigPicture   # id defaults to the filename: "theme"
node $S inject list --target BigPicture            # what is currently injected
node $S inject remove theme --target BigPicture    # undo, running any teardown
```

A JS file should `return` a teardown function; `inject` stores it and calls it on removal.
Without one, the change cannot be undone except by reloading.

For iterative work, `watch` re-injects on every save until interrupted — a failed edit is
reported and the loop continues:

```bash
node $S watch css theme.css --target BigPicture
```

Full playbook in `reference/injection.md`.

### Phase 4 — Verify

Never report a result straight from the command that produced it. Confirm independently:

| Action | Verification |
|---|---|
| `navigate` | Self-verifying — exit 0 and the reported route are the check |
| `menu` | Self-verifying — it polls `openMenu` and fails if the state did not change |
| CSS injection | `styles` for the computed value, then `screenshot` for the actual paint |
| JS injection | re-read the value through a fresh `eval` |
| Error fix | `logs --level error` stays clean through a reproduction |
| Any command | exit code is 0 and, for JSON, the payload has no `error` key (R4) |

**A computed style is not proof of a visible change.** CEF drops some paints entirely, so `styles`
can report exactly what you asked for while the screen is unchanged. Any visual claim must be
backed by `screenshot`, which captures what the compositor actually painted:

```bash
node $S screenshot --target BigPicture --out before.png --settle
# …make the change…
node $S screenshot --target BigPicture --out after.png --settle --diff before.png
```

`--diff` answers "did that actually change anything?" without a human looking: it reports the
changed pixel count, percentage, and bounding box, and **exits 1 when the images are identical**.
That makes an invisible change a detectable failure rather than a silent one.

**Always pass `--settle` when diffing, and check the flag it returns.** Big Picture keeps
repainting after a route change — the library loads artwork progressively — so an unsettled
baseline registers that animation as your change. `--settle` waits for consecutive identical
frames; if it reports `settled: false` the screen never stopped moving, and **the diff is not
trustworthy** — wait and retry before attributing any difference to your change.

`screenshot` cannot capture `QuickAccess`, `MainMenu`, or `NotificationToasts` — those are
browser views composited outside the page, and CDP capture hangs on them. A Big Picture capture
shows their backdrop effect but not the panel itself.

### Phase 5 — Report and clean up

Remove every probe artifact you introduced, or hand the user the exact removal command.
Then report:

- what was found or changed, with values quoted verbatim (R10);
- which window it applies to;
- that injected changes disappear on reload/restart (R8);
- anything left mutated — `errors` permanently patches `console.error`, and most commands cache
  `window.__steam_debug_wr`, both until the page reloads.

---

## 8. Reference index

Load on demand; do not read them all up front.

| File | Read it when |
|---|---|
| `reference/commands.md` | Full flag semantics, per-command output shapes, worked examples |
| `reference/targets.md` | Choosing a window; popup internals; routes and navigation |
| `reference/injection.md` | Writing CSS/JS into Steam; CEF paint traps; plugin patterns |
| `reference/troubleshooting.md` | Log sources, error-pattern tables, React error decoding |
| `reference/remote.md` | Steam Deck / SteamOS over the network |
| `reference/launch-options.md` | **Rarely.** Only when changing how Steam is launched, or hunting a capability the CLI lacks. Phase 0's four flags cover normal work |

---

## 9. Maintenance & drift checklist

Run after any change to `SKILL.md`, `reference/*.md`, or `steam-debug.mjs`.

```bash
node --test test/skill-lint.mjs            # offline: docs vs implementation
node --test test/smoke.mjs                 # live, desktop
node test/run-devices.mjs desktop deck     # live, both devices
```

The smoke suite runs against either client. `STEAM_DEBUG_DEVICE=deck` points it at a Steam Deck
(`STEAM_DECK_HOST`, port 8081), and every command picks up that device's `--host`/`--port`
automatically. A Deck is never launched or restarted by the suite.

`skill-lint.mjs` fails the build when documentation drifts from code. It asserts that every
command and flag named in the docs exists, that §4's `--target` column matches the `COMMANDS`
registry, that the registry agrees with how each handler opens its session, that every declared
flag is actually parsed and every parsed flag is claimed by some command, that §4 covers every
implemented command, and that no §4 row still documents exit 0 as a failure.

Manual review — confirm each still holds:

| # | Check | Fails if |
|---|---|---|
| 1 | §4 table matches `help` output exactly | A command was added or renamed |
| 2 | §5 exit-code table matches the constants in `steam-debug.mjs` | The 0/1/2 split changed |
| 3 | §5 "what is still quiet" lists only genuine remaining gaps | A quiet failure was fixed, or a new one appeared |
| 4 | Every hard rule is checkable against real output | A rule became aspirational |
| 5 | No build-specific ID (module id, class name, React version) appears as fact | Someone pasted a real ID into the docs |
| 6 | Every `reference/*.md` in §8 exists and is linked | A file was renamed or orphaned |
| 7 | Phase 0 flags match the launch table in `README.md` | The two drifted apart |
| 8 | Every behaviour documented here was observed, not assumed | Someone wrote down what they expected rather than what happened |
| 9 | Claims about what CEF paints are backed by a `screenshot`, not by `styles` | Someone documented a computed value as a visible change |
| 10 | No command or doc has drifted into persistence or plugin loading | Scope creep — that belongs to a plugin loader, not here |
| 11 | Anything described as a device difference was checked on **both** a desktop client and a Deck | A single-device observation was written up as a platform rule. This has caused two wrong claims already — lazily-created targets and popup layout both look like platform differences until you check |

Adding a command: implement it, extend §4, add a smoke test, and re-run both suites.
Do not document behaviour you have not observed on a running client.
