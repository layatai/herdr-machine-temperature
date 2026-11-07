import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

export const NAME = 'machine-temperature';
export const LABEL = 'local.herdr.machine-temperature';
export const ROOT = dirname(fileURLToPath(import.meta.url));
export const HERDR = '/Applications/Herdr.app/Contents/MacOS/Herdr';
export const INTERVAL_MS = 5000;
const execute = promisify(execFile);

export function paths(home = homedir(), configHome = process.env.XDG_CONFIG_HOME) {
  return {
    mod: join(configHome || join(home, '.config'), 'herdr', 'gpui-mods', NAME),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    log: join(home, 'Library', 'Logs', 'herdr-machine-temperature', 'helper.log'),
  };
}

export async function readSensor(binary, flag, run = execute) {
  try {
    // Briefly retry missing SMC samples without reusing a previous temperature.
    const { stdout } = await run(binary, [flag, '-n80', '-i25'], {
      timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 4096,
    });
    const raw = stdout.trim();
    if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) <= 0) {
      return { value: null, error: 'invalid sensor reading' };
    }
    return { value: Number(raw), error: null };
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'sensor executable missing'
      : error.killed || error.signal === 'SIGKILL' ? 'sensor read timed out'
        : 'sensor read failed';
    return { value: null, error: reason };
  }
}

export function renderMod(template, snapshot) {
  const text = (name, sensor) => `${name} ${sensor.value === null ? 'N/A' : `${Math.round(sensor.value)}°C`}`;
  const cpu = text('CPU', snapshot.cpu);
  const gpu = text('GPU', snapshot.gpu);
  const failures = [['CPU', snapshot.cpu], ['GPU', snapshot.gpu]]
    .filter(([, sensor]) => sensor.error)
    .map(([name, sensor]) => `${name}: ${sensor.error}`);
  const values = {
    __LABEL__: `Mac ${cpu} · ${gpu}`,
    __TOOLTIP__: [
      'Local Mac temperatures (not the selected remote host)',
      `${cpu} · ${gpu}`,
      `Last sample: ${snapshot.sampledAt}`,
      ...failures,
    ].join(' | '),
    __TONE__: failures.length ? 'muted' : 'normal',
  };
  const luaString = value => '"' + value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return template.replace(/__LABEL__|__TOOLTIP__|__TONE__/g,
    key => luaString(values[key]));
}

export async function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function sample(binary, template, modDir, read = readSensor) {
  const [cpu, gpu] = await Promise.all([read(binary, '-c'), read(binary, '-g')]);
  const snapshot = { cpu, gpu, sampledAt: new Date().toISOString() };
  await writeAtomic(join(modDir, 'main.luau'), renderMod(template, snapshot));
  return snapshot;
}

export async function logEvent(file, message) {
  await mkdir(dirname(file), { recursive: true });
  // Keep the helper's own log below 64 KiB without a separate rotation service.
  try {
    if ((await stat(file)).size > 63 * 1024) await writeFile(file, '', { mode: 0o600 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await appendFile(file, `${new Date().toISOString()} ${String(message).slice(0, 800)}\n`, { mode: 0o600 });
}

async function main() {
  const [binary, modDir, log] = process.argv.slice(2);
  if (!binary || !modDir || !log) throw new Error('Usage: node helper.mjs SMCTEMP MOD_DIR LOG_FILE');
  const template = await readFile(join(ROOT, 'mod', 'main.luau.template'), 'utf8');
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
  await logEvent(log, 'Helper started');
  let previousError;
  while (!controller.signal.aborted) {
    const started = Date.now();
    const snapshot = await sample(binary, template, modDir);
    const errors = JSON.stringify([snapshot.cpu.error, snapshot.gpu.error]);
    if (errors !== previousError) {
      await logEvent(log, errors === '[null,null]' ? 'CPU and GPU sensors available' : errors);
      previousError = errors;
    }
    try {
      await sleep(Math.max(1, INTERVAL_MS - (Date.now() - started)), undefined, { signal: controller.signal });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async error => {
    console.error(error.message);
    if (process.argv[4]) await logEvent(process.argv[4], error.message).catch(() => {});
    process.exitCode = 1;
  });
}
