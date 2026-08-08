# The `SteamClient` API

`SteamClient` is the bridge from Steam's UI to its backend. It exists **only in
`SharedJSContext`** — every other target is a plain renderer without it.

Full TypeScript definitions live in [`docs/steam-client/`](../docs/steam-client/), one file per
namespace, indexed by [`docs/steam-client/index.ts`](../docs/steam-client/index.ts). Read those
for signatures. This page covers what matters for debugging, and which parts this skill already
wraps.

> Those definitions are community-maintained and describe *a* Steam build, not necessarily the one
> you are attached to. Confirm a method exists before relying on it (SKILL.md R6):
>
> ```bash
> node $S eval 'typeof SteamClient.Console?.ExecCommand'
> ```

---

## What the CLI already wraps

Reach for the command before the raw API — the commands add verification, error reporting and
reversibility that a bare `eval` does not.

| Need | Command | Underlying API |
|---|---|---|
| Backend log stream | `logs --source backend` | `Console.RegisterForSpewOutput` |
| Run a console command | `console <cmd>` | `Console.ExecCommand` |
| List console commands | `console list` | `Console.GetAutocompleteSuggestions` |
| Restart the UI | `restart js --confirm` | `Browser.RestartJSContext` |
| Restart the client | `restart client --confirm` | *(deliberately not `User.StartRestart`)* |
| Navigate | `navigate <page>` | `URL.ExecuteSteamURL` |

---

## `Console` — the developer console

The most useful namespace for debugging, and the one that closes the gap between "my code ran"
and "Steam refused it".

| Method | Notes |
|---|---|
| `ExecCommand(cmd)` | Returns nothing; the answer arrives as spew |
| `GetAutocompleteSuggestions(prefix)` | The only way to enumerate the command table |
| `RegisterForSpewOutput(cb)` | `{ spew, spew_type }` where type is `assert\|error\|warning\|info\|input` |

Spew is **client-wide**: a command issued from one connection is seen by every listener. That is
what makes `logs --source backend` work while another process drives the client.

---

## Restart and shutdown — `User`, `Browser`

| Method | Effect |
|---|---|
| `Browser.RestartJSContext()` | Reloads the UI context. Client keeps running, CDP returns in about a second |
| `User.StartShutdown(force)` | Clean shutdown |
| `User.StartRestart(force)` | Restarts Steam — **strips `-cef-enable-debugging`**, see below |
| `User.CancelShutdown()` | Aborts a shutdown in progress |
| `User.RegisterForShutdownStart/State/Done(cb)` | Watch a shutdown happen |

**`User.StartRestart()` is a trap for this skill.** It does restart Steam, but the relaunched
process does not carry the debugging flag, so the client comes back alive and unreachable and the
session is over. Measured on macOS. `restart client` shuts down and launches Steam itself for
exactly this reason — see `commands.md`.

`System.RestartPC()`, `System.ShutdownPC()`, `System.FactoryReset()` and
`System.RebootToAlternateSystemPartition()` also exist. None of them are in scope here.

---

## Reading device and client state

| Call | Gives you |
|---|---|
| `System.GetSystemInfo()` | OS, kernel, BIOS, Steam version, CPU, RAM, GPU — and the hardware serial number |
| `System.GetOSType()` | `EOSType` enum |
| `System.Report.GenerateSystemReport()` | A report id, served from `https://steamloopback.host/systemreports/<id>` |
| `Settings.*` | Client settings, including `cef_remote_debugging_enabled()` |
| `Storage` / `MachineStorage` / `RoamingStorage` | The three config VDF files — see `docs/steam-client/Storage.ts` |

`GetSystemInfo()` includes a hardware serial number. Do not paste its raw output into a report or
a shared log; quote only the fields you need.

`GenerateSystemReport()` returned an id but an empty document on macOS. It is a SteamOS feature
and may behave differently on a Deck — unverified there.

---

## What is *not* reachable

- **Arbitrary local files.** `https://steamloopback.host/` serves Steam's own routes only;
  `logs/console_log.txt` and `../` traversal both return 404. There is no file-read API.
- **The system journal, coredumps, or any other process.** Nothing in `SteamClient` reaches
  outside Steam.
- **`System.Devkit`** is undefined on macOS — Deck-only.

If a task genuinely needs one of these, say so rather than improvising an on-device agent. That is
outside this skill's boundary.

---

## Using an API the CLI does not wrap

Fall back to `eval` (SKILL.md R2), and check the backend afterwards — a call with the wrong
arguments returns cleanly to JavaScript and fails only in the backend (R11):

```bash
node $S eval 'SteamClient.System.GetOSType()'
node $S logs --source backend --level error    # in another shell, or check inject's backendErrors
```

Signatures in `docs/` are the community's best reading of the client, not a contract. Arity
mismatches are the most common cause of a call that silently does nothing.
