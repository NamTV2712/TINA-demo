FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.9.22
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OTEL_SDK_DISABLED=true XDG_CACHE_HOME=/tmp/tina-cache PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-install-project --no-default-groups
COPY adapters.py server.py smoke.py ./
USER 65532:65532
CMD ["python", "server.py"]
