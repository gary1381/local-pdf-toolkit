import httpx


async def is_available(structure_url: str) -> bool:
    """The document structure component is optional: True when its service answers
    (a busy one can take seconds to; a missing one refuses at once)."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{structure_url.rstrip('/')}/health")
            return resp.status_code == 200
    except httpx.HTTPError:
        return False


async def model_ready(structure_url: str) -> bool:
    """Whether the structure component has a reading model set up and answering."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{structure_url.rstrip('/')}/model")
            return resp.status_code == 200 and bool(resp.json().get("ready"))
    except (httpx.HTTPError, ValueError):
        return False


async def convert(
    structure_url: str, file_name: str, content: bytes, *, pages: str = "", picture_text: bool = True,
    model: bool = False, scan_pages: list[int] | None = None,
) -> dict:
    """Headings, paragraphs, lists, tables and figures in reading order, plus Markdown."""
    files = {"file": (file_name, content, "application/pdf")}
    async with httpx.AsyncClient(timeout=900.0) as client:
        resp = await client.post(f"{structure_url.rstrip('/')}/convert", files=files, data={"pages": pages, "pictureText": "true" if picture_text else "false",
                                       "model": "true" if model else "false",
                                       "scanPages": ",".join(map(str, scan_pages or []))})
        resp.raise_for_status()
        return resp.json()
