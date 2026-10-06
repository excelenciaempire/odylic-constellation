"""Odylic Constellation backend."""

__version__ = "1.0.0"


def build_id() -> str:
    """A short fingerprint of the backend code on disk (every api/*.py file).
    The server reports the one it started with; the launchers compute it again
    from disk, so after an update they can tell that the running server is an
    older build and restart it."""
    import hashlib
    from pathlib import Path

    h = hashlib.sha256(__version__.encode("utf-8"))
    here = Path(__file__).resolve().parent
    for p in sorted(here.glob("*.py")):
        h.update(p.name.encode("utf-8"))
        try:
            h.update(p.read_bytes())
        except OSError:
            pass
    return h.hexdigest()[:16]
