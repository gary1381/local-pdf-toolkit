import json
import httpx


def _file_form(file_name: str, content: bytes, password: str = "") -> tuple[dict, dict]:
    files = {"file": (file_name, content, "application/pdf")}
    data = {"password": password} if password else {}
    return files, data


async def extract_text(
    pdfbox_url: str, file_name: str, content: bytes, *, password: str = ""
) -> dict:
    files, data = _file_form(file_name, content, password)
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/extract-text", files=files, data=data)
        resp.raise_for_status()
        return resp.json()


async def pdf_info(pdfbox_url: str, file_name: str, content: bytes, *, password: str = "") -> dict:
    files, data = _file_form(file_name, content, password)
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/info", files=files, data=data)
        resp.raise_for_status()
        return resp.json()


async def annotate_pdf(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    page_index: int,
    text: str,
    x: float,
    y: float,
    password: str = "",
) -> bytes:
    files, data = _file_form(file_name, content, password)
    data.update(
        {
            "pageIndex": str(page_index),
            "text": text,
            "x": str(x),
            "y": str(y),
        }
    )
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/annotate", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def callout_pdf(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    page_index: int,
    text: str,
    anchor_x: float,
    anchor_y: float,
    x: float,
    y: float,
    width: float,
    height: float,
    font_size: float = 0,
    line_style: str = "arrow",
    password: str = "",
) -> bytes:
    files, data = _file_form(file_name, content, password)
    data.update(
        {
            "pageIndex": str(page_index),
            "text": text,
            "anchorX": str(anchor_x),
            "anchorY": str(anchor_y),
            "x": str(x),
            "y": str(y),
            "width": str(width),
            "height": str(height),
            "fontSize": str(font_size),
            "lineStyle": line_style,
        }
    )
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/callout", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def draw_text(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    page_index: int,
    text: str,
    x: float,
    y: float,
    width: float = 160,
    height: float = 18,
    font_size: float = 0,
    password: str = "",
) -> bytes:
    files, data = _file_form(file_name, content, password)
    data.update(
        {
            "pageIndex": str(page_index),
            "text": text,
            "x": str(x),
            "y": str(y),
            "width": str(width),
            "height": str(height),
            "fontSize": str(font_size),
        }
    )
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/draw-text", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def list_form_fields(
    pdfbox_url: str, file_name: str, content: bytes, *, password: str = ""
) -> dict:
    files, data = _file_form(file_name, content, password)
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/form-fields", files=files, data=data)
        resp.raise_for_status()
        return resp.json()


async def fill_form(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    values: dict[str, str],
    password: str = "",
) -> tuple[bytes, int]:
    import json

    files, data = _file_form(file_name, content, password)
    data["values"] = json.dumps(values)
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/fill-form", files=files, data=data)
        if resp.status_code >= 400:
            detail = resp.text.strip() or resp.reason_phrase
            raise RuntimeError(detail)
        filled_raw = resp.headers.get("x-filled-count", "0")
        try:
            filled_count = int(filled_raw)
        except ValueError:
            filled_count = 0
        return resp.content, filled_count


async def render_page(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    page_index: int,
    scale: float = 1.5,
    password: str = "",
) -> bytes:
    files, data = _file_form(file_name, content, password)
    data.update(
        {
            "pageIndex": str(page_index),
            "scale": str(scale),
        }
    )
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/render-page", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def flatten_pdfbox(
    pdfbox_url: str, file_name: str, content: bytes, *, password: str = ""
) -> bytes:
    files, data = _file_form(file_name, content, password)
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/flatten", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def highlight_pdf(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    page_index: int,
    x: float,
    y: float,
    width: float,
    height: float,
    password: str = "",
    points: str = "",
    stroke_width: float = 12,
    rects: str = "",
) -> bytes:
    files, data = _file_form(file_name, content, password)
    data.update(
        {
            "pageIndex": str(page_index),
            "x": str(x),
            "y": str(y),
            "width": str(width),
            "height": str(height),
        }
    )
    if points:
        data.update({"points": points, "strokeWidth": str(stroke_width)})
    if rects:
        data["rects"] = rects
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/highlight", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def remove_highlight_pdf(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    page_index: int,
    x: float,
    y: float,
    width: float,
    height: float,
    password: str = "",
) -> tuple[bytes, int]:
    files, data = _file_form(file_name, content, password)
    data.update(
        {
            "pageIndex": str(page_index),
            "x": str(x),
            "y": str(y),
            "width": str(width),
            "height": str(height),
        }
    )
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/remove-highlight", files=files, data=data)
        resp.raise_for_status()
        removed_raw = resp.headers.get("x-removed-count", "0")
        try:
            removed_count = int(removed_raw)
        except ValueError:
            removed_count = 0
        return resp.content, removed_count


