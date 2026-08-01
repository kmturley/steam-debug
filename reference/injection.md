# Code Injection & Plugin Patterns

How to write CSS and JavaScript into a running Steam client, and the CEF rendering behaviour that
makes correct-looking code produce no visible change.

Injection mutates the user's live Steam client. SKILL.md R8 applies throughout: use `inject`,
which namespaces and registers everything it adds, and always hand over the removal command.

---

## Lifecycle

Injections live in page memory only. **Every one is lost on reload or Steam restart.** That is by
design: injection here is for iterating during development, not for shipping a change. Making a
change persist is a plugin loader's job and is out of scope for this skill (SKILL.md § Scope).

So say plainly that a change is temporary, and never imply it will still be there tomorrow.

### Choosing the window

| Injecting | Target |
|---|---|
| Big Picture visual changes | `BigPicture` |
| Quick Access Menu changes | `QuickAccess` |
| Logic touching webpack, React, or `SteamUIStore` | `SharedJSContext` |

Only `SharedJSContext` has webpack and `SteamUIStore`. Styling the Big Picture window from
`SharedJSContext` does nothing — they are separate documents.

### The `inject` command

```bash
node $S inject css theme.css --target BigPicture    # id defaults to the filename: "theme"
node $S inject js plugin.js  --target BigPicture
node $S inject list          --target BigPicture
node $S inject remove theme  --target BigPicture
```

`inject` gives every artifact a `steam-debug-<slug>` id, removes any previous version before
adding the new one (so re-running is always safe), records it in
`window.__steam_debug_injections`, and reports the removal command. Override the derived id with
`--id`.

For CSS it warns when the stylesheet parses to zero rules — the usual sign of a syntax error.

### JS teardown contract

A JS file should **return a teardown function**. `inject` stores it and calls it on
`inject remove`, and on re-injection before installing the new version.

```js
// plugin.js
const onKey = (e) => console.log("[myplugin]", e.key);
document.addEventListener("keydown", onKey);

return () => document.removeEventListener("keydown", onKey);
```

Without a teardown, `inject` warns and the only way to undo the change is a reload — which costs
the user their session. Anything that registers a listener, timer, or observer must return one.

---

## Iterating

`watch` re-injects on every save, so the edit-check loop is a single long-running command:

```bash
node $S watch css theme.css --target BigPicture
```

It uses the same slug and the same remove-then-add as `inject`, so it never stacks duplicates,
and a broken edit is reported without ending the loop. Stopping the watch leaves the injection in
place — it prints the removal command on exit.

## Verifying a visual change

**A computed style is not proof of a visible change.** `styles` tells you a rule matched and what
the browser computed. It says nothing about whether the compositor painted it. Use `screenshot`,
which captures what was actually drawn, and `--diff` to make "nothing happened" an exit code:

```bash
node $S screenshot --target BigPicture --out before.png
node $S inject css theme.css --target BigPicture
node $S screenshot --target BigPicture --out after.png --diff before.png
```

```
Changed: 20312 of 4096000 px (0.4959%), bounding box 265x104 at 66,732
```

`--diff` exits 1 when the images are identical, so an injection that computed correctly but
painted nothing fails loudly instead of passing review. The bounding box also confirms you
changed the region you intended — compare it against the element's `rect` from `styles`,
remembering the box is in device pixels.

**Capture the baseline only once the screen is quiet.** Big Picture animates for several seconds
after a route change, so a baseline taken right after `navigate` will differ from the next
capture no matter what you did. Take two captures a second apart and confirm `--diff` exits 1
before trusting the baseline.

`screenshot` cannot capture `QuickAccess`, `MainMenu`, or `NotificationToasts`: they are browser
views composited outside the page tree, and CDP capture hangs on them. A Big Picture capture with
the Quick Access Menu open shows the menu's *backdrop* effect on the library behind it, but not
the panel itself.

---

## Why paint disappears: the opaque-layer model

Big Picture's DOM is a stack of full-viewport elements:

