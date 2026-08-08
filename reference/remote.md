# Remote Debugging — Steam Deck & SteamOS

Debugging a Steam client on another machine over the network.

> **Verified on hardware.** Everything below was exercised against a physical Steam Deck on
> 2026-07-31, over Wi-Fi from macOS, running the same Steam build as the desktop client
> (CEF `Chrome/126.0.6478.183`, React 19.1.1, 2560 webpack modules). Build-specific numbers are
> recorded for drift detection only — re-check them, never quote them (SKILL.md R6).

---

## Enable on the device

**Settings → System → Developer → CEF Remote Debugging**, then restart Steam on the device.

This is the SteamOS equivalent of `-cef-enable-debugging`.

## Connect

**The Deck serves CDP on port 8081, not 8080.** That port is in the default probe list, so the
hostname alone is enough:

```bash
node $S doctor --host steamdeck
node $S status --host steamdeck --port 8081   # explicit, if the default probe is too slow
```

Every command accepts `--host`. Target WebSocket URLs are rewritten to the host you actually
reached, because Steam always advertises `localhost` regardless of where the request came from.

`steamdeck` resolves over mDNS on a typical home network. If it does not, use the IP from
Settings → Internet → (active connection) → IP Address, and probe by hand:

```bash
curl http://steamdeck:8081/json/version
```

Connecting to a non-local host prints a security warning on **stderr** every time. That is
deliberate: **the CDP endpoint is unauthenticated**, so anyone who can reach that port can run
arbitrary JavaScript inside the user's Steam client. It goes to stderr so it never corrupts
`--json` output on stdout.

### SSH tunnel

On an untrusted network, forward the port instead of exposing it:

```bash
ssh -L 8081:localhost:8081 deck@steamdeck
node $S status --port 8081        # no --host needed; it is localhost now
```

Requires SSH enabled on the Deck (`passwd` to set a password, then
`sudo systemctl start sshd`).

---

## What differs from desktop

The Deck runs the same Steam build and the same UI, so `webpack`, `classes`, `react`, `module`
and `stores` behave identically — module IDs and class names matched the desktop client exactly.
These are the differences that matter:

| | Desktop (macOS, `-gamepadui`) | Steam Deck |
|---|---|---|
| CDP port | 8080 | **8081** |
| Targets | 4–6, depending on what has been created | 4–6, same |
| Viewport | 1280×800 CSS | **854×534 CSS** |
| Device pixel ratio | 2 | **1.5** |
| Screenshot size | 2560×1600 | **1281×801** |
| Big Picture `browserType` | 3 | 4 |

### Targets

```
SharedJSContext           https://steamloopback.host/routes/…   webpack ✓  SteamUIStore ✓
Steam Big Picture Mode    about:blank?createflags=…             webpack ✗  SteamUIStore ✗
QuickAccess_uid2          about:blank?browserviewpopup=…        webpack ✗  SteamUIStore ✗
MainMenu_uid2             about:blank?browserviewpopup=…        webpack ✗  SteamUIStore ✗
```

Same `_uid2` suffixes and the same rule as desktop: **only `SharedJSContext` has webpack and
`SteamUIStore`.**

`notificationtoasts_uid*` is **created lazily** on both platforms — it was absent from a freshly
started Deck and present later in the same session. Treat it as optional rather than as a
platform difference, and check `targets` rather than assuming.

### Popup layout is collapsed until first opened

On the Deck, a Quick Access Menu that has not been opened this session reports a **height of 1**:

```
closed (never opened):  { x: 0, y: 0, width: 854, height: 1 }
open:                   { x: 0, y: 0, width: 854, height: 454 }
closed again:           { x: 0, y: 0, width: 854, height: 454 }
```

The document and element tree exist throughout — `dom` and `eval` work fine — but there is no
layout to measure until the menu has been shown once, after which it persists.

**So open the menu once before trusting any `styles` or `screenshot` measurement of it.** The
desktop notes say popup documents can be inspected at any time; that is true of the DOM, but
layout needs the menu to have been rendered at least once.

### Behaviour that carried over unchanged

Verified directly on the device: `status`, `doctor`, `targets`, `page`, `stores`, `react`,
`styles`, `dom`, `classes`, `webpack`, `screenshot` (including `--settle`), `navigate`, and
`menu`. Route names match desktop, and `navigate account` is the same no-op, correctly reported
as `Route unchanged`.