async def replace_text(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    page_index: int,
    text: str,
    x: float,
    y: float,
    width: float,
    height: float,
    font_size: float = 12,
    cover_mode: str = "none",
    erase_x: float = 0,
    erase_y: float = 0,
    erase_width: float = 0,
    erase_height: float = 0,
    password: str = "",
) -> bytes:
    files, data = _file_form(file_name, content, password)
    data.update(
        {
            "pageIndex": str(page_index),
            "text": text,
            "x": str(x),
            "y": str(y),
            "width": str(width),
            "height": str(height),
            "fontSize": str(font_size),
            "coverMode": cover_mode,
            "eraseX": str(erase_x),
            "eraseY": str(erase_y),
            "eraseWidth": str(erase_width),
            "eraseHeight": str(erase_height),
        }
    )
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/replace-text", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def erase_region(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    page_index: int,
    x: float,
    y: float,
    width: float,
    height: float,
    password: str = "",
) -> bytes:
    files, data = _file_form(file_name, content, password)
    data.update(
        {
            "pageIndex": str(page_index),
            "x": str(x),
            "y": str(y),
            "width": str(width),
            "height": str(height),
        }
    )
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/erase-region", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def move_text(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    page_index: int,
    text: str,
    new_x: float,
    new_y: float,
    new_width: float,
    new_height: float,
    erase_x: float,
    erase_y: float,
    erase_width: float,
    erase_height: float,
    font_size: float = 12,
    password: str = "",
) -> bytes:
    files, data = _file_form(file_name, content, password)
    data.update(
        {
            "pageIndex": str(page_index),
            "text": text,
            "newX": str(new_x),
            "newY": str(new_y),
            "newWidth": str(new_width),
            "newHeight": str(new_height),
            "eraseX": str(erase_x),
            "eraseY": str(erase_y),
            "eraseWidth": str(erase_width),
            "eraseHeight": str(erase_height),
            "fontSize": str(font_size),
        }
    )
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/move-text", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def read_placements(
    pdfbox_url: str, file_name: str, content: bytes, *, password: str = ""
) -> dict:
    files, data = _file_form(file_name, content, password)
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/read-placements", files=files, data=data)
        resp.raise_for_status()
        return resp.json()


async def embed_placements(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    *,
    placements: str,
    password: str = "",
    flatten: bool = False,
) -> tuple[bytes, dict]:
    files, data = _file_form(file_name, content, password)
    data["placements"] = placements
    if flatten:
        data["flatten"] = "1"
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/embed-placements", files=files, data=data)
        resp.raise_for_status()
        try:
            report = json.loads(resp.headers.get("X-Edits-Report") or "{}")
        except ValueError:
            report = {}
        return resp.content, report


async def sign_image(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    image_name: str,
    image_content: bytes,
    *,
    page_index: int,
    x: float,
    y: float,
    width: float,
    height: float,
    password: str = "",
) -> bytes:
    image_mime = "image/png"
    lower = image_name.lower()
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        image_mime = "image/jpeg"
    elif lower.endswith(".webp"):
        image_mime = "image/webp"
    files = {
        "file": (file_name, content, "application/pdf"),
        "image": (image_name, image_content, image_mime),
    }
    data = {
        "pageIndex": str(page_index),
        "x": str(x),
        "y": str(y),
        "width": str(width),
        "height": str(height),
    }
    if password:
        data["password"] = password
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/sign-image", files=files, data=data)
        resp.raise_for_status()
        return resp.content


async def _post(pdfbox_url: str, path: str, files: dict, data: dict, timeout: float = 120.0) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}{path}", files=files, data=data)
        resp.raise_for_status()
        return resp


def _image_part(name: str, content: bytes) -> tuple[str, bytes, str]:
    mime = "image/jpeg" if content.startswith(b"\xff\xd8") else "image/png"
    return (name, content, mime)


async def stamp_images(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    images: list[bytes],
    *,
    placements: str,
    mode: str = "flatten",
    password: str = "",
) -> tuple[bytes, dict]:
    files, data = _file_form(file_name, content, password)
    for i, image in enumerate(images):
        files[f"image{i}"] = _image_part(f"signature{i}.png", image)
    data.update({"placements": placements, "mode": mode})
    resp = await _post(pdfbox_url, "/stamp-images", files, data)
    return resp.content, {"stamped_count": int(resp.headers.get("X-Stamped-Count", "0") or 0)}


async def digital_sign(
    pdfbox_url: str,
    file_name: str,
    content: bytes,
    cert: bytes,
    *,
    fields: dict,
    image: bytes | None = None,
    password: str = "",
) -> bytes:
    files, data = _file_form(file_name, content, password)
    files["cert"] = ("cert.p12", cert, "application/x-pkcs12")
    if image:
        files["image"] = _image_part("signature.png", image)
    data.update({k: str(v) for k, v in fields.items() if v is not None and v != ""})
    resp = await _post(pdfbox_url, "/digital-sign", files, data, timeout=60.0)
    return resp.content


async def verify_signatures(pdfbox_url: str, file_name: str, content: bytes, *, password: str = "") -> dict:
    files, data = _file_form(file_name, content, password)
    resp = await _post(pdfbox_url, "/verify-signatures", files, data)
    return resp.json()


