# Personal AI engineering platform: one image, frontend built in a Node stage
# and served by the Python API.

FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PAE_DATA_DIR=/data \
    PAE_HOST=0.0.0.0 \
    PAE_PORT=8600 \
    PAE_WORKSPACE_ROOTS=/data/workspaces:/workspaces
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 pae \
    && mkdir -p /data /workspaces \
    && chown pae:pae /data /workspaces
WORKDIR /app
COPY backend/pyproject.toml backend/requirements.lock backend/
COPY backend/pae backend/pae
RUN pip install --no-cache-dir -c backend/requirements.lock -e ./backend
COPY agents agents
COPY evals evals
COPY templates templates
COPY --from=frontend /src/frontend/dist frontend/dist
USER pae
VOLUME ["/data"]
EXPOSE 8600
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8600/api/health', timeout=4)"
CMD ["pae", "serve"]
