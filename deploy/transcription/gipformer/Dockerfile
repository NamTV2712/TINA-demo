FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/gipformer

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY deploy/transcription/gipformer/requirements.txt ./requirements.txt
# The runtime is CPU-only; install official CPU wheels first so pip doesn't pull CUDA runtimes.
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
      torch==2.14.1+cpu torchaudio==2.11.0+cpu \
    && sed -e '/^torch==/d' -e '/^torchaudio==/d' requirements.txt > requirements-rest.txt \
    && pip install --no-cache-dir -r requirements-rest.txt

COPY deploy/transcription/gipformer/server.py \
     deploy/transcription/gipformer/engine.py \
     deploy/transcription/gipformer/telemetry.py \
     deploy/transcription/gipformer/model-assets.json ./

EXPOSE 8000
CMD ["python", "server.py"]
