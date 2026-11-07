import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { HERDR, NAME, ROOT, logEvent, paths, readSensor, renderMod, sample, writeAtomic } from '../helper.mjs';
import { launchAgent } from '../manage.mjs';

const execute = promisify(execFile);
const template = await readFile(join(ROOT, 'mod', 'main.luau.template'), 'utf8');
const ok = value => ({ value, error: null });
const unavailable = { value: null, error: 'sensor read failed' };
const snapshot = (cpu = ok(52.4), gpu = ok(46.2)) => ({ cpu, gpu, sampledAt: '2026-11-07T09:00:00.000Z' });

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-temperature-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('reads Celsius and bounds the sensor subprocess', async () => {
  const result = await readSensor('/sensor', '-c', async (binary, args, options) => {
    assert.equal(binary, '/sensor');
    assert.deepEqual(args, ['-c', '-n80', '-i25']);
    assert.equal(options.timeout, 3000);
    assert.equal(options.killSignal, 'SIGKILL');
    return { stdout: ' 52.4\n' };
  });
  assert.deepEqual(result, ok(52.4));
});

test('rejects empty, malformed, nonfinite, zero and negative readings', async () => {
  for (const stdout of ['', ' ', '0', '-1', 'NaN', 'Infinity', '52°C', '52\n46', '1'.repeat(400), '1; os.execute("bad")']) {
    assert.deepEqual(await readSensor('/sensor', '-c', async () => ({ stdout })), {
      value: null, error: 'invalid sensor reading',
    });
  }
});

test('reports a genuinely missing executable without throwing', async () => {
  assert.deepEqual(await readSensor('/nonexistent/herdr-temperature-sensor', '-c'), {
    value: null, error: 'sensor executable missing',
  });
});

test('terminates a stalled sensor and reports its timeout', async t => {
  const binary = join(await temporary(t), 'stalled-sensor');
  await writeFile(binary, '#!/bin/sh\nexec /bin/sleep 30\n');
  await chmod(binary, 0o700);
  const started = Date.now();
  assert.deepEqual(await readSensor(binary, '-c'), { value: null, error: 'sensor read timed out' });
  assert.ok(Date.now() - started < 10000, 'sensor did not respect the timeout');
});

test('reports unsuccessful sensor exit without exposing raw stderr', async () => {
  assert.deepEqual(await readSensor('/sensor', '-g', async () => {
    throw Object.assign(new Error('untrusted error'), { code: 1 });
  }), unavailable);
});

test('publishes partial failures independently and recovers on the next sample', async t => {
  const dir = await temporary(t);
  const first = await sample('/sensor', template, dir, async (_, flag) => flag === '-c' ? ok(41.7) : unavailable);
  assert.equal(first.cpu.value, 41.7);
  assert.match(await readFile(join(dir, 'main.luau'), 'utf8'), /Mac CPU 42°C · GPU N\/A/);
  await sample('/sensor', template, dir, async (_, flag) => flag === '-c' ? ok(43.2) : ok(47.8));
  const recovered = await readFile(join(dir, 'main.luau'), 'utf8');
  assert.match(recovered, /Mac CPU 43°C · GPU 48°C/);
  assert.doesNotMatch(recovered, /sensor read failed|N\/A/);
});

test('atomic replacement never exposes a partial file or leaves temporary files', async t => {
  const dir = await temporary(t);
  const file = join(dir, 'main.luau');
  const old = 'old'.repeat(10000);
  const next = 'new'.repeat(10000);
  await writeAtomic(file, old);
  let finished = false;
  const writing = writeAtomic(file, next).finally(() => { finished = true; });
  do { assert.ok([old, next].includes(await readFile(file, 'utf8'))); } while (!finished);
  await writing;
  assert.equal(await readFile(file, 'utf8'), next);
  assert.deepEqual(await readdir(dir), ['main.luau']);
});

test('bounds the helper log even after repeated failures', async t => {
  const log = join(await temporary(t), 'logs', 'helper.log');
  await mkdir(dirname(log));
  await writeFile(log, 'x'.repeat(65536));
  await logEvent(log, 'y'.repeat(100000));
  assert.ok((await readFile(log)).length < 65536);
});

test('supports XDG config location and XML-safe absolute launch arguments', () => {
  const locations = paths('/home/user', '/config with spaces');
  assert.equal(locations.mod, '/config with spaces/herdr/gpui-mods/machine-temperature');
  assert.equal(paths('/home/user', '').mod, '/home/user/.config/herdr/gpui-mods/machine-temperature');
  const plist = launchAgent('/node & runtime', '/sensor<1>', locations);
  assert.match(plist, /<string>\/node &amp; runtime<\/string>/);
  assert.match(plist, /<string>\/sensor&lt;1&gt;<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});

test('installation and removal refuse to touch an unmanaged mod', async t => {
  const home = await temporary(t);
  const configHome = join(home, 'config');
  const locations = paths(home, configHome);
  await mkdir(locations.mod, { recursive: true });
  const sentinel = join(locations.mod, 'main.luau');
  await writeFile(sentinel, 'existing user mod');
  for (const action of ['install', 'uninstall']) {
    await assert.rejects(execute(process.execPath, [join(ROOT, 'manage.mjs'), action], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
    }), error => error.code === 1 && error.stderr.includes('unmanaged mod'));
    assert.equal(await readFile(sentinel, 'utf8'), 'existing user mod');
  }
});

test('Herdr validates healthy, partial, unavailable and escaped-input mod fixtures', async t => {
  const root = await temporary(t);
  const dir = join(root, NAME);
  await mkdir(dir);
  await writeFile(join(dir, 'mod.toml'), await readFile(join(ROOT, 'mod', 'mod.toml')));
  const escaped = { value: null, error: 'quote" backslash\\ newline\n control\u0001 literal\\u0001 __LABEL__' };
  for (const fixture of [snapshot(), snapshot(ok(52), unavailable), snapshot(unavailable, unavailable), snapshot(escaped, unavailable)]) {
    const rendered = renderMod(template, fixture);
    assert.match(rendered, /Local Mac temperatures/);
    await writeAtomic(join(dir, 'main.luau'), rendered);
    await execute(HERDR, ['mod', 'check', dir]);
  }
});
