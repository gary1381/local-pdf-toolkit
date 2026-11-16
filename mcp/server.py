#!/usr/bin/env python3
"""stdio MCP server that proxies PDF Gateway REST tools."""

import json
import os
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

GATEWAY_URL = os.environ.get("PDF_GATEWAY_URL", "http://127.0.0.1:8090").rstrip("/")
API_KEY = os.environ.get("PDF_GATEWAY_API_KEY", "")


def _headers() -> dict[str, str]:
    if not API_KEY:
        return {}
    return {"X-API-Key": API_KEY}


mcp = FastMCP("pdf-gateway")


def _post_file(path: str, file_path: str, data: dict | None = None) -> bytes | dict:
    fields = data or {}
    with open(file_path, "rb") as handle:
        files = {"file": (Path(file_path).name, handle, "application/pdf")}
        with httpx.Client(timeout=600.0) as client:
            resp = client.post(
                f"{GATEWAY_URL}{path}",
                files=files,
                data=fields,
                headers=_headers(),
            )
            resp.raise_for_status()
            if resp.headers.get("content-type", "").startswith("application/json"):
                return resp.json()
            return resp.content


def _post_files(path: str, file_paths: list[str]) -> bytes:
    with httpx.Client(timeout=120.0) as client:
        files = []
        handles = []
        try:
            for idx, file_path in enumerate(file_paths):
                handle = open(file_path, "rb")
                handles.append(handle)
                files.append(("files", (Path(file_path).name, handle, "application/pdf")))
            resp = client.post(f"{GATEWAY_URL}{path}", files=files, headers=_headers())
            resp.raise_for_status()
            return resp.content
        finally:
            for handle in handles:
                handle.close()


@mcp.tool()
def pdf_merge(file_paths_json: str, output_path: str) -> str:
    """Merge PDFs. file_paths_json is a JSON array of absolute paths."""
    paths = json.loads(file_paths_json)
    if len(paths) < 2:
        raise ValueError("At least two PDF paths are required")
    content = _post_files("/v1/pdf/merge", paths)
    Path(output_path).write_bytes(content)
    return f"Merged {len(paths)} files to {output_path}"


@mcp.tool()
def pdf_split(file_path: str, pages: str, output_path: str, unify: bool = True) -> str:
    """Split/extract pages. pages example: '1-3' or '1,3'."""
    content = _post_file("/v1/pdf/split", file_path, {"pages": pages, "unify": str(unify).lower()})
    Path(output_path).write_bytes(content)
    return f"Split result written to {output_path}"


@mcp.tool()
def pdf_ocr(file_path: str, output_path: str, languages: str = "eng") -> str:
    """OCR a scanned PDF. languages example: 'eng' or 'eng+chi_sim'."""
    content = _post_file(
        "/v1/pdf/ocr",
        file_path,
        {"languages": languages.replace("+", ","), "deskew": "false", "clean": "false"},
    )
    Path(output_path).write_bytes(content)
    return f"OCR output written to {output_path}"


@mcp.tool()
def pdf_extract_text(file_path: str) -> str:
    """Extract text and page count from a PDF."""
    payload = _post_file("/v1/pdf/extract", file_path)
    return json.dumps(payload, ensure_ascii=False)


@mcp.tool()
def pdf_info(file_path: str) -> str:
    """Read PDF metadata and page count."""
    payload = _post_file("/v1/pdf/info", file_path)
    return json.dumps(payload, ensure_ascii=False)


@mcp.tool()
def pdf_annotate(
    file_path: str,
    output_path: str,
    text: str,
    page_index: int = 0,
    x: float = 72,
    y: float = 720,
) -> str:
    """Add a sticky-note style annotation to a PDF page."""
    content = _post_file(
        "/v1/pdf/annotate",
        file_path,
        {
            "page_index": str(page_index),
            "text": text,
            "x": str(x),
            "y": str(y),
        },
    )
    Path(output_path).write_bytes(content)
    return f"Annotated PDF written to {output_path}"


if __name__ == "__main__":
    mcp.run()
