from __future__ import annotations

import json
from pathlib import Path

import pytest

from cartograph.cli import main
from cartograph.onboarding import canonical_alias, onboard_project
from cartograph.store import GraphStore


def _whisper(root: Path) -> Path:
    whisper = root / "Whisper"
    context = whisper / "context"
    context.mkdir(parents=True)
    (context / "sources.example.json").write_text(
        json.dumps({"sources": [], "excluded_roots": [], "excluded_aliases": []}),
        encoding="utf-8",
    )
    return whisper


def _subject(root: Path) -> Path:
    subject = root / "My Project"
    subject.mkdir()
    (subject / "app.py").write_text("VALUE = 1\n", encoding="utf-8")
    return subject


def _policy(whisper: Path) -> dict:
    return json.loads((whisper / "context" / "sources.local.json").read_text(encoding="utf-8"))


def test_onboarding_transitions_between_privacy_modes(tmp_path: Path) -> None:
    whisper = _whisper(tmp_path)
    subject = _subject(tmp_path)
    original_files = sorted(path.relative_to(subject) for path in subject.rglob("*"))
    with GraphStore(tmp_path / "cartograph.sqlite3") as store:
        shared = onboard_project(store, subject, privacy="shared", whisper_root=whisper)
        assert shared["project"] == "my-project"
        assert shared["whisper_policy"] == "enrolled"
        assert [row["alias"] for row in _policy(whisper)["sources"]] == ["my-project"]

        private = onboard_project(store, subject, privacy="private", whisper_root=whisper)
        assert private["whisper_policy"] == "denied"
        policy = _policy(whisper)
        assert policy["sources"] == []
        assert policy["excluded_aliases"] == ["my-project"]
        assert str(subject.resolve()) in policy["excluded_roots"]

        mapped = onboard_project(store, subject, privacy="map-only", whisper_root=whisper)
        assert mapped["whisper_policy"] == "not-enrolled"
        assert _policy(whisper) == {"sources": [], "excluded_roots": [], "excluded_aliases": []}
        assert store.project_privacy("my-project") == "map-only"
    assert sorted(path.relative_to(subject) for path in subject.rglob("*")) == original_files
    assert str(subject.resolve()) not in json.dumps(mapped)


def test_alias_is_stable_and_invalid_names_fail() -> None:
    assert canonical_alias(" My Project_v2 ") == "my-project-v2"
    with pytest.raises(ValueError):
        canonical_alias("---")


def test_whisper_itself_remains_a_brain_source(tmp_path: Path) -> None:
    whisper = _whisper(tmp_path)
    (whisper / "brain.py").write_text("VALUE = 1\n", encoding="utf-8")
    with GraphStore(tmp_path / "brain.sqlite3") as store:
        onboard_project(store, whisper, name="whisper", privacy="shared", whisper_root=whisper)
    [source] = _policy(whisper)["sources"]
    assert source["alias"] == "whisper"
    assert source["kind"] == "brain"


def test_onboard_cli_is_one_step_and_sanitized(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    whisper = _whisper(tmp_path)
    subject = _subject(tmp_path)
    database = tmp_path / "cli.sqlite3"
    assert main([
        "--db", str(database), "onboard", str(subject), "--shared", "--whisper-root", str(whisper)
    ]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["project"] == "my-project"
    assert payload["privacy"] == "shared"
    assert payload["next"] == "$start in Codex or /start in Claude Code"
    assert str(subject.resolve()) not in json.dumps(payload)
