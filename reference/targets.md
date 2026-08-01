# CDP Targets, Popups & Navigation

> **Provenance.** Everything below was observed on macOS, Big Picture Mode, on 2026-07-31 against
> CEF `Chrome/126.0.6478.183`, React 19.1.1, 2560 webpack modules. Structure (which targets exist,
> what they carry) has been stable; the version numbers and module count are build-specific and are
> recorded only so drift is detectable. Never quote them as current fact — re-check with `status`
> and `targets` (SKILL.md R6).

Steam runs several CEF renderer processes. Each is a separate CDP target — effectively separate
browser tabs that cannot see each other's JavaScript. Choosing the wrong one is the most common
cause of a wrong answer.

---

## The targets

Observed in Big Picture Mode (`-gamepadui`). Titles carry a `_uid<N>` suffix tied to the parent
browser id, usually `2`. Expect four to six: the first four below are always there, while the
toast renderer is created lazily and a store window only exists while one is open.

| Alias | Title | webpack | `SteamUIStore` | Use for |
|---|---|---|---|---|
| `SharedJSContext` | `SharedJSContext` | **yes** | **yes** | All JS, webpack, React, stores — start here |
| `BigPicture` | `Steam Big Picture Mode` | no | no | Big Picture DOM and CSS |
| `QuickAccess` | `QuickAccess_uid2` | no | no | Quick Access Menu DOM and CSS |
| `MainMenu` | `MainMenu_uid2` | no | no | Main Menu DOM and CSS |
| `NotificationToasts` | `notificationtoasts_uid2` | no | no | Toast DOM and CSS |

**Only `SharedJSContext` has webpack and `SteamUIStore`.** Every other window returns `undefined`
for both. Run `eval` for application logic, `webpack`, `module`, `react`, and `stores` there;
use the other targets for DOM and CSS work only.

The `Store` alias exists in the CLI but matches only while a Steam store window is open. In Big
Picture Mode there generally isn't one and the alias fails.

### On a Steam Deck

Same roles, same `_uid2` suffixes, same webpack rule — with two differences, both verified on
hardware (`reference/remote.md`):

| | Desktop | Steam Deck |
|---|---|---|
| Target count | 4–6 | 4–6 |
| Viewport | 1280×800 at 2× | 854×534 at 1.5× |

CDP is on port **8081** there rather than 8080.

### Target URLs are misleading

Two different URLs are in play, and they disagree:

| Where | Quick Access Menu shows |
|---|---|
| `targets` output (creation URL) | `about:blank?browserviewpopup=1&requestid=2&parentpopup=2` |
| `eval 'location.href'` (live document) | `https://steamloopback.host/routes/login` |

Neither describes the content. The QAM document is populated by its parent, so `location.href`
is a leftover route and `about:blank` is only how the view was created. **Identify targets by
title or alias, never by URL.** The Big Picture window behaves the same way: created at
`about:blank?createflags=…`, actually serving `steamloopback.host/index.html`.

### Popup documents are always loaded

`QuickAccess_uid*` and `MainMenu_uid*` exist from startup and persist for the whole session. They
are shown and hidden, never created and destroyed. `notificationtoasts_uid*` is different — it is
created lazily, so check `targets` rather than assuming it is there.

The practical consequence: you can inspect their DOM at any time without opening them. With the
QAM closed, its document still contains a full element tree.

```bash
node $S dom '#QuickAccess-Menu' --target QuickAccess      # works while closed
```

**Layout is a different matter.** On a Steam Deck, a menu that has not been opened this session
reports a height of 1 — the elements exist but have never been laid out. It measures correctly
once the menu has been shown, and keeps that layout after it closes again. So before trusting
`styles` or `screenshot` on a popup, open it once:

```bash
node $S menu QuickAccess && node $S styles '#QuickAccess-Menu' --target QuickAccess
```

Stable structural ids inside the QAM document (these are hand-written, not minified, so they
survive builds — unlike class names):

```
#QuickAccess-NA      BasicUI root, position: absolute, top/left 0
#QuickAccess-Menu    the panel itself, display: flex
```