async def cert_info(pdfbox_url: str, cert: bytes, cert_password: str) -> dict:
    files = {"cert": ("cert.p12", cert, "application/x-pkcs12")}
    resp = await _post(pdfbox_url, "/cert-info", files, {"certPassword": cert_password})
    return resp.json()


async def generate_cert(pdfbox_url: str, fields: dict) -> bytes:
    data = {k: str(v) for k, v in fields.items() if v is not None and v != ""}
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/generate-cert", data=data)
        resp.raise_for_status()
        return resp.content


# ---------------------------------------------------------------- agent tools


async def page_info(pdfbox_url: str, file_name: str, content: bytes, *, password: str = "") -> dict:
    files, data = _file_form(file_name, content, password)
    return (await _post(pdfbox_url, "/page-info", files, data)).json()


async def page_text(
    pdfbox_url: str, file_name: str, content: bytes, *, pages: str = "", sort_by_position: bool = False,
    password: str = "",
) -> dict:
    files, data = _file_form(file_name, content, password)
    data.update({"pages": pages, "sortByPosition": "1" if sort_by_position else "0"})
    return (await _post(pdfbox_url, "/page-text", files, data)).json()


async def find_text(
    pdfbox_url: str, file_name: str, content: bytes, *, terms: list[str], case_sensitive: bool = False,
    pages: str = "", password: str = "",
) -> dict:
    import json

    files, data = _file_form(file_name, content, password)
    data.update({"terms": json.dumps(terms), "caseSensitive": "1" if case_sensitive else "0", "pages": pages})
    return (await _post(pdfbox_url, "/find-text", files, data)).json()


def _redaction_result(body: bytes) -> tuple[bytes, dict]:
    """Parse "PDFREDACT1 <n>\\n" + n bytes of JSON report + the PDF."""
    import json

    head, _, rest = body.partition(b"\n")
    tag, _, size = head.decode("ascii", "replace").partition(" ")
    if tag != "PDFREDACT1" or not size.isdigit():
        raise RuntimeError("unexpected redaction response")
    n = int(size)
    return rest[n:], json.loads(rest[:n])


async def redact(
    pdfbox_url: str, file_name: str, content: bytes, *, terms: list[str], regions: list[dict],
    case_sensitive: bool = False, remove_metadata: bool = False, dpi: int = 200, password: str = "",
    keep_text: bool = True,
) -> tuple[bytes, dict]:
    import json

    files, data = _file_form(file_name, content, password)
    data.update({
        "terms": json.dumps(terms),
        "regions": json.dumps(regions),
        "caseSensitive": "1" if case_sensitive else "0",
        "removeMetadata": "1" if remove_metadata else "0",
        "dpi": str(dpi),
        "keepText": "1" if keep_text else "0",
    })
    return _redaction_result((await _post(pdfbox_url, "/redact", files, data, timeout=600.0)).content)


async def prepare_redaction(
    pdfbox_url: str, file_name: str, content: bytes, *, terms: list[str] | None = None,
    case_sensitive: bool = False, password: str = "",
) -> tuple[bytes, dict]:
    import json

    files, data = _file_form(file_name, content, password)
    data.update({"terms": json.dumps(terms or []), "caseSensitive": "1" if case_sensitive else "0"})
    return _redaction_result((await _post(pdfbox_url, "/prepare-redaction", files, data, timeout=300.0)).content)


async def verify_redaction(
    pdfbox_url: str, file_name: str, content: bytes, *, terms: list[str], case_sensitive: bool = False
) -> dict:
    import json

    files, data = _file_form(file_name, content)
    data.update({"terms": json.dumps(terms), "caseSensitive": "1" if case_sensitive else "0"})
    return (await _post(pdfbox_url, "/verify-redaction", files, data, timeout=300.0)).json()


async def text_layout(
    pdfbox_url: str, file_name: str, content: bytes, *, pages: str = "", password: str = ""
) -> dict:
    files, data = _file_form(file_name, content, password)
    data["pages"] = pages
    return (await _post(pdfbox_url, "/text-layout", files, data)).json()


# ---------------------------------------------------------------- pictures


async def extract_images(
    pdfbox_url: str, file_name: str, content: bytes, *, pages: str = "", min_size: int = 32,
    manifest_only: bool = False, password: str = "",
) -> bytes | dict:
    """The pictures on the pages: a ZIP (images/… plus manifest.json), or only the manifest."""
    files, data = _file_form(file_name, content, password)
    data.update({"pages": pages, "minSize": str(min_size), "manifestOnly": "true" if manifest_only else "false"})
    resp = await _post(pdfbox_url, "/extract-images", files, data, timeout=600.0)
    return resp.json() if manifest_only else resp.content


async def images_to_pdf(pdfbox_url: str, images: list[tuple[str, bytes]]) -> bytes:
    """One page per picture (every page of a TIFF), each the size of its picture."""
    files = [("file", (name, data, "application/octet-stream")) for name, data in images]
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{pdfbox_url.rstrip('/')}/images-to-pdf", files=files)
        resp.raise_for_status()
        return resp.content
