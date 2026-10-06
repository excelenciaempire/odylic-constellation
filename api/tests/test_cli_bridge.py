import os
import stat

from api import cli_bridge


def test_env_wins_over_files(tmp_path):
    cwd, home = tmp_path / "cwd", tmp_path / "home"
    cwd.mkdir()
    home.mkdir()
    (cwd / ".env").write_text("ACCESS_TOKEN=from_cwd\nAD_ACCOUNT_ID=111\n")
    (home / ".env").write_text("ACCESS_TOKEN=from_home\nAD_ACCOUNT_ID=act_222\n")
    got = cli_bridge.discover_credentials({"ACCESS_TOKEN": "from_env"}, cwd, home)
    assert got == {"token": "from_env", "account_id": "act_111", "token_source": "environment"}


def test_cwd_env_then_home_env(tmp_path):
    cwd, home = tmp_path / "cwd", tmp_path / "home"
    cwd.mkdir()
    home.mkdir()
    (home / ".env").write_text('ACCESS_TOKEN="from_home"\nAD_ACCOUNT_ID=act_222\n')
    got = cli_bridge.discover_credentials({}, cwd, home)
    assert got["token"] == "from_home" and got["account_id"] == "act_222" and got["token_source"] == "~/.env"
    (cwd / ".env").write_text("ACCESS_TOKEN=from_cwd\n")
    got = cli_bridge.discover_credentials({}, cwd, home)
    assert got["token"] == "from_cwd" and got["account_id"] == "act_222" and got["token_source"] == "./.env"


def test_no_credentials(tmp_path):
    got = cli_bridge.discover_credentials({"ACCESS_TOKEN": "  "}, tmp_path, tmp_path)
    assert got == {"token": None, "account_id": None, "token_source": None}


def test_bad_account_id_ignored(tmp_path):
    got = cli_bridge.discover_credentials({"ACCESS_TOKEN": "t", "AD_ACCOUNT_ID": "abc"}, tmp_path, tmp_path)
    assert got["token"] == "t" and got["account_id"] is None


def test_find_binary_in_common_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_bridge.shutil, "which", lambda name: None)
    assert cli_bridge.find_binary(home=tmp_path) is None or not str(cli_bridge.find_binary(home=tmp_path)).startswith(str(tmp_path))
    b = tmp_path / ".local" / "bin" / "meta"
    b.parent.mkdir(parents=True)
    b.write_text("#!/bin/sh\nexit 0\n")
    os.chmod(b, os.stat(b).st_mode | stat.S_IXUSR)
    assert cli_bridge.find_binary(home=tmp_path) == str(b)
