# Decky Loader plugins

[Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) is the most common way third-
party UI is added to Steam's Big Picture / Deck interface — a loader that injects plugin frontend
code into `SharedJSContext` alongside Steam's own React tree, and runs each plugin's Python
backend as a subprocess the frontend talks to over its own WebSocket. If a task involves "a Deck
plugin," "Decky," or a Quick Access Menu panel that is not Steam's own, this is almost always the
mechanism underneath it.

This page covers what is generally true of any Decky plugin, observable from CDP without
installing anything. It says nothing about a *specific* plugin's own UI, state, or bugs — that is
the task at hand, not this reference.

---

## Is Decky Loader present at all?

Decky's own runtime attaches a handful of globals to `SharedJSContext` on startup. Their presence
is the check; a plugin cannot be loaded without them.

```bash
node $S eval 'typeof window.DeckyPluginLoader'
node $S eval 'window.deckyHasLoaded'
```

| Global | What it is |
|---|---|
| `window.deckyHasLoaded` | Boolean — Decky's own loader has finished initialising |
| `window.DeckyPluginLoader` | The loader singleton: plugin registry, router hook, tab hook, toaster |
| `window.DeckyBackend` | The WebSocket bridge each plugin's backend calls route through |
| `window.deckyAuthToken` | Session auth token for that bridge — do not print it (SKILL.md R12 covers credential-shaped values generally; treat any loader auth token the same way even though it is not a Steam credential) |

`typeof window.DeckyPluginLoader === 'undefined'` means Decky Loader itself is not running in this
client — nothing plugin-shaped can be inspected until it is.

---

## Is a specific plugin installed and loaded?

`DeckyPluginLoader.plugins` is the loaded-plugin registry. Each entry carries at least a `name`
and `version`; a plugin present here has been loaded into the frontend, which for Decky means it
is both installed and enabled (a disabled plugin is not loaded at all, not loaded-but-inert).

```bash
node $S eval 'Object.values(window.DeckyPluginLoader.plugins).map(p => p.name)'
node $S eval '(() => { const p = Object.values(window.DeckyPluginLoader.plugins)
  .find(p => p.name === "Plugin Name"); return p ? p.version : "not loaded"; })()'
```

`plugins` has been observed as a plain object keyed by numeric index (`{0: {...}, 1: {...}}`)
rather than an array — iterate with `Object.values`/`Object.keys` rather than assuming array
methods work directly. Confirm the actual shape in the session you are debugging (SKILL.md R6);
Decky's own internal structures are not part of any stable public contract and can change between
loader versions.

A `version` field reflects whatever the plugin's own manifest declares at install time. It is not
necessarily the code actually running: a plugin loaded from a local dev build often keeps
whatever version string was baked in at build time, which can lag behind the source on disk. Treat
it as a hint, not proof of what commit is deployed — if that matters, it needs a marker the plugin
itself exposes (a global, a version RPC, a visible label in its own UI), which is specific to that
plugin and outside this reference.

---

## Finding a plugin's rendered UI

A plugin's Quick Access Menu panel, and anything it injects into Big Picture, renders as ordinary
React output inside `SharedJSContext` — inspect it with `dom`, `text`, and `styles` exactly as you
would Steam's own UI (see `reference/targets.md`). There is no separate CDP target for "a plugin";
`--target Plugin Name` does not exist and is not a thing to try.

```bash
node $S menu QuickAccess              # open the panel a plugin might live in
node $S text '#QuickAccess-Menu'      # read whatever panel is showing
```

A plugin registers its own tab/panel inside the QAM tab strip via Decky's `tabsHook`; there is no
general CDP-visible way to jump straight to one plugin's tab without knowing that plugin's own DOM
structure (a stable `data-*` attribute or class if it has one, discovered the normal way — `dom`,
`classes`).

---

## What is generally NOT reachable from CDP

- **A plugin's own backend (Python) state.** Decky's frontend-to-backend bridge
  (`DeckyBackend.call`) is not a generic, discoverable RPC surface from outside the plugin's own
  code — a plugin's `call()` wrapper is provided by Decky's `@decky/api` and closes over that
  specific plugin's identity when the loader constructs it. There is no supported, general
  incantation from CDP alone that reaches an arbitrary plugin's Python method by name; it has been
  observed that `DeckyPluginLoader.callServerMethod` (deprecated) and `DeckyBackend.call` both
  require a route/binding this skill cannot reconstruct generically. Don't spend time guessing
  route strings — if a plugin's backend state genuinely needs inspecting, that requires either the
  plugin exposing something on `window` for debugging, a log line from its own backend, or asking
  whoever built it how its RPC is addressed.
- **A plugin's own webpack module source**, via this skill's `webpack`/`classes` commands. Those
  search `window.webpackChunksteamui`, which is Steam's own bundle registry — a Decky plugin's
  frontend is a separate bundle the loader evaluates at runtime and does not appear there.
- **Plugin frontend code as a `<script>` tag or `<iframe>`.** Decky loads plugin JavaScript via
  runtime evaluation into the existing `SharedJSContext`, not by adding a new document or a new
  CDP target — `document.scripts` and `document.querySelectorAll('iframe')` will not find it.

If a task needs any of the above, say so plainly rather than reverse-engineering a route by trial
and error (SKILL.md R2 — a Decky RPC route is exactly the kind of thing that must not be invented
from a pattern).

---

## Reference

- [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) — the loader itself
- [`@decky/api`](https://www.npmjs.com/package/@decky/api) — the frontend package plugins use to
  talk to their own backend
