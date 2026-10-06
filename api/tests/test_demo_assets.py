"""The demo images are pinned by thumbs/MANIFEST (sha256 per file), and the builder carries
no template ids that tie back to a third-party catalog."""
import hashlib
import json
from pathlib import Path

DEMO = Path(__file__).resolve().parent.parent / "demo"


def test_no_template_ids_in_the_builder():
    for name in ("build_demo.py", "render_thumbs.py"):
        assert "cos-" not in (DEMO / name).read_text(), name


def test_thumbs_match_the_generated_manifest():
    manifest = {}
    for line in (DEMO / "thumbs" / "MANIFEST").read_text().splitlines():
        digest, name = line.split()
        manifest[name] = digest
    on_disk = {p.name for p in (DEMO / "thumbs").glob("*") if p.name != "MANIFEST"}
    assert on_disk == set(manifest), "thumbs/ and MANIFEST disagree"
    for name, digest in manifest.items():
        got = hashlib.sha256((DEMO / "thumbs" / name).read_bytes()).hexdigest()
        assert got == digest, f"{name} does not match MANIFEST"
    data = json.loads((DEMO / "demo.json").read_text())
    assert {a["thumb"] for a in data["ads"]} <= set(manifest)
    assert "images" in data["note"]
