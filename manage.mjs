import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { HERDR, LABEL, NAME, ROOT, paths, sampleSelected, writeAtomic } from './helper.mjs';

const execute = promisify(execFile);
const MARKER = 'Managed by herdr-machine-temperature v1\n';

export function escapeXml(value) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

export function launchAgent(node, binary, locations) {
  const args = [node, join(ROOT, 'helper.mjs'), binary, locations.mod, locations.log];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map(arg => `<string>${escapeXml(arg)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

async function optionalRead(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function findSensor() {
  for (const dir of [...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (!dir.startsWith('/')) continue;
    const binary = join(dir, 'smctemp');
    try { await access(binary, constants.X_OK); return binary; }
    catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error('Install the sensor first: brew install narugit/tap/smctemp');
}

async function stopService() {
  const target = `gui/${process.getuid()}/${LABEL}`;
  try { await execute('/bin/launchctl', ['print', target]); }
  catch (error) {
    if (error.stderr?.includes('Could not find service')) return;
    throw error;
  }
  await execute('/bin/launchctl', ['bootout', target]);
}

async function main() {
  const action = process.argv[2];
  if (!['install', 'uninstall'].includes(action)) throw new Error('Usage: node manage.mjs install|uninstall');
  if (process.platform !== 'darwin') throw new Error('This mod helper targets macOS only.');
  const locations = paths();
  const marker = join(locations.mod, '.managed');
  const ownership = await optionalRead(marker);
  let exists = false;
  try { await access(locations.mod); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists && ownership !== MARKER) throw new Error(`Refusing to replace an unmanaged mod: ${locations.mod}`);
  if (!exists && await optionalRead(locations.plist) !== null) {
    throw new Error(`Refusing to change an unowned LaunchAgent: ${locations.plist}`);
  }

  if (action === 'uninstall') {
    if (!exists) { console.log('Already uninstalled.'); return; }
    await stopService();
    await rm(locations.plist, { force: true });
    await rm(locations.mod, { recursive: true });
    await rm(dirname(locations.log), { recursive: true, force: true });
    console.log('Removed the machine-temperature mod, LaunchAgent, and helper logs. Kept source and smctemp.');
    return;
  }

  await access(HERDR, constants.X_OK);
  const binary = await findSensor();
  const staging = await mkdtemp(join(tmpdir(), 'herdr-temperature-check-'));
  try {
    const candidate = join(staging, NAME);
    await mkdir(candidate);
    await copyFile(join(ROOT, 'mod', 'mod.toml'), join(candidate, 'mod.toml'));
    const template = await readFile(join(ROOT, 'mod', 'main.luau.template'), 'utf8');
    const snapshot = await sampleSelected(binary, template, candidate);
    const checked = await execute(HERDR, ['mod', 'check', candidate]);
    console.log(checked.stdout.trim());
    await stopService();
    await mkdir(locations.mod, { recursive: true });
    await writeAtomic(marker, MARKER);
    await copyFile(join(candidate, 'mod.toml'), join(locations.mod, 'mod.toml'));
    await writeAtomic(join(locations.mod, 'main.luau'), await readFile(join(candidate, 'main.luau'), 'utf8'));
    await mkdir(dirname(locations.plist), { recursive: true });
    await writeAtomic(locations.plist, launchAgent(process.execPath, binary, locations));
    await execute('/usr/bin/plutil', ['-lint', locations.plist]);
    await execute('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, locations.plist]);
    console.log(`Installed in ${locations.mod}`);
    console.log(`CPU: ${snapshot.cpu.value ?? snapshot.cpu.error}; GPU: ${snapshot.gpu.value ?? snapshot.gpu.error}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stderr?.trim() || error.message); process.exitCode = 1; });
}
