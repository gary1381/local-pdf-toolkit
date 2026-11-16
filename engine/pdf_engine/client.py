"""Calls into the local gateway (the REST API all PDF work goes through)."""
from __future__ import annotations

import asyncio
import json
import os
import time

import httpx


class EngineError(RuntimeError):
    """A failure to show to the agent as it is."""


GATEWAY = os.environ.get("PDF_ENGINE_GATEWAY", "http://127.0.0.1:8090").rstrip("/")
API_KEY = os.environ.get("PDF_ENGINE_API_KEY", "")
READY_TIMEOUT = float(os.environ.get("PDF_ENGINE_READY_TIMEOUT", "90"))

_ready = False


def _headers() -> dict[str, str]:
    return {"X-API-Key": API_KEY} if API_KEY else {}


async def wait_ready() -> None:
    """The services start with the engine; the first call may have to wait a few seconds."""
    global _ready
    if _ready:
        return
    deadline = time.monotonic() + READY_TIMEOUT
    async with httpx.AsyncClient(timeout=3.0) as client:
        while True:
            try:
                r = await client.get(f"{GATEWAY}/v1/pdf/engine/ready", headers=_headers())
                if r.status_code == 200 and r.json().get("ready"):
                    _ready = True
                    return
            except (httpx.HTTPError, ValueError):
                pass
            if time.monotonic() > deadline:
                raise EngineError("The PDF services did not start; see the engine's log")
            await asyncio.sleep(0.5)


def _detail(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        if isinstance(data, dict) and data.get("detail"):
            return str(data["detail"])
    except ValueError:
        pass
    return resp.text[:500] or f"HTTP {resp.status_code}"


async def post(path: str, *, files: dict | list | None = None, data: dict | None = None,
               timeout: float = 600.0) -> httpx.Response:
    await wait_ready()
    form = {k: (json.dumps(v) if isinstance(v, (list, dict)) else str(v).lower() if isinstance(v, bool) else str(v))
            for k, v in (data or {}).items() if v is not None}
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(f"{GATEWAY}/v1/pdf{path}", files=files, data=form, headers=_headers())
        except httpx.TimeoutException as exc:
            raise EngineError("The operation timed out; the file may be very large") from exc
        except httpx.HTTPError as exc:
            raise EngineError(f"The PDF services are not reachable: {exc}") from exc
    if resp.status_code >= 400:
        raise EngineError(_detail(resp))
    return resp


async def get(path: str) -> httpx.Response:
    await wait_ready()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{GATEWAY}/v1/pdf{path}", headers=_headers())
    if resp.status_code >= 400:
        raise EngineError(_detail(resp))
    return resp


def pdf_part(name: str, content: bytes) -> tuple[str, bytes, str]:
    return (name, content, "application/pdf")
