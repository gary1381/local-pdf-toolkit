import httpx


async def decrypt_pdf(qpdf_url: str, file_name: str, content: bytes, *, password: str = "") -> bytes:
    files = {"file": (file_name, content, "application/pdf")}
    data = {"password": password}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{qpdf_url.rstrip('/')}/decrypt", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def flatten_pdf(
    qpdf_url: str,
    file_name: str,
    content: bytes,
    *,
    password: str = "",
    mode: str = "all",
) -> bytes:
    files = {"file": (file_name, content, "application/pdf")}
    data = {"password": password, "mode": mode}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{qpdf_url.rstrip('/')}/flatten", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def rotate_pdf(
    qpdf_url: str,
    file_name: str,
    content: bytes,
    *,
    angle: int = 90,
    pages: str = "",
    password: str = "",
) -> bytes:
    files = {"file": (file_name, content, "application/pdf")}
    data = {"angle": str(angle), "pages": pages, "password": password}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{qpdf_url.rstrip('/')}/rotate", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def encrypt_pdf(
    qpdf_url: str,
    file_name: str,
    content: bytes,
    *,
    user_password: str,
    owner_password: str = "",
    key_length: int = 256,
) -> bytes:
    files = {"file": (file_name, content, "application/pdf")}
    data = {
        "user_password": user_password,
        "owner_password": owner_password,
        "key_length": str(key_length),
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{qpdf_url.rstrip('/')}/encrypt", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def select_pages(
    qpdf_url: str,
    file_name: str,
    content: bytes,
    *,
    order: str,
    password: str = "",
) -> bytes:
    """Keep only the listed 1-based pages, in the listed order."""
    files = {"file": (file_name, content, "application/pdf")}
    data = {"order": order, "password": password}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{qpdf_url.rstrip('/')}/pages", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def merge_pdfs(qpdf_url: str, files: list[tuple[str, bytes]]) -> bytes:
    data = [("files", (name, content, "application/pdf")) for name, content in files]
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(f"{qpdf_url.rstrip('/')}/merge", files=data)
        resp.raise_for_status()
        return resp.content


async def split_pdf(
    qpdf_url: str,
    file_name: str,
    content: bytes,
    *,
    pages: str,
    unify: bool = True,
    password: str = "",
) -> bytes:
    files = {"file": (file_name, content, "application/pdf")}
    data = {"pages": pages, "unify": "true" if unify else "false", "password": password}
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(f"{qpdf_url.rstrip('/')}/split", files=files, data=data)
        resp.raise_for_status()
        return resp.content
