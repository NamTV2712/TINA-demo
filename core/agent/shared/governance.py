"""Hard validation for LLM-written workspace entity files before turn commits."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Iterable, Optional

import contracts
from shared.adapters import _git, parse_entity
from shared.gitenv import scrubbed_git_env

# index.md / log.md are OKF v0.1 reserved files — listings/history WITHOUT frontmatter, not entities.
_ENTITY_RE = re.compile(r"^kg/entities/(?!(?:.*/)?(?:index|log)\.md$).+\.md$")


def changed_entity_files(work_dir: str | Path, base_sha: Optional[str] = None) -> list[str]:
    """Entity paths changed in the working tree or committed after the turn's starting HEAD.

    ``--untracked-files=all`` is REQUIRED: without it git collapses a fully-untracked directory to a
    single ``?? kg/`` line, hiding the individual new entity files the model just wrote.
    """
    work = Path(work_dir)
    paths: set[str] = set()
    if base_sha:
        committed = subprocess.run(
            ["git", "diff", "--name-only", "-z", "--no-renames", f"{base_sha}..HEAD",
             "--", "kg/entities"],
            cwd=work, env=scrubbed_git_env(), capture_output=True, check=True,
        ).stdout
        paths.update(
            p for p in (os.fsdecode(item) for item in committed.split(b"\0") if item)
            if _ENTITY_RE.match(p)
        )
    status = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=work, env=scrubbed_git_env(), capture_output=True, check=True,
    ).stdout.split(b"\0")
    index = 0
    while index < len(status):
        record = status[index]
        index += 1
        if not record:
            continue
        state, path = record[:2], record[3:]
        candidates = [os.fsdecode(path)]
        if b"R" in state or b"C" in state:  # -z emits the second rename/copy path as another record
            if index < len(status):
                candidates.append(os.fsdecode(status[index]))
                index += 1
        paths.update(candidate for candidate in candidates if _ENTITY_RE.match(candidate))
    return sorted(paths)


def revalidate_entities(work_dir: str | Path, paths: Optional[Iterable[str]] = None) -> list[tuple[str, str]]:
    """Validate each changed entity's frontmatter against workspace.v1. Returns (path, error) violations."""
    work = Path(work_dir)
    targets = list(paths) if paths is not None else changed_entity_files(work)
    violations: list[tuple[str, str]] = []
    for rel in targets:
        if not _ENTITY_RE.match(rel) or Path(rel).is_absolute() or ".." in Path(rel).parts:
            continue
        f = work / rel
        if f.is_symlink():
            violations.append((rel, "entity files cannot be symlinks"))
            continue
        if not f.exists():  # deleted — nothing to validate
            continue
        try:
            frontmatter, _body = parse_entity(f.read_text())
            contracts.validate_entity_frontmatter(frontmatter)
        except Exception as e:  # schema/YAML/IO failures must all block this write
            violations.append((rel, str(e).splitlines()[0]))
    return violations


def restore_entity_files(work_dir: str | Path, base_sha: Optional[str], paths: Iterable[str]) -> None:
    """Restore rejected entities to their turn-start contents, removing new files from index and disk."""
    import shutil

    work = Path(work_dir)
    for rel in sorted(set(paths)):
        path = Path(rel)
        if not _ENTITY_RE.match(rel) or path.is_absolute() or ".." in path.parts:
            continue
        target = work / path
        had_baseline = False
        if base_sha:
            try:
                _git(work, "cat-file", "-e", f"{base_sha}:{rel}")
            except RuntimeError:
                pass
            else:
                _git(work, "checkout", base_sha, "--", rel)
                had_baseline = True
        if had_baseline:
            continue
        try:
            _git(work, "rm", "-f", "--cached", "--ignore-unmatch", "--", rel)
        except RuntimeError:
            pass
        if target.is_symlink() or target.is_file():
            target.unlink(missing_ok=True)
        elif target.is_dir():
            shutil.rmtree(target)
