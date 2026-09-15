import { mkdir, readFile, open, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function telemetryDirectory(platform = process.platform, env = process.env, home = homedir()) {
  const base = platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'codex-mcp-bridge');
}

function resolveOptions(options = {}) {
  return { directory: telemetryDirectory(), env: process.env, platform: process.platform, now: new Date(), ...options };
}

async function readSettings(directory) {
  try {
    const settings = JSON.parse(await readFile(path.join(directory, 'telemetry.json'), 'utf8'));
    if (settings.enabled !== true || !uuidPattern.test(settings.installId)) return { enabled: false };
    return settings;
  } catch { return { enabled: false }; }
}

async function writeSettings(directory, settings) {
  const filename = path.join(directory, 'telemetry.json');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, filename);
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}

async function locked(directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, '.telemetry.lock');
  let lock;
  try {
    lock = await open(filename, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await stat(filename).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 60000) {
      await unlink(filename).catch(() => {});
      lock = await open(filename, 'wx', 0o600);
    } else throw new Error('Telemetry settings are busy. Retry in a few seconds.');
  }
  try { return await action(); }
  finally { await lock.close(); await unlink(filename).catch(() => {}); }
}

function suppressed(env) {
  return env.DO_NOT_TRACK === '1' || env.CODEX_BRIDGE_TELEMETRY === '0';
}

export async function getTelemetryStatus(options = {}) {
  const opts = resolveOptions(options);
  const settings = await readSettings(opts.directory);
  return { enabled: settings.enabled, effective: settings.enabled && !suppressed(opts.env), suppressed: suppressed(opts.env), lastReportDay: settings.lastReportDay || null, settingsPath: path.join(opts.directory, 'telemetry.json') };
}

export async function enableTelemetry(options = {}) {
  const opts = resolveOptions(options);
  await locked(opts.directory, async () => {
    const previous = await readSettings(opts.directory);
    await writeSettings(opts.directory, previous.enabled ? previous : { enabled: true, installId: randomUUID(), consentedAt: opts.now.toISOString() });
  });
  return getTelemetryStatus(opts);
}

export async function disableTelemetry(options = {}) {
  const opts = resolveOptions(options);
  await locked(opts.directory, () => writeSettings(opts.directory, { enabled: false }));
  return getTelemetryStatus(opts);
}

export async function reportUsage(options = {}) {
  try {
    const opts = resolveOptions(options);
    if (suppressed(opts.env) || !versionPattern.test(opts.version || '')) return false;
    if (!(await readSettings(opts.directory)).enabled) return false;
    const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[opts.platform];
    if (!platform) return false;
    return await locked(opts.directory, async () => {
      const settings = await readSettings(opts.directory);
      const day = opts.now.toISOString().slice(0, 10);
      if (!settings.enabled || settings.lastReportDay === day) return false;
      const config = opts.config || await import('./telemetry-config.mjs');
      const endpoint = config.TELEMETRY_ENDPOINT;
      const key = config.TELEMETRY_PUBLIC_KEY;
      if (!endpoint || !key || new URL(endpoint).protocol !== 'https:') return false;
      const controller = new AbortController();
      const timeout = Math.max(1, Math.min(opts.timeoutMs || 2000, 2000));
      let timer;
      try {
        const response = await Promise.race([
          (opts.fetcher || fetch)(endpoint, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', apikey: key },
            body: JSON.stringify({ install_id: settings.installId, version: opts.version, platform, day }),
          }),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeout); }),
        ]);
        if (!response.ok) return false;
        await writeSettings(opts.directory, { ...settings, lastReportDay: day });
        return true;
      } finally { clearTimeout(timer); controller.abort(); }
    });
  } catch { return false; }
}

export function startUsageReporting(options = {}) {
  const initialReport = reportUsage(options);
  const schedule = options.schedule || setInterval;
  const cancel = options.cancel || clearInterval;
  const timer = schedule(() => { void reportUsage(options); }, 60 * 60 * 1000);
  timer.unref?.();
  return { initialReport, stop: () => cancel(timer) };
}

export async function handleTelemetryCommand(args = process.argv.slice(2), options = {}) {
  if (args[0] !== 'telemetry') return false;
  const output = options.output || (message => process.stdout.write(`${message}\n`));
  if (args.length !== 2 || !['enable', 'disable', 'status'].includes(args[1])) {
    output('Usage: codex-mcp-bridge telemetry <enable|disable|status>');
    process.exitCode = 1;
    return true;
  }
  try {
    const status = await ({ enable: enableTelemetry, disable: disableTelemetry, status: getTelemetryStatus }[args[1]])(options);
    output(`Telemetry: ${status.effective ? 'enabled' : 'disabled'}${status.suppressed ? ' (environment override)' : ''}.`);
    output('When enabled, sends a random installation ID, package version, OS family, and UTC day; at most once per day. No prompts, paths, account IDs, or message contents.');
    if (args[1] === 'disable') output('Local installation ID removed. Previously submitted records remain until retention cleanup.');
    output(`Settings: ${status.settingsPath}`);
  } catch {
    output('Could not update telemetry settings. Check directory permissions and retry when no telemetry request is running.');
    process.exitCode = 1;
  }
  return true;
}
