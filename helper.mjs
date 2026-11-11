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
export const HERDR = '/Applications/Sheprd.app/Contents/MacOS/sheprd';
export const MACHINE_CLI = '/opt/homebrew/bin/herdr';
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
    __LABEL__: `${snapshot.host?.label || 'Local'} ${cpu} · ${gpu}`,
    __TOOLTIP__: [
      `Selected machine: ${snapshot.host?.label || 'Local'}`,
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

export async function sample(binary, template, modDir, read = readSensor, host = { id: 'local', label: 'Local' }) {
  const [cpu, gpu] = await Promise.all([read(binary, '-c'), read(binary, '-g')]);
  const snapshot = { cpu, gpu, host, sampledAt: new Date().toISOString() };
  await writeAtomic(join(modDir, 'main.luau'), renderMod(template, snapshot));
  return snapshot;
}

// Only CPU/GPU drivers qualify; never label a disk or battery temperature as CPU.
export const REMOTE_PROBE = `
case "$(uname -s)" in
Darwin)
  sensor=''
  for p in /opt/homebrew/bin/smctemp /usr/local/bin/smctemp; do
    if [ -x "$p" ]; then sensor="$p"; break; fi
  done
  if [ -n "$sensor" ]; then
    "$sensor" -c -n20 -i25 2>/dev/null || echo N/A
    "$sensor" -g -n20 -i25 2>/dev/null || echo N/A
  else printf 'N/A\\nN/A\\n'; fi
  ;;
Linux)
  cpu=''; gpu=''
  for d in /sys/class/hwmon/hwmon*; do
    name=$(cat "$d/name" 2>/dev/null)
    case "$name" in
      coretemp|k10temp|zenpower) cpu="$cpu $(cat "$d"/temp*_input 2>/dev/null)" ;;
      amdgpu|radeon|nouveau) gpu="$gpu $(cat "$d"/temp*_input 2>/dev/null)" ;;
    esac
  done
  printf '%s\\n' "$cpu" | awk '{for(i=1;i<=NF;i++) if($i>m)m=$i} END {if(m>0) print m/1000; else print "N/A"}'
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>/dev/null | awk '{if($1>m)m=$1} END {if(m>0)print m; else print "N/A"}'
  else
    printf '%s\\n' "$gpu" | awk '{for(i=1;i<=NF;i++) if($i>m)m=$i} END {if(m>0) print m/1000; else print "N/A"}'
  fi
  ;;
*) printf 'N/A\\nN/A\\n' ;;
esac
`;

export async function selectedHost(run = execute) {
  const { stdout } = await run(HERDR, ['host', 'list', '--json'], { timeout: 3000, maxBuffer: 65536 });
  const host = JSON.parse(stdout).find(item => item.selected);
  if (!host || typeof host.id !== 'string' || typeof host.label !== 'string') {
    throw new Error('Selected machine unavailable');
  }
  return host;
}

export async function remoteReadings(host, run = execute) {
  const missing = error => ({ cpu: { value: null, error }, gpu: { value: null, error } });
  try {
    const { stdout: machines } = await run(MACHINE_CLI, ['machine', 'list'], { timeout: 3000, maxBuffer: 65536 });
    const machine = machines.trim().split('\n').map(line => line.split('\t'))
      .find(fields => `ssh:${fields[0]}` === host.id && fields[4] === 'enabled');
    const target = machine?.[2];
    if (!target || target.startsWith('-') || /[\s\u0000-\u001f]/.test(target)) return missing('saved SSH connection unavailable');
    const { stdout } = await run('/usr/bin/ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=yes', target, REMOTE_PROBE,
    ], { timeout: 6000, killSignal: 'SIGKILL', maxBuffer: 4096 });
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length !== 2) return missing('invalid remote sensor response');
    const reading = raw => /^\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) && Number(raw) > 0
      ? { value: Number(raw), error: null } : { value: null, error: 'sensor unavailable on selected machine' };
    return { cpu: reading(lines[0]), gpu: reading(lines[1]) };
  } catch (error) {
    return missing(error.killed || error.signal === 'SIGKILL' ? 'remote sensor read timed out' : 'remote connection or sensor read failed');
  }
}

export async function sampleSelected(binary, template, modDir, run = execute, read = readSensor) {
  let host = { id: '', label: 'Selected machine' };
  let cpu; let gpu;
  try {
    host = await selectedHost(run);
    if (host.id === 'local') [cpu, gpu] = await Promise.all([read(binary, '-c'), read(binary, '-g')]);
    else ({ cpu, gpu } = await remoteReadings(host, run));
    const current = await selectedHost(run);
    if (current.id !== host.id) {
      host = current;
      cpu = gpu = { value: null, error: 'waiting for selected machine sample' };
    }
  } catch {
    cpu = gpu = { value: null, error: 'selected machine unavailable' };
  }
  const snapshot = { host, cpu, gpu, sampledAt: new Date().toISOString() };
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
    const snapshot = await sampleSelected(binary, template, modDir);
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
