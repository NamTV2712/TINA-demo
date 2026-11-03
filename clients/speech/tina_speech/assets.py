"""Explicit download only; detection verifies and uses the local pinned assets."""
import hashlib
import json
import os
from pathlib import Path
import tarfile
import tempfile
import urllib.request


def manifest():
    return json.loads(Path(__file__).with_name("model-assets.json").read_text())


def default_directory():
    root = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache")) if os.name == "nt" else (
        Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")))
    return root / "tina" / "speech" / manifest()["model"]


def keyword_line(directory):
    import sentencepiece as spm
    processor = spm.SentencePieceProcessor(model_file=str(directory / "bpe.model"))
    pieces = processor.encode("HEY TINA", out_type=str)
    tokens = {line.rsplit(maxsplit=1)[0] for line in (directory / "tokens.txt").read_text(encoding="utf-8").splitlines()}
    if not pieces or any(piece not in tokens for piece in pieces):
        raise ValueError("Wake phrase cannot be encoded by the pinned model")
    return " ".join(pieces) + " @HEY_TINA\n"


def verify(directory):
    for name, expected in manifest()["files"].items():
        path = directory / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("Missing or modified model asset: " + name + "; run tina-speech setup")
    keywords = directory / "keywords.txt"
    if not keywords.is_file() or keywords.read_text(encoding="utf-8") != keyword_line(directory):
        raise ValueError("Modified wake phrase; run tina-speech setup")


def install(directory):
    data = manifest()
    directory.mkdir(parents=True, exist_ok=True)
    # Stream to disk with an exact size bound; never extract arbitrary archive paths.
    with tempfile.TemporaryFile() as archive:
        digest = hashlib.sha256()
        total = 0
        with urllib.request.urlopen(data["url"], timeout=60) as response:
            while block := response.read(65536):
                total += len(block)
                if total > data["archive_bytes"]:
                    raise ValueError("Model archive exceeds pinned size")
                digest.update(block)
                archive.write(block)
        if total != data["archive_bytes"] or digest.hexdigest() != data["archive_sha256"]:
            raise ValueError("Model archive checksum mismatch")
        archive.seek(0)
        with tarfile.open(fileobj=archive, mode="r:bz2") as source:
            for name, expected in data["files"].items():
                member = source.getmember(data["model"] + "/" + name)
                if not member.isfile() or member.size > data["archive_bytes"]:
                    raise ValueError("Invalid model archive entry")
                contents = source.extractfile(member).read()
                if hashlib.sha256(contents).hexdigest() != expected:
                    raise ValueError("Model file checksum mismatch: " + name)
                # Replace files atomically; do not follow an existing destination symlink.
                with tempfile.NamedTemporaryFile(dir=directory, delete=False) as out:
                    temporary = Path(out.name)
                    out.write(contents)
                try:
                    temporary.replace(directory / name)
                finally:
                    temporary.unlink(missing_ok=True)
    (directory / "keywords.txt").write_text(keyword_line(directory), encoding="utf-8")
    verify(directory)
