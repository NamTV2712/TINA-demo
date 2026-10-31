#!/usr/bin/env python3
"""Install a symlink to this checkout, without overwriting another executable."""
from pathlib import Path
import sys


def install(directory=None):
    source = Path(__file__).resolve().with_name("tina.py")
    destination = (directory or Path.home() / ".local/bin") / "tina"
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink() and destination.resolve() == source:
        return destination
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Keeping existing executable: {destination}")
    destination.symlink_to(source)
    return destination


if __name__ == "__main__":
    try:
        print(install())
    except OSError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