### Backend logs and restart

`logs --source backend` and `console` go through `SteamClient`, which the Deck has like any other
client — so Steam's own log stream is readable over the network with **no SSH, no password, and
nothing installed on the device**. This is the one capability a Deck otherwise lacks entirely: on
a desktop you could launch Steam from a terminal to see the same output, and in Game Mode you
cannot.

```bash
node $S logs --source backend --host steamdeck --level error
node $S console app_status 570 --host steamdeck
```

`restart js --confirm` works remotely and is the right recovery step for a wedged UI.

**`restart client` is refused over `--host`.** Relaunching Steam means starting a process on that
machine, and Steam's own restart drops the debugging flag, so the client would come back
unreachable with no way to fix it remotely. If a Deck's client needs a full restart, the user has
to do it on the device.

> Both commands were verified on desktop. They have not yet been run against a Deck — the device
> was unavailable when this was written. Confirm before treating Deck behaviour as established
> (SKILL.md §9 check 11).

---

## Developing for a Deck on a desktop

You can make a desktop client lay out exactly like a Deck, which is useful for building a plugin
that has to look right on both without a device permanently to hand.

| | CSS viewport | Device scale | Physical |
|---|---|---|---|
| Steam Deck | 854×534 | 1.5 | 1280×800 |
| Desktop Big Picture | whatever the window is | 2 | — |

**CSS viewport is what drives layout**, not physical pixels. A Deck lays out at 854×534 and scales
up by 1.5; a desktop window of the same physical size still lays out at 1280×800 and therefore
reflows differently — directly observed as **four** news columns on desktop against the Deck's
**three**.

Launch flags alone cannot fix that. There is no `-width`/`-height`/`-resolution` argument, and of
the display flags that do work (see `launch-options.md`), `-steamdeckdisplay` sets the window to
1280×800 and `-disablehighdpi` drops the scale factor to 1 — the right *physical* pixels, still
the wrong layout viewport.

`Emulation.setDeviceMetricsOverride` is what matches layout:

```bash
# 1. Launch with the right window size and aspect
open -a Steam --args -dev -windowed -cef-enable-debugging -gamepadui -steamdeckdisplay

# 2. Override the CSS viewport (CDP, against the BigPicture target)
#    width 854, height 534, deviceScaleFactor 1.5
```

At 854×534 @1.5 the desktop UI reflows to the Deck's layout — same shelf structure, same
three-column news grid — and a capture taken in that session is **1281×801, the same dimensions as
a real Deck capture**.

Four behaviours to plan around, all established by experiment:

| Behaviour | Consequence |
|---|---|
| The CSS size **persists** after the CDP session closes | A one-shot override works; later commands see it |
| `deviceScaleFactor` **does not persist** — it reverts to native | Anything needing 1.5× must set it in its own session |
| `clearDeviceMetricsOverride` alone **does not restore** | Reset by setting an explicit override back to the real window size, *then* clearing |
| The OS window is untouched | This is a render override, not a resize; content is letterboxed |

The CLI has no `viewport` command for this yet — it is done through raw CDP.

**Cross-device `screenshot --diff` will not work even so.** Two machines have different game
libraries, so the pixels differ regardless of layout. What you get is layout parity to develop
against, not image equality. For automated cross-device checks compare `dom` output or measured
`styles` rects instead.

---

## Injection on a Deck

Everything in `reference/injection.md` applies. The stakes are a little higher because in Game
Mode the gamepad is the only input, so anything that swallowed navigation would be harder to
recover from than on a desktop.

**Overlays do not swallow it.** A full-viewport `body::after { position: fixed; pointer-events:
none }` was injected into Big Picture on a physical Deck and tested by hand: stick, D-pad, face
buttons and the touchscreen all kept working, and the Quick Access and STEAM buttons still opened
their menus. Earlier notes claimed the opposite; that claim did not survive contact with hardware
and has been removed.

Recovery does not need the controller in any case — CDP reaches the device over the network:

```bash
node $S inject list --host steamdeck --target BigPicture
node $S inject remove <slug> --host steamdeck --target BigPicture
```

Verify that round trip with a harmless injection *before* injecting anything that paints over the
whole UI, so the escape hatch is known-good rather than assumed.

Restarting Steam on a Deck costs the user their Game Mode session, so R9 applies with extra force.