### Never reload a browser-view target

`location.reload()` on `BigPicture`, `QuickAccess`, `MainMenu`, or `NotificationToasts`
**destroys the window's content and does not come back on its own.** These documents are populated
by the parent process, not served from their URL, so a reload lands on the blank `about:blank`
they were created with. Reloading Big Picture drops Steam back to its desktop UI and leaves a
white window; `steam://open/bigpicture` recreates the target but its router never initialises
(`page` reports `currentPath: null`), so the only real fix is restarting Steam.

Reloading `SharedJSContext` is a different matter — it is served from a real URL — but there is
rarely a reason to, and it discards every injection.

### `g_PopupManager` is not the target list

`popups` reads `g_PopupManager`, which tracks real popup *windows*. The QAM and Main Menu are
browser views, so they never appear there — typically only the Big Picture window is listed.
To enumerate inspectable windows, use `targets`.

---

## Reaching a popup document

Use `--target QuickAccess` (or `MainMenu`, `NotificationToasts`). `eval`, `styles`, `dom`,
`screenshot` and `inject` all accept it, and CDP addresses the window directly.

Popup windows are also reachable by name from page JavaScript, since `SharedJSContext` and Big
Picture share a browsing context group with them — the name is `QuickAccess_uid<BPMBrowserID>`,
normally `QuickAccess_uid2`, and a real window's `document.title` equals its window name. There is
no reason to do this from a debugging session, though: `--target` is simpler and cannot create a
stray window by mistake.

---

## Navigation

Always navigate to a feature before inspecting it. Elements exist only while rendered
(SKILL.md R7).

### Routes

`navigate` calls `SteamClient.URL.ExecuteSteamURL`. Verified results in Big Picture Mode:

| Argument | Route reached |
|---|---|
| `library`, `home` | `/library/home` |
| `downloads` | `/library/downloads` |
| `settings` | `/settings/system` |
| `store` | `/steamweb` |
| `account` | none — no-op |
| `chat`, `friends` | none — no-op |

Arbitrary `steam://` URLs pass through unchanged; an unknown bare name becomes
`steam://open/<name>` and usually does nothing.

Routes are *not* the `/routes/<name>` paths that appear in URLs. The real pathname is what `page`
reports — treat that as truth and prefer route *prefixes* (`/library`, `/settings`) over exact
matches, since deep paths vary by build.

`navigate` verifies itself — it compares the route before and after and exits 1 with
`Route unchanged (…)` when nothing moved, so a no-op cannot be mistaken for success.

Rendered page content lives in the **`BigPicture`** target, while the router state lives in
`SharedJSContext`. So a normal page investigation spans two windows:

```bash
node $S navigate downloads          # drives the router (SharedJSContext)
node $S page                        # verify the route actually changed
node $S styles '.SomeClass' --target BigPicture   # inspect what rendered
```

### Overlays

```bash
node $S menu QuickAccess   # open
node $S menu MainMenu      # open
node $S menu Close         # close both
node $S page               # verify: openMenu is none | MainMenu | QuickAccess
```

Opening an overlay changes what the user sees on their own machine. Close it when finished
(SKILL.md Phase 5). Since popup documents are always loaded, you rarely need to open one — do it
only when you need the menu genuinely visible, e.g. to confirm a paint.

---

## Choosing a target

| Question | Target |
|---|---|
| What does this webpack module contain? | `SharedJSContext` |
| What React version / component tree? | `SharedJSContext` |
| What is Steam's current state? | `SharedJSContext` |
| Why is this Big Picture element styled wrong? | `BigPicture` |
| Why does the Quick Access Menu look wrong? | `QuickAccess` |
| Why is a toast clipped? | `NotificationToasts` |
| Where do I inject a theme? | The window that renders it — usually `BigPicture` |

Remember that `--target` is accepted only by `eval`, `errors`, `logs`, `styles`, and `module`
(SKILL.md R3). Passing it to `webpack`, `react`, `page`, `popups`, `stores`, `navigate`, or
`menu` exits 2 — those commands always run against the shared JS context.
