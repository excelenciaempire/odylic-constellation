import pytest


@pytest.fixture(autouse=True)
def temp_data_dir(tmp_path, monkeypatch):
    """Every test gets its own DATA_DIR so no real state is touched."""
    d = tmp_path / "data"
    monkeypatch.setenv("ODYLIC_FUNNEL_DATA_DIR", str(d))
    monkeypatch.delenv("ODYLIC_META_MAX_PER_HOUR", raising=False)
    return d


class FakeClock:
    def __init__(self, start=1_800_000_000.0):
        self.t = start

    def __call__(self):
        return self.t

    def sleep(self, secs):
        self.t += secs


@pytest.fixture
def clock(monkeypatch):
    from api import governor
    c = FakeClock()
    monkeypatch.setattr(governor, "_now", c)
    monkeypatch.setattr(governor, "_sleep", c.sleep)
    return c


# The app only answers requests that name this machine (see main.LocalGuard).
LOCAL = "http://127.0.0.1:8777"
