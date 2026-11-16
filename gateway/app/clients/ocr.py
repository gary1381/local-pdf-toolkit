import httpx


async def is_available(ocr_url: str) -> bool:
    """The OCR component is optional: True when its service answers
    (a busy one can take seconds to; a missing one refuses at once)."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{ocr_url.rstrip('/')}/health")
            return resp.status_code == 200
    except httpx.HTTPError:
        return False


async def _can(ocr_url: str, feature: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{ocr_url.rstrip('/')}/health")
            return resp.status_code == 200 and bool(resp.json().get(feature))
    except (httpx.HTTPError, ValueError):
        return False


async def reads_pictures(ocr_url: str) -> bool:
    """Whether the installed OCR component can read the pictures on pages with text
    (builds before 0.5 cannot; they would quietly skip those pages)."""
    return await _can(ocr_url, "pictures")


async def reads_again(ocr_url: str) -> bool:
    """Whether the installed OCR component can read pages again from their image,
    replacing their text (mode=force; builds before 0.6 cannot)."""
    return await _can(ocr_url, "force")


async def ocr_pdf(
    ocr_url: str,
    file_name: str,
    content: bytes,
    *,
    languages: list[str],
    deskew: bool = False,
    clean: bool = False,
    pictures: bool = False,
    force: bool = False,
    pages: list[int] | None = None,
) -> bytes:
    """pictures=False: pages without a text layer (scans), others left as they are.
    pictures=True: the pictures on pages that have text (the page's own text is
    hidden while reading, so only what is not text yet is added). force=True: the
    pages become their image plus the text read from it (for text that cannot be
    decoded)."""
    files = {"file": (file_name, content, "application/pdf")}
    data = {
        "languages": ",".join(languages),
        "deskew": "true" if deskew else "false",
        "clean": "true" if clean else "false",
        "mode": "force" if force else "images" if pictures else "scans",
    }
    if pages:
        data["pages"] = ",".join(str(p) for p in pages)
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{ocr_url.rstrip('/')}/ocr", files=files, data=data)
        resp.raise_for_status()
        return resp.content
