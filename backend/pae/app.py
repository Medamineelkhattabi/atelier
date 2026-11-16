"""FastAPI application factory."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from pae.api import admin_routes, agent_routes, auth_routes, eval_routes, run_routes, workspace_routes
from pae.config import Config, load_config
from pae.platform import Platform

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}


def create_app(config: Config | None = None, platform: Platform | None = None) -> FastAPI:
    config = config or load_config()
    logging.basicConfig(level=config.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    plat = platform or Platform(config)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await plat.start()
        try:
            yield
        finally:
            await plat.stop()

    app = FastAPI(
        title="Atelier",
        version=plat.version,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.platform = plat

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.url.path.startswith("/api/") and request.url.path != "/api/health":
            client = request.client.host if request.client else "?"
            if not plat.api_limiter.hit(client):
                return JSONResponse({"detail": "rate limit exceeded"}, status_code=429)
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    for module in (auth_routes, run_routes, agent_routes, admin_routes, eval_routes, workspace_routes):
        app.include_router(module.router)

    dist = config.frontend_dist
    if (dist / "index.html").is_file():
        if (dist / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith("api/"):
                return JSONResponse({"detail": "not found"}, status_code=404)
            candidate = (dist / path).resolve()
            if path and candidate.is_file() and candidate.is_relative_to(dist.resolve()):
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")
    else:

        @app.get("/", include_in_schema=False)
        async def no_frontend():
            return JSONResponse({"detail": f"frontend not built ({Path(dist)}); API docs at /api/docs"})

    return app
