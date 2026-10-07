import pytest

from api import desktop


def test_launcher_refuses_foreign_server(monkeypatch, tmp_path):
    monkeypatch.setenv('ODYLIC_FUNNEL_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(desktop.healthcheck, 'probe', lambda _: ('foreign', {'ok': True}))
    monkeypatch.setattr(desktop.subprocess, 'Popen', lambda *a, **k: pytest.fail('Must not start on a foreign port'))
    monkeypatch.setattr(desktop.webbrowser, 'open', lambda _: pytest.fail('Must not open a foreign application'))
    assert desktop.main(['--no-open', '--port', '18781']) == 1


def test_stop_does_not_kill_foreign_process(monkeypatch, tmp_path):
    monkeypatch.setenv('ODYLIC_FUNNEL_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(desktop.healthcheck, 'probe', lambda _: ('foreign', None))
    monkeypatch.setattr(desktop.healthcheck, 'stop', lambda *a: pytest.fail('Foreign process must stay running'))
    assert desktop.main(['--stop']) == 1


def test_launcher_reuses_verified_server_without_browser(monkeypatch, tmp_path):
    monkeypatch.setenv('ODYLIC_FUNNEL_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(desktop.healthcheck, 'probe', lambda _: ('ours', {'ok': True}))
    monkeypatch.setattr(desktop.subprocess, 'Popen', lambda *a, **k: pytest.fail('Must reuse the server'))
    monkeypatch.setattr(desktop.webbrowser, 'open', lambda _: pytest.fail('--no-open must not open browser'))
    assert desktop.main(['--no-open']) == 0


def test_stale_server_that_cannot_stop_is_preserved(monkeypatch, tmp_path):
    monkeypatch.setenv('ODYLIC_FUNNEL_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(desktop.healthcheck, 'probe', lambda _: ('stale', {'ok': True}))
    monkeypatch.setattr(desktop.healthcheck, 'stop', lambda *a: False)
    monkeypatch.setattr(desktop.subprocess, 'Popen', lambda *a, **k: pytest.fail('Must not replace unconfirmed server'))
    assert desktop.main(['--no-open']) == 1


@pytest.mark.parametrize('value', ['0', '-1', '65536', 'not-a-port'])
def test_invalid_port_is_rejected(value):
    with pytest.raises(SystemExit):
        desktop.main(['--port', value, '--no-open'])
