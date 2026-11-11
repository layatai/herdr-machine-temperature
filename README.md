# Selected-machine temperatures

A Sheprd (formerly Herdr) status-bar mod showing `dellom CPU 52°C · GPU 46°C`
for the machine selected in the frontmost app window. Selecting Local samples this
Mac; selecting a saved SSH machine samples that machine. Each reading includes
the machine name. Hover for the timestamp and channel errors.

## Requirements and install

- macOS helper host, Node.js 22+, Sheprd at `/Applications/Sheprd.app`.
- `smctemp` on the local Mac (`brew install narugit/tap/smctemp`).
- Saved machines in `/opt/homebrew/bin/herdr machine list`; normal SSH credentials
  and known host keys. SSH uses batch mode and strict host-key verification.
- Remote Macs need `smctemp` in `/opt/homebrew/bin` or `/usr/local/bin`.
- Remote Linux uses readable coretemp/k10temp/zenpower CPU sensors, and
  NVIDIA (`nvidia-smi`) or amdgpu/radeon/nouveau GPU sensors. Other systems and
  inaccessible sensors show `N/A`. No remote software is installed.

```sh
npm test
npm run install:mod
```

Installation validates the generated mod, replaces this managed mod, and restarts
its user LaunchAgent `local.herdr.machine-temperature`. Keep this source directory
in place. Removal keeps the source and any sensor software:

```sh
npm run uninstall:mod
```

## Behavior

The dependency-free helper queries the app's selected host, resolves its saved
machine ID, and reads only that machine. It never substitutes local readings for
remote failures. If selection changes during a read, that reading is discarded
and the new machine shows `N/A` until sampled. Selecting a machine updates the
status bar on the next sampling cycle, normally within five seconds. Slow or
failed connections can extend a cycle; subprocesses have bounded timeouts and
cycles do not overlap.

The helper atomically replaces `main.luau`; the app reloads it. The tooltip shows
the sample timestamp and errors. A stopped helper can leave its last reading
visible. In multiple windows, the generated display follows the frontmost window;
it does not maintain a separate reading per window. A narrow window can hide the
mod. There is no history, fan control, or remote installation.

The helper restarts through launchd and bounds its log to 64 KiB at
`~/Library/Logs/herdr-machine-temperature/helper.log`. The installed mod is at
`${XDG_CONFIG_HOME:-$HOME/.config}/herdr/gpui-mods/machine-temperature`.

```sh
/Applications/Sheprd.app/Contents/MacOS/sheprd mod
/Applications/Sheprd.app/Contents/MacOS/sheprd mod check ~/.config/herdr/gpui-mods/machine-temperature
```

## Verification

Node tests cover sensor validation, timeouts, independent channel failure,
atomic publication, log bounds, installation ownership, XML escaping, and
Sheprd mod fixtures. Selected-machine regressions cover remote routing without
local reads, selection changes during sampling, missing app state, unavailable
SSH connections, malformed remote responses, and SSH timeouts.

Verified on 2026-11-11: 18/18 tests passed in 3.19 seconds, all mod fixtures
validated, and the installed helper followed Local → dellom → Local through
the supported app CLI. Dellom returned CPU 43°C / GPU 42°C. Luximini returned
no accessible sensor readings and reported N/A. Native screenshots were not
verified. The LaunchAgent bootstrap needed one retry after reinstall.
