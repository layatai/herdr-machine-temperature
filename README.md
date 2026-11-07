# Herdr machine temperatures

A Herdr status-bar mod showing `Mac CPU 52°C · GPU 46°C` for the **local Mac**,
even when Herdr is focused on a remote host. Hover for the sample timestamp and
sensor failures. Values refresh every five seconds; failed channels show `N/A`.

## Requirements

- macOS, Herdr installed in `/Applications/Herdr.app`, and Node.js 22 or newer.
- [smctemp](https://github.com/narugit/smctemp), installed with
  `brew install narugit/tap/smctemp`. The CPU and GPU probes (`smctemp -c` and
  `smctemp -g`) run as the current user without sudo.

## Install and remove

From this folder:

```sh
npm test
npm run install:mod
```

The installer validates the mod using Herdr before installing it. It installs in
`${XDG_CONFIG_HOME:-$HOME/.config}/herdr/gpui-mods/machine-temperature` and registers
the user LaunchAgent `local.herdr.machine-temperature`. Node, the source helper,
and the sensor executable use absolute paths. Re-run installation if those paths
change. Keep this source folder in place while the helper is installed.

```sh
npm run uninstall:mod
```

Removal stops this helper and removes only its mod, LaunchAgent, and helper logs.
It keeps this source folder and the Homebrew sensor installation.

## How it works

Herdr's Luau sandbox cannot access hardware or processes. A dependency-free Node.js
helper samples the two sensors concurrently (three-second subprocess timeout,
up to 80 sensor attempts 25 ms apart without reusing old values),
then atomically replaces the mod's generated `main.luau`. Herdr reloads it using
its existing file watcher. Sampling cycles never overlap. The source template is
`mod/main.luau.template`; do not edit the generated installed file.

The helper restarts through launchd if it fails. Its log is bounded to 64 KiB at
`~/Library/Logs/herdr-machine-temperature/helper.log`. No network service, Herdr
source change, Codex source change, or administrator access is involved at runtime.

If the helper stops, the last displayed reading can remain visible: check its
timestamp in the tooltip. Herdr can hide the mod when a narrow window runs out of
status-bar space; widen the window to show it again. There are no alerts, history,
remote readings, or fan controls. Sensor availability depends on the Mac hardware
and macOS version; intermittent CPU read timeouts show `N/A` until recovery.

Check the installed mod with:

```sh
/Applications/Herdr.app/Contents/MacOS/Herdr mod
/Applications/Herdr.app/Contents/MacOS/Herdr mod check ~/.config/herdr/gpui-mods/machine-temperature
```

## Local verification

Verified on 2026-11-07 with an Apple M4 Pro, Node.js 24.11.1, smctemp 0.7.0,
and Herdr 20261102.2:

- All 11 Node tests passed, including four Herdr-validated mod fixtures.
- Six successive fresh snapshots published at approximately five-second intervals.
- After terminating only this LaunchAgent's helper, launchd restarted it and a
  fresh snapshot appeared.
- Uninstall removed the mod and LaunchAgent; reinstall restored them.
- Native rendering checked at 1512×873 and 1000×750. The narrow window hid the
  mod through Herdr's overflow handling; the original window size was restored.
