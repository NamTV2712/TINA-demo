"""Gipformer 1.5 + FSMN worker using the shared bounded ASR HTTP boundary."""
import logging
import os
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gipformer.engine import GipformerEngine, MODEL
from http_worker import create_app, infer

PREFIX, DEVICE, DECODER, NAME = 'TINA_GIPFORMER', 'cpu', 'sherpa-onnx', 'Gipformer 1.5'
PORT = int(os.getenv(PREFIX + '_PORT', '18002'))
HOST = os.getenv(PREFIX + '_HOST', '127.0.0.1')
app = create_app(model_id=MODEL, name=NAME, prefix=PREFIX,
                 default_directory=Path(__file__).resolve().parent.parent / 'models/gipformer-fsmn',
                 load_engine=GipformerEngine.load, device=DEVICE, decoder=DECODER, languages=('vi',))

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host=HOST, port=PORT, access_log=False)
