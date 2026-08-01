/**
 * Which Steam client the smoke tests run against.
 *
 * Selected with STEAM_DEBUG_DEVICE:
 *   desktop  (default)  localhost, auto-launched if not already running
 *   deck                a Steam Deck over the network, never auto-launched
 *
 * Overrides: STEAM_DEBUG_HOST, STEAM_DEBUG_PORT, STEAM_DECK_HOST.
 *
 *   node --test test/smoke.mjs                              # desktop
 *   STEAM_DEBUG_DEVICE=deck node --test test/smoke.mjs      # Steam Deck
 *   node test/run-devices.mjs desktop deck                  # both, in sequence
 */

const PRESETS = {
  desktop: {
    name: 'desktop',
    host: null,          // null means "leave it to the CLI default"
    port: null,
    canLaunch: true,
  },
  deck: {
    name: 'deck',
    host: process.env.STEAM_DECK_HOST ?? 'steamdeck',
    port: 8081,          // SteamOS serves CDP on 8081, not 8080
    canLaunch: false,    // never start or restart Steam on someone's device
  },
};

const requested = (process.env.STEAM_DEBUG_DEVICE ?? 'desktop').toLowerCase();
const preset = PRESETS[requested];
if (!preset) {
  throw new Error(
    `Unknown STEAM_DEBUG_DEVICE "${requested}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
}

export const DEVICE = {
  ...preset,
  host: process.env.STEAM_DEBUG_HOST ?? preset.host,
  port: process.env.STEAM_DEBUG_PORT ? Number(process.env.STEAM_DEBUG_PORT) : preset.port,
};

/** The --host/--port pair for this device, or nothing when the CLI defaults are right. */
export function deviceArgs() {
  const args = [];
  if (DEVICE.host) args.push('--host', DEVICE.host);
  if (DEVICE.port) args.push('--port', String(DEVICE.port));
  return args;
}

/**
 * Add the device's connection flags to a command.
 *
 * Skipped when the test supplies its own --host or --port, so cases that deliberately point
 * somewhere else (an unreachable host, for instance) still behave as written.
 */
export function withDevice(args) {
  if (args.includes('--host') || args.includes('--port')) return args;
  return [...args, ...deviceArgs()];
}

export function describeDevice() {
  const where = DEVICE.host ? `${DEVICE.host}:${DEVICE.port ?? 'auto'}` : 'localhost (default ports)';
  return `${DEVICE.name} — ${where}`;
}
