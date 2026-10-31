# Apple Silicon transcription backend

This endpoint runs **MLX Whisper on the Mac host**, using Apple's Metal GPU. It is a separate,
native macOS process; Docker Desktop's Linux transcription containers cannot use the Mac's MPS/Metal
device. Inference uses the upstream [`mlx-whisper`](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
implementation and the converted [`mlx-community/whisper-large-v3-turbo`](https://huggingface.co/mlx-community/whisper-large-v3-turbo) checkpoint.

## Start

Requirements: Apple Silicon Mac, Python 3.11+, `uv`, and FFmpeg (`brew install ffmpeg`). From the
TINA repository root:

```bash
cd core/meetings/services/transcription_mlx
uv sync
API_TOKEN='<a-long-random-token>' uv run uvicorn tina_transcription_mlx.main:app \
  --host 0.0.0.0 --port 8084
```

The first start downloads `mlx-community/whisper-large-v3-turbo` and warms the model; later starts
use the local Hugging Face cache. Set `TINA_MLX_MODEL` before launch to choose another MLX Whisper
checkpoint.

## Connect TINA

In **Settings → Models → Global transcription backend**, set the **Apple GPU (MLX/Metal) URL** to
`http://host.docker.internal:8084` and enter the same token in **Apple GPU token**. If the TINA
meeting stack runs on another host, use the Mac's reachable LAN/VPN address instead and restrict
inbound access to TINA. Then the Apple GPU option appears for users in **Your transcription backend**.

The NVIDIA GPU option uses the existing `deploy/transcription/docker-compose.yml` CUDA worker; set its
URL and token in the corresponding global fields. Each user can choose the backend for their own
meeting bots. If a backend is not configured, its option stays disabled.
