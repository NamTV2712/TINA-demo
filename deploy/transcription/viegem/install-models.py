#!/usr/bin/env python3
"""Download pinned VieGem code/weights and base assets; never import downloaded code."""
import argparse
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('asset_installer', HERE.parent / 'gipformer/install-models.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=HERE.parent / 'models/viegem-fsmn')
    args = parser.parse_args()
    manifest = json.loads((HERE / 'model-assets.json').read_text())
    for group, data in manifest.items():
        for name, digest in data['files'].items():
            installer.install(args.directory / group / name, digest,
                              f"https://huggingface.co/{data['repo']}/resolve/{data['revision']}/{name}")
            print(f'Verified {group}/{name}', flush=True)
    for name, digest in installer.MANIFEST['vad_files'].items():
        installer.install(args.directory / 'fsmn-vad' / name, digest,
                          f"https://modelscope.cn/models/{installer.MANIFEST['vad_repo']}/resolve/master/{name}",
                          HERE.parent / 'models/gipformer-fsmn/fsmn-vad' / name)
    print(f'Assets ready: {args.directory}', flush=True)


if __name__ == '__main__':
    main()
