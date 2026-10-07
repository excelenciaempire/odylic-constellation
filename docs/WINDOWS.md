# Windows edition

Odylic Constellation for Windows keeps the upstream MIT license and attribution. It runs
the same local API, demo data, rate governor and 3D interface. It reads Meta data; it never
changes campaigns, budgets or ads.

## Desktop installer and portable package

The Windows release includes the app runtime and web assets. Python, Node.js, Git and
administrator access are not required. Install for your own account, then open
**Odylic Constellation** from the Start menu. The portable package can be extracted into
a folder you own; open its executable from that folder.

The app starts its server only on `127.0.0.1:8777` and opens that address after verifying
the server's identity. It starts with demo ads so connecting Meta is optional. The local
server keeps running when the browser tab closes. Use **Stop Odylic Constellation** in the
Start menu to stop it. For the portable version, run this from its folder:

```powershell
& '.\Odylic Constellation.exe' --stop
```

To start the packaged app without opening a browser or use another port:

```powershell
& '.\Odylic Constellation.exe' --no-open --port 8778
& '.\Odylic Constellation.exe' --stop --port 8778
```

## Build and run from source

Prerequisites: Windows 10/11, Windows PowerShell 5.1 or later, Git, Python 3.10+ and
Node.js 20.19+ or 22.12+. Newer supported Node.js releases also work.

1. Download this Windows fork or clone it using Git.
2. Open PowerShell in the checkout folder.
3. Install the runtime, build the interface and create shortcuts:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -InstallDirectory "$PWD" -SkipGit -DesktopShortcut
```

4. Open the Start menu shortcut or double-click `start.cmd`.

`-ExecutionPolicy Bypass` applies to this one PowerShell process. It does not change your
Windows execution policy. The installer reports missing prerequisites and stops on any
failed command; a failed dependency install or web build is never reported as success.

For a different installation folder, pass `-InstallDirectory`. For a Git installation,
pass `-Repository owner/repository` (or the full HTTPS Git URL) and omit `-SkipGit`.
The installer uses a fast-forward update, preserving local edits instead of overwriting them.
If its own server was running, it stops that server before replacing code and restarts it
after a successful build. An unrelated program using the port is never stopped.

## Start, stop, and choose a port

Run without opening a browser:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Background
```

Run in the terminal, with Ctrl+C to stop:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

Stop the source installation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
```

Choose another port if `8777` is occupied. Use the same value when stopping:

```powershell
$env:ODYLIC_PORT = '8778'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Background -OpenBrowser
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
```

The launcher verifies a random HMAC challenge and the process's executable before stopping
anything. Its source process must use this checkout's `.venv\Scripts\python.exe` and
`-m uvicorn api.main:app`; the desktop build must use its own executable and the server flag.
Ambiguous process ownership is refused.

## Meta connection and privacy

Use **Connect your Meta** in the app. You can paste a system-user token with `ads_read`,
or use `ACCESS_TOKEN` and `AD_ACCOUNT_ID` from the environment, the checkout's `.env`, or
`%USERPROFILE%\.env`. The Meta CLI does not need to run, and its credentials are never
logged or returned by the status API.

Config, cache, thumbnails and the persisted rate budget live under:

```text
%LOCALAPPDATA%\Odylic Constellation
```

The folder and secret/config files use private NTFS permissions for your Windows account
and SYSTEM. Windows administrators retain the usual ability to take ownership.
`ODYLIC_FUNNEL_DATA_DIR` can select another writable **NTFS** data folder. If private
permissions cannot be applied, the app refuses to proceed. The rate governor uses Windows
byte-range file locks, so multiple app processes still share one API safety budget.

The local API has no login. Other users on the same computer can reach it while it runs;
stop the app before switching to an untrusted Windows user. LAN binding is refused unless
explicitly enabled through `ODYLIC_ALLOW_LAN=1`.

## Troubleshooting and removal

Source-launcher logs are in `%LOCALAPPDATA%\Odylic Constellation\logs\server.log` and
`server-error.log`. Logs rotate when larger than 1 MB. The app refuses to open the browser
if startup fails or another application owns the selected port.

For **port in use**, choose another port using the example above. For **Python environment
missing** or **web app not built**, rerun the source installer from the checkout. A Meta
throttle keeps your cached data available and retries only when the shared governor allows it.

To remove the source version, run `stop.cmd`, then remove its checkout and its Start menu /
Desktop shortcuts. Delete `%LOCALAPPDATA%\Odylic Constellation` only when you intend to
remove the saved Meta connection, cached data and API budget. The desktop installer can be
removed through Windows Settings → Apps.
