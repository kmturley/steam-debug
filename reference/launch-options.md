# Steam Launch Options

Reference copy of Steam's command-line arguments. **Rarely needed** — the four flags in
`SKILL.md` Phase 0 cover normal debugging. Load this only when changing how Steam is launched, or
when looking for a capability the CLI does not expose.

Source: [Valve Developer Community — Command line options (Steam)](https://developer.valvesoftware.com/wiki/Command_line_options_(Steam)),
revision 496437, last edited 9 January 2026. Descriptions are Valve's; the wiki lists some
arguments twice with differing wording, merged here.

> **Documented ≠ verified.** Only the flags in the first table were tested against this Steam
> build. Everything in the full list is Valve's documentation, which is not the same as observed
> behaviour — several entries are stale, and at least one working flag (`-steamdeckdisplay`) is
> missing from it entirely. Test before relying on any of them (SKILL.md R6).

---

## Verified against gamepadui Big Picture

Tested on macOS, 2026-07-31, with the flag confirmed present in `argv` before measuring.

| Flag | Result |
|---|---|
| `-cef-enable-debugging` | ✅ Required for everything here. Opens CDP on 8080 |
| `-gamepadui` | ✅ Big Picture Mode. Required for `page`, `menu`, `stores` |
| `-dev` | ✅ Developer mode, verbose logging |
| `-windowed` | ✅ Windowed rather than fullscreen |
| `-steamdeckdisplay` | ✅ Sizes the window to exactly 1280×800 CSS px. **Undocumented** — found in `steam_osx` and `steamui.dylib` |
| `-disablehighdpi` | ✅ `devicePixelRatio` 2 → 1 |
| `-forcedesktopscaling <n>` | ❌ No effect on gamepadui; scales the desktop UI only |
| `-720p`, `-480p`, `-fulldesktopres` | ❌ No effect — legacy "tenfoot" flags, not current Big Picture |

Neither working display flag reproduces a Deck's **CSS viewport** (854×534), which is what drives
layout — see `remote.md` § Developing for a Deck on a desktop.

Flags are read **only at startup**; a running instance ignores them silently. Confirm with
`ps aux | grep steam_osx` before concluding a flag did nothing.

---

## Debugging and CEF

| Flag | Description |
|---|---|
| `-cef-enable-debugging` | Enables Chromium remote debugging, defaulting to `localhost:8080` |
| `-opendevtools` | Open Chrome devtools for shared JS context (offscreen window) on launch |
| `-openalldevtools` | Open Chrome devtools on launch for every HTML window |
| `-openoverlaydevtools` | Open Chrome devtools on creation of any overlay browsers |
| `-cef-verbose-js-logging` | Enables verbose logging of JS console events |
| `-cef-disable-js-logging` | Disables console and log file logging of JS console events |
| `-cef-verbose-logging` | Enables verbose logging from CEF |
| `-cef-enable-gpu-debugging` | Enable GPU debugging in Chromium; costs a `glGetError()` after every command |
| `-cef-disable-gpu` | Disable GPU usage in CEF (force software rendering/compositing) |
| `-cef-disable-gpu-compositing` | Disable GPU accelerated compositing in browsers |
| `-cef-force-gpu` | Force enable GPU acceleration |
| `-cef-in-process-gpu` | Runs CEF GPU processing as a thread of the browser process |
| `-cef-single-process` | Runs CEF processes in a single process |
| `-cef-disable-sandbox` / `-no-cef-sandbox` | Disables sandboxing in CEF |
| `-cef-force-sandbox` | Force sandboxing in CEF |
| `-cef-disable-seccomp-sandbox` | Disables CEF seccomp-bpf sandbox on Linux |
| `-cef-disable-breakpad` | Disables breakpad in crash dumps |
| `-cef-full-memory-crash-report` | Enables full crash dumps |
| `-cef-disable-hang-timeouts` | Disables GPU and renderer hang timeouts |
| `-cef-disable-renderer-restart` | Disable auto-restart of renderer process for existing browsers |
| `-cef-disable-occlusion` | Disables Chromium window occlusion testing on Windows |
| `-cef-ignore-certificate-errors` | Allow self-signed certificates |
| `-cef-delaypageload` / `-cef-disable-delaypageload` | Enable / disable early-out for known page loads |
| `-cef-enable-samesite-by-default-cookies` | Treat unspecified samesite as `samesite=lax` |
| `-cef-disable-d3d11` | Disable D3D11 usage in CEF |
| `-cef-no-linux-angle` | Don't use ANGLE for rendering backend on Linux |
| `-cef-force-32bit` | Forces usage of 32-bit steamwebhelper when available |
| `-cef-use-shell-exec` | Launch CEF process via sub-shell |
| `-cef-winxp` | Force running the WinXP compatible CEF browser |
| `-enable-keyring` | Enables CEF usage of the Chromium keyring |
| `-console` | Enables the Steam debug console tab |
| `-debugbutton` | Show debug button in content frame header |
| `-testbutton` | Show test button on main menu |
| `-dev` | Sets `developer` to 1; enables the debug console tab. Also opens VGUI editor (F6) / VGUI zoo (F7) |
| `-debug_steamapi` | Enables logging of Steam API functions |
| `-html-perf-monitor` | Draws html perf data |
| `-overlaytestmode` | Forces overlay testmode for debugging |
| `-toggle-overlay-html-mode` | Disables new faster overlay HTML path (or enables it where off by default) |
| `-vguifocus` | Print out details of which panel has keyboard focus |
| `-vguimessages` | Set to see debug vgui2 messages |
| `-disable-winh264` | Disables loading `winh264.dll` |
| `-system-composer` | Force the use of the system browser composer |
| `-no-shared-textures` | Forces overlay to avoid sharing texture handles with game process |
| `-gameoverlayinject` | Sets the method by which GameOverlay is injected |

## UI mode and display

| Flag | Description |
|---|---|
| `-gamepadui` | Start in gamepadui mode. Same as `-tenfoot`; the Deck UI has been the Big Picture default since February 2023 |
| `-tenfoot` | Start Steam in Big Picture Mode |
| `-bigpicture` | Start in Steam Big Picture mode |
| `-nobigpicture` | Start in regular mode (force Big Picture off) |
| `-windowed` | Run tenfoot mode in a window rather than fullscreen borderless |
| `-fullscreen` | Set BPM to fullscreen |
| `-fullscreenopengl` | Use the full screen OpenGL render for the UI |
| `-opengl` | Use the OpenGL render for the UI |
| `-480p` / `-720p` | Run tenfoot in 480p / 720p rather than 1080p |
| `-fulldesktopres` | Run tenfoot at full desktop resolution rather than 1080p; overrides `-720p` |
| `-forcedesktopscaling` | Scale the desktop UI |
| `-disablehighdpi` | Disables high-DPI support in CEF |
| `-vgui` | Start in vgui mode |
| `-forcevgui` | *(no description given)* |
| `-hidelibmenu` | *(no description given)* |
| `-nointro` | Skip intro movie |
| `-noshaders` | Disable the shader manager |
| `-fasthtml` / `-nofasthtml` | Enable / disable fast child html rendering path |
| `-no-dwrite` | Force GDI text even where DWrite is available |
| `-oldtraymenu` | Use old tray menu instead of browser-based menu |
| `-silent` | Silent startup (tray mode only); suppresses the startup dialog |
| `-nofriendsui` | Prevents the friends list window showing automatically at start |
| `-unhidefriendsui` | *(no description given)* |
| `-friendsui` | *(no description given)* |

## Steam Deck and hardware

| Flag | Description |
|---|---|
| `-steamos` | *(no description given)* |
| `-forcedeckcontroller` | *(no description given)* |
| `-forcecontrollerappid` | Force a specific AppID for Steam Controller config; prevents context/app switching from changing configuration |
| `-controllertypeoverride` | *(no description given)* |
| `-batterytestmode` | Rapidly cycle battery percentages for testing |
| `-net_start_wifi_disabled` | Set initial wifi-enabled value to false. Valve's note: *"Useful when emulating SteamDeck"* |
| `-blefw` | *(no description given)* |
| `-vrdisable` / `-vrskip` / `-vrforce` / `-vronly` | VR loading control |

> `-steamdeckdisplay` and `-steammachinedisplay` exist in the binaries but are absent from Valve's
> documentation. `-steamdeckdisplay` is verified above.

## Logging and diagnostics

| Flag | Description |
|---|---|
| `-fs_log` | Log file system accesses |
| `-fs_logbins` | Log the binaries loaded during operation |
| `-fs_target` | Set target syntax |
| `-log_voice` | Writes voice chat data to `logs/voice_log.txt` |
| `-lognetapi` | Logs all P2P networking info to `log/netapi_log.txt` |
| `-ccsyntax` | Spew details about the localized strings loaded |
| `-all_languages` | Show longest loc string from any language |
| `-candidates` | Show libjingle candidates for local connection as processed |
| `-dumpvideostream` | Dump the game stream as an elementary video file |
| `-nocrashmonitor` | *(no description given)* |

## Network and backend

| Flag | Description |
|---|---|
| `-tcp` | Force backend connection via TCP (deprecated) |
| `-udpforce` | Force backend connection via UDP (deprecated) |
| `-websocket` | Force backend connection via WebSocket |
| `-websocketignorecertissues` | Ignore cert validation issues on WebSocket connections — dev use only |
| `-offlinemode` | Always attempt to start in offline mode |
| `-net_fake_state` | Set initial value for `net_fake_state` |
| `-complete_install_via_http` | Run installation completion over HTTP by default |
| `-store` / `-community` / `-help` / `-quicklogin` | Set the store / community / support / quick-login URL |

## Account, login and startup

| Flag | Description |
|---|---|
| `-login <[username]\|anonymous> [password]` | Log in with the given credentials. Steam must be off |
| `-rememberpassword` | Proceed as if "remember my password" were enabled |
| `-userchooser` | Send the user to the User Chooser even with 0 or 1 accounts |
| `-language <language>` | Set the Steam UI language, e.g. `english`, `german` |
| `-shutdown` | Shuts down (exits) Steam |
| `-silent` | Suppresses the startup dialog box. Steam must be off |
| `-nocache` | Start with no cache. Steam must be off |
| `-noverifyfiles` | Skip file integrity checking |
| `-flushconfig` | *(no description given)* |
| `-clearbeta` | Opt out of beta participation |
| `-showallbetas` | Disable client beta filtering |
| `-single_core` | Force Steam to run on the primary CPU only |
| `-noasync` | Use synchronous file operations |
| `-forceservice` | Run Steam Client Service even if Steam has admin rights |
| `-disablepartnerlicenses` | Disable automatically granted partner licenses |
| `-init_universe`, `-master_ipc_name_override`, `-private_ip_override`, `-pid`, `-accesscode`, `-clientui`, `-steamid`, `-noconsole` | *(no description given)* |

## Application launching

| Flag | Description |
|---|---|
| `-applaunch <appID> [params]` | Launch a game or application through Steam. Does not apply to non-Steam games |
| `-cafeapplaunch` | Launch apps in a cyber cafe context; forces verification before launch |
| `-install <path>` | Install a product from the given path |
| `-installer_test` | Emit retail install files to `install_validate/` instead of the steam cache |
| `-script <file>` | Run a Steam script from the `test scripts` subdirectory. Steam must be off |
| `-skipstreamingdrivers` | Skip streaming driver checks |
| `-perfectworld` | Identify processes launched by the Perfect World launcher |
| `-steam_game`, `-steaminstaller`, `-steamconsole`, `-steampath`, `-launcher` | *(internal; observed in argv)* |

## Music and misc

| Flag | Description |
|---|---|
| `-musiccrawltrack` | Add menu to crawl track and print result to console |
| `-musicdbforcerebuild` | Force a rebuild and recrawl of the music database |
| `-voice_quality` | Set audio quality, range [1,3] |
| `-voicerelay` | Only allow 'relay' connections for voice (testing) |
| `-testssa` | Force display of SSA |
| `-teststoragedata` | Enable test storage data |
| `-storebeta` | *(listed as `0`)* |
| `-enablealloobesteps`, `-force-oobe-stage1`, `-force-oobe-stage2` | Out-of-box-experience staging |
| `-enable-desktop-gl-fallback` | *(no description given)* |
| `-forcevguimarketing` | Force marketing messages to use VGUI |

## Deprecated

| Flag | Note |
|---|---|
| `-no-browser` | Disabled all CEF instances. Deprecated January 2023 |
| `-noreactlogin` | Old login UI; disabled mobile confirmations and QR login. Deprecated January 2023 |
| `-oldbigpicture` | Restored the old Big Picture UI |
| `-vgui` | VGUI as main window renderer instead of Chromium. Deprecated January 2023 |
| `-forcevguimarketing` | Deprecated |
