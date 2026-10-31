#!/usr/bin/env python3
"""Install hash-verified ONNX/FSMN assets outside Git; never execute downloaded code."""
import argparse
import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / 'model-assets.json').read_text())
DEFAULT = HERE.parent / 'models' / 'gipformer-fsmn'


def verified(path, digest):
    return path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest


def install(path, digest, url, cached=None):
    if path.exists():
        if not verified(path, digest):
            raise ValueError(f'Existing asset checksum mismatch: {path.name}')
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.part')
    try:
        if cached and verified(cached, digest):
            shutil.copyfile(cached, temporary)
        else:
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
        if not verified(temporary, digest):
            raise ValueError(f'Downloaded asset checksum mismatch: {path.name}')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=DEFAULT)
    parser.add_argument('--vad-source', type=Path, default=Path.home() / '.cache/modelscope/models/iic--speech_fsmn_vad_zh-cn-16k-common-pytorch/snapshots/master')
    args = parser.parse_args()
    for name, digest in MANIFEST['files'].items():
        install(args.directory / name, digest, f"https://huggingface.co/{MANIFEST['repo']}/resolve/{MANIFEST['revision']}/{name}")
        print(f'Verified Gipformer {name}', flush=True)
    for name, digest in MANIFEST['vad_files'].items():
        install(args.directory / 'fsmn-vad' / name, digest, f"https://modelscope.cn/models/{MANIFEST['vad_repo']}/resolve/master/{name}", args.vad_source / name)
        print(f'Verified FSMN {name}', flush=True)
    print(f'Assets ready: {args.directory}')


if __name__ == '__main__':
    main()
