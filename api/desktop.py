"""Packaged Windows launcher. The server stays local and its identity is verified."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import webbrowser

from api import healthcheck, store


def _port(value: str) -> int:
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError('Port must be a number.') from exc
    if not 1 <= number <= 65535:
        raise argparse.ArgumentTypeError('Port must be between 1 and 65535.')
    return number


def _message(message: str, *, error: bool = False, dialog: bool = False) -> None:
    stream = sys.stderr if error else sys.stdout
    if stream:
        print(message, file=stream, flush=True)
    if dialog and sys.platform == 'win32':
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, message, 'Odylic Constellation', 0x10 if error else 0x40)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Odylic Constellation for Windows')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--serve', action='store_true', help=argparse.SUPPRESS)
    mode.add_argument('--stop', action='store_true', help='Stop only this installation\'s server.')
    mode.add_argument('--status', action='store_true', help='Check this installation\'s server.')
    parser.add_argument('--no-open', action='store_true', help='Start without opening a browser.')
    parser.add_argument('--port', type=_port, default=_port(os.environ.get('ODYLIC_PORT', '8777')))
    args = parser.parse_args(argv)
    url = f'http://127.0.0.1:{args.port}'
    log_dir = store.data_dir() / 'logs'
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / 'server.log'

    if args.serve:
        # Windowed executables have no stdout/stderr. Uvicorn needs real streams.
        if sys.stdout is None:
            sys.stdout = open(log_file, 'a', encoding='utf-8', buffering=1)
        if sys.stderr is None:
            sys.stderr = sys.stdout
        import uvicorn
        uvicorn.run('api.main:app', host='127.0.0.1', port=args.port, log_level='warning')
        return 0

    state, _ = healthcheck.probe(url)
    if args.status:
        _message(json.dumps({'state': state, 'url': url}))
        return 0 if state in ('ours', 'stale') else 1
    if args.stop:
        if state == 'down':
            _message('Odylic Constellation is stopped.')
            return 0
        if state not in ('ours', 'stale') or not healthcheck.stop(url, state):
            _message('Could not verify and stop this installation\'s server.', error=True)
            return 1
        _message('Odylic Constellation stopped.')
        return 0

    if state == 'stale':
        if not healthcheck.stop(url, state):
            _message('The previous version could not be stopped. Close it before starting this version.',
                     error=True, dialog=not args.no_open)
            return 1
        state = 'down'
    if state not in ('down', 'ours'):
        _message(f'Port {args.port} is in use by another application. Start Constellation with --port 8778.',
                 error=True, dialog=not args.no_open)
        return 1
    if state == 'down':
        if getattr(sys, 'frozen', False):
            command = [sys.executable, '--serve', '--port', str(args.port)]
            working_dir = str(Path(sys.executable).resolve().parent)
        else:
            command = [sys.executable, '-m', 'uvicorn', 'api.main:app', '--host', '127.0.0.1',
                       '--port', str(args.port), '--log-level', 'warning']
            working_dir = str(Path(__file__).resolve().parent.parent)
        with open(log_file, 'ab') as log:
            child = subprocess.Popen(command, cwd=working_dir, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log,
                                     creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            state, _ = healthcheck.probe(url, timeout=1)
            if state == 'ours':
                break
            if child.poll() is not None:
                break
            time.sleep(0.2)
        if state != 'ours':
            _message(f'Constellation could not start. See the log at {log_file}.',
                     error=True, dialog=not args.no_open)
            return 1
    if not args.no_open:
        webbrowser.open(url)
    _message(f'Odylic Constellation is running at {url}')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        _message('Constellation could not start. Check permissions for your local application data folder.',
                 error=True, dialog='--no-open' not in sys.argv and '--serve' not in sys.argv)
        raise
