"""Download pinned model data into a private HF cache; never execute hub code."""
import argparse
import hashlib
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(os.environ.get("HF_HOME", "/models")))
    args = parser.parse_args()
    from huggingface_hub import snapshot_download

    manifest = json.loads(Path(__file__).with_name("model-assets.json").read_text())
    for repo in manifest["repos"]:
        snapshot = Path(snapshot_download(repo["repo"], revision=repo["revision"],
            allow_patterns=[f["path"] for f in repo["files"]], cache_dir=str(args.directory / "hub")))
        for entry in repo["files"]:
            data = (snapshot / entry["path"]).read_bytes()
            if "sha256" in entry:
                actual, expected = hashlib.sha256(data).hexdigest(), entry["sha256"]
            else:
                actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                expected = entry["git_blob"]
            if actual != expected:
                raise RuntimeError("Downloaded asset checksum mismatch: " + entry["path"])
        ref = args.directory / "hub" / ("models--" + repo["repo"].replace("/", "--")) / "refs/main"
        ref.parent.mkdir(parents=True, exist_ok=True)
        ref.write_text(repo["revision"])
        print("Verified " + repo["repo"] + "@" + repo["revision"], flush=True)
    # Hub tree metadata is created mode 0600 by some SDK versions. The serving
    # non-root UID may differ from the installer UID; this cache contains public
    # models only, never tokens, and must remain readable from the read-only mount.
    for path in args.directory.rglob("*.json"):
        if path.is_file():
            path.chmod(0o644)


if __name__ == "__main__":
    main()