```
body                     1280x800  transparent
└ div                    1280x800  transparent
  └ div.BasicUI          1280x800  background: rgb(0, 0, 0)   ← opaque, covers everything above
    └ div                1280x800  display: flex
      └ …the visible UI
```

`.BasicUI` paints an opaque full-viewport background. Anything you paint on `body`, or on any
ancestor above it in that chain, is drawn *behind* that layer and is never seen — regardless of
`display`, `z-index`, or `!important`.

Verified with `screenshot` on this build:

| Rule | Result |
|---|---|
| `background-color` on `body` | **Invisible** — covered by `.BasicUI` |
| `box-shadow: inset` on the full-viewport `body > *` | **Invisible** — covered by `.BasicUI` |
| `box-shadow: inset` on a small leaf element | **Visible** |

### The practical rule

**Style the element that owns the pixels you want to change — a leaf, not a full-viewport
ancestor.** Find it with `styles`, confirm its `rect` is the region you mean, and prefer the
deepest element that covers it.

Diagnosing a change that will not appear:

1. `node $S styles '<selector>' --target BigPicture` — if `rect` is the full viewport
   (1280x800), you are almost certainly behind `.BasicUI`. Move to a descendant.
2. `node $S screenshot --target BigPicture --out after.png --diff before.png` — confirm against
   the pixels, not the computed value. Exit 1 means nothing was painted.
3. If the computed value is right but nothing shows, an opaque descendant is covering it. Walk
   down the tree until you reach the element that actually draws the region.

## Overlays

A full-viewport `body::after { position: fixed; pointer-events: none }` works, and does not
interfere with gamepad, touch, or button input — tested on a Steam Deck in Game Mode. It covers
only the window you inject it into: browser-view popups are composited separately, so an overlay
on Big Picture does not cover the Quick Access or Main Menu.

---

## Finding what to style

Steam's class names are minified per build (`_1zGXSZJ-SkOi-pxNGiYxU`). They are not stable and
must never be copied from documentation or a previous session (R6).

```bash
node $S webpack 'DialogButton'                     # find the module
node $S module <id> | grep -o '_[A-Za-z0-9_-]\{8,\}' | sort -u | head
node $S styles '.<class>' --target BigPicture      # confirm it resolves and check its rect
```

More durable hooks, in order of preference:

1. **Structural ids** — `#QuickAccess-Menu`, `#QuickAccess-NA`. Hand-written, survive builds.
2. **Semantic class fragments** — `.Panel`, `.BasicUI` appear alongside minified names and are
   comparatively stable.
3. **Attribute selectors** — `[data-react-nav-root]` and similar.
4. **Minified class names** — last resort; re-resolve them on every build.

---

## Reaching Steam's internals

Only from `SharedJSContext`:

| Global | Contents |
|---|---|
| `window.webpackChunksteamui` | Webpack chunk array — presence means the bundle loaded |
| `window.SteamUIStore` | MobX state: navigation, windows, menus, gamepad routing |
| `window.SteamClient` | Native client API bridge |
| `window.g_PopupManager` | Popup window registry |
| `window.App` | `BFinishedInitStageOne()` reports init state |

`window.React` does not exist. React lives inside the bundle; reach it via `react` for the module
id, then `eval 'window.__steam_debug_wr(<id>)'`.

Use `stores` to discover a sub-store, then read specific values with `eval`. These are internal
and unversioned — a shape that works today can change in any client update, so re-verify rather
than assuming, and fail soft in anything long-lived.

---

## Pre-flight checklist for an injection

1. Preflight passed — `status` shows both `✓` (R1).
2. Correct window chosen, and it owns the elements you are styling.
3. Feature is on screen — `page` confirms the route (R7).
4. Selector resolves and its `rect` is the region you mean, not the full viewport.
5. Injected via `inject` (or `watch` while iterating), so it is namespaced and reversible (R8).
6. Verified with `screenshot --diff`, not just `styles` — a computed value is not a paint.
7. JS returns a teardown function.
8. User has the removal command, and knows a reload discards everything.
