"""End-to-end test: a real MCP client talks to the engine over stdio.

    python engine/tests/test_mcp.py [--server "docker run -i --rm ... IMAGE mcp"]

By default it starts `python -m pdf_engine.server` against a gateway at
$PDF_ENGINE_GATEWAY (the dev stack: engine/tools/devstack.sh). With --server
it runs that command instead (the container), sharing WORK at the same path.
Every tool is called on the fixtures; the script exits non-zero on failure.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent
WORK = Path(os.environ.get("PDF_ENGINE_TEST_DIR", "/tmp/pdf-engine-test"))

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}", flush=True)


def raw_contains(path: str, needles: list[str]) -> list[str]:
    """Every object in the file, decompressed: which needles appear anywhere."""
    from pypdf import PdfReader
    from pypdf.generic import IndirectObject, StreamObject

    reader = PdfReader(path)
    blobs = []
    for num in range(1, int(reader.trailer["/Size"])):
        try:
            obj = reader.get_object(IndirectObject(num, 0, reader))
        except Exception:  # noqa: BLE001
            continue
        if obj is None:
            continue
        if isinstance(obj, StreamObject):
            try:
                blobs.append(obj.get_data().decode("latin-1"))
            except Exception:  # noqa: BLE001
                pass
        blobs.append(str(obj))
    hay = "".join(blobs).lower().replace(" ", "")
    return [n for n in needles if n.lower().replace(" ", "") in hay]


def text_of(res) -> str:
    return "\n".join(c.text for c in res.content if getattr(c, "type", "") == "text")


async def call(session: ClientSession, tool: str, **args):
    t0 = time.monotonic()
    res = await session.call_tool(tool, args)
    return res, time.monotonic() - t0


async def check_structure(session: ClientSession) -> None:
    """The document structure add-on: required with PDF_ENGINE_TEST_STRUCTURE=1, else
    the tools must say it is missing and what to use instead."""
    r = str(WORK / "report.pdf")
    res, dt = await call(session, "pdf_outline", path=r)
    if res.isError and "not installed" in text_of(res):
        record("structure add-on missing: says so", os.environ.get("PDF_ENGINE_TEST_STRUCTURE") != "1"
               and "pdf_read_text" in text_of(res), text_of(res)[:90])
        return
    outline = json.loads(text_of(res)) if not res.isError else {}
    titles = [(o["level"], o["title"], o["page"]) for o in outline.get("outline", [])]
    record("pdf_outline", titles[:4] == [(0, "Annual Report 2025", 1), (1, "1 Summary", 1),
                                         (2, "1.1 Revenue by region", 1), (1, "2 Operations", 2)]
           and outline.get("tables") == 1, f"{dt:.1f}s {titles}")

    res, _ = await call(session, "pdf_read_markdown", path=r)
    md = text_of(res)
    # columns one after the other, not interleaved line by line
    left_end, right_start = md.find("LEFT-COLUMN-END"), md.find("RIGHT-COLUMN-START")
    # the list stays a list: pages drawn without the PDF's (not embedded) fonts lose it
    record("pdf_read_markdown", "<!-- page 2 of 2 -->" in md and "## 1 Summary" in md and "- Lower fuel costs" in md
           and "| North" in md and "Northwind Ltd" not in md and 0 < left_end < right_start, md[:120])

    res, _ = await call(session, "pdf_structure", path=r, pages="1", types=["table"])
    tables = json.loads(text_of(res)).get("elements", []) if not res.isError else []
    t = tables[0] if tables else {}
    box = t.get("box", {})
    record("pdf_structure table", t.get("rows", [[]])[0][:1] == ["Region"] and len(t.get("rows", [])) == 4
           and t.get("section") == ["Annual Report 2025", "1 Summary", "1.1 Revenue by region"]
           and 60 < box.get("x", 0) < 300 and 0 < box.get("y", 0) < 792, json.dumps(t)[:200])
    # boxes are in the same units as pdf_find_text
    res, _ = await call(session, "pdf_find_text", path=r, terms=["Revenue (million)"])
    m = json.loads(text_of(res)).get("matches", [{}])[0].get("boxes", [{}])[0]
    record("structure boxes match find_text", box and box["x"] - 2 <= m.get("x", -99) <= box["x"] + box["width"]
           and box["y"] - 2 <= m.get("y", -99) <= box["y"] + box["height"], f"table {box} text {m}")

    res, _ = await call(session, "pdf_read_markdown", path=str(WORK / "scan.pdf"))
    # OCR'd for the reading when the OCR add-on is installed, else it says how to get the text
    record("pdf_read_markdown on a scan", "Riverside Dental" in text_of(res) and "OCR'd" in text_of(res)
           or "pdf_ocr" in text_of(res) or "not installed" in text_of(res), text_of(res)[:160])
    res, _ = await call(session, "pdf_export", path=r)
    exp = json.loads(text_of(res)) if not res.isError else {}
    md = Path(exp["file"]).read_text() if exp.get("file") else ""
    record("pdf_export markdown", "## 1 Summary" in md and "<!-- page 2 of 2 -->" in md, text_of(res)[:160])
    res, _ = await call(session, "pdf_read_markdown", path=str(WORK / "contract.pdf"), pages="2")
    record("pdf_read_markdown rotated page", "Schedule A" in text_of(res), text_of(res)[:120])


async def run(server_cmd: list[str], env: dict) -> None:
    params = StdioServerParameters(command=server_cmd[0], args=server_cmd[1:], env=env, cwd=str(ENGINE))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            record("initialize", bool(init.serverInfo.name), f"{init.serverInfo.name} {init.serverInfo.version}")
            tools = {t.name: t for t in (await session.list_tools()).tools}
            record("list_tools", len(tools) >= 24, f"{len(tools)} tools")
            ro = [n for n, t in tools.items() if t.annotations and t.annotations.readOnlyHint]
            record("read-only annotations", len(ro) >= 6, ", ".join(sorted(ro)))

            c = str(WORK / "contract.pdf")
            f = str(WORK / "form.pdf")
            s = str(WORK / "scan.pdf")

            res, dt = await call(session, "pdf_info", path=c)
            info = json.loads(text_of(res))
            record("pdf_info", not res.isError and info["pageCount"] == 2, f"{dt:.1f}s (first call waits for services)")

            res, _ = await call(session, "pdf_read_text", path=c, pages="1")
            record("pdf_read_text", "Services Agreement" in text_of(res) and "Page 1 of 2" in text_of(res))

            await check_structure(session)

            res, _ = await call(session, "pdf_find_text", path=c, terms=["John Smith", "123-45-6789"])
            found = json.loads(text_of(res))
            record("pdf_find_text", found["matchCount"] == 4, f"{found['matchCount']} matches")

            schema = {"type": "object", "properties": {
                "client": {"type": "string"}, "ssn": {"type": "string"}, "monthly_fee": {"type": "number"},
                "account": {"type": "string"}, "witness": {"type": "string"}}, "required": ["client"]}
            res, _ = await call(session, "pdf_extract", path=c, json_schema=schema, values={
                "client": "John Smith", "ssn": "123-45-6789", "monthly_fee": 4500, "account": "000123456789",
                "witness": "Nobody Here"})
            ext = json.loads(text_of(res)) if not res.isError else {}
            src = {s["path"]: s for s in ext.get("sources", [])}
            fee = src.get("monthly_fee", {})
            record("pdf_extract", ext.get("valid") is True and src.get("client", {}).get("page") == 1
                   and fee.get("match") == "reformatted" and "4,500" in fee.get("line", "")
                   and src.get("ssn", {}).get("box", {}).get("y", 0) > 100 and ext.get("notFound") == ["witness"],
                   text_of(res)[:300])
            res, _ = await call(session, "pdf_extract", path=c, json_schema=schema, values={"monthly_fee": "a lot"})
            ext = json.loads(text_of(res)) if not res.isError else {}
            record("pdf_extract checks the schema", ext.get("valid") is False and len(ext.get("schemaErrors", [])) == 2,
                   json.dumps(ext.get("schemaErrors"))[:200])
            res, _ = await call(session, "pdf_extract", path=c, json_schema=schema)
            record("pdf_extract without values says what to do", res.isError and "values" in text_of(res),
                   text_of(res)[:120])

            res, _ = await call(session, "pdf_render_page", path=c, page=1, dpi=72)
            kinds = [x.type for x in res.content]
            record("pdf_render_page", "image" in kinds and "612 x 792 px" in text_of(res), text_of(res)[:90])

            res, dt = await call(session, "pdf_redact", path=c, terms=["John Smith", "123-45-6789"],
                                 regions=[{"page": 1, "x": 72, "y": 140, "width": 320, "height": 16}])
            rep = json.loads(text_of(res)) if not res.isError else {}
            out = rep.get("output", "")
            ok = rep.get("verified") is True and Path(out).exists()
            leak = subprocess.run(["pdftotext", out, "-"], capture_output=True, text=True).stdout if ok else ""
            record("pdf_redact", ok and "John Smith" not in leak and "123-45" not in leak,
                   f"{dt:.1f}s, pages {[p['page'] for p in rep.get('redactedPages', [])]}, textRestored={rep.get('textRestored')}")
            if ok:
                raw = raw_contains(out, ["John Smith", "123-45-6789", "Witness: J o h n"])
                record("redacted file has no trace in any object", not raw, f"found {raw}" if raw else "")
                record("letter-spaced name found", rep.get("termMatches", {}).get("John Smith", 0) >= 3,
                       json.dumps(rep.get("termMatches")))

            res, _ = await call(session, "pdf_redact", path=c, terms=["Nobody Here"])
            record("redact refuses when nothing matches", res.isError and "None of the terms" in text_of(res))

            res, dt = await call(session, "pdf_redact", path=s, terms=["Riverside Dental", "88-2231"])
            rep = json.loads(text_of(res)) if not res.isError else {}
            record("pdf_redact on a scan", rep.get("verified") is True and rep.get("scannedPagesSearched") is True
                   and sum(rep.get("termMatches", {}).values()) == 2, f"{dt:.1f}s {text_of(res)[:120]}")

            res, _ = await call(session, "pdf_form_fields", path=f)
            fields = json.loads(text_of(res))
            record("pdf_form_fields", fields["fieldCount"] == 9, f"{fields['fieldCount']} fields")

            res, _ = await call(session, "pdf_fill_form", path=f, values={"nope": "x"})
            record("pdf_fill_form rejects unknown field", res.isError and "Unknown field" in text_of(res))

            res, _ = await call(session, "pdf_fill_form", path=f, values={
                "legal_name": "Riverside Dental LLC", "address": "12 Harbor St", "city_state_zip": "Portland, ME 04101",
                "tin": "12-3456789", "email": "billing@riverside.example", "tax_class": "LLC", "certify": True,
                "date": "2026-10-13",
            })
            filled = json.loads(text_of(res)) if not res.isError else {"problems": [text_of(res)]}
            record("pdf_fill_form", not res.isError and not filled.get("problems"), json.dumps(filled)[:160])

            res, dt = await call(session, "pdf_ocr", path=s)
            ocr = json.loads(text_of(res)) if not res.isError else {}
            record("pdf_ocr", ocr.get("pagesStillWithoutText") == 0, f"{dt:.1f}s {text_of(res)[:120]}")
            if ocr.get("output"):
                res, _ = await call(session, "pdf_find_text", path=ocr["output"], terms=["Riverside Dental"])
                record("search after OCR", json.loads(text_of(res)).get("matchCount", 0) >= 1)

            res, dt = await call(session, "pdf_extract_images", path=s)
            pics = json.loads(text_of(res)) if not res.isError else {}
            first = (pics.get("images") or [{}])[0]
            pic = Path(pics.get("folder", "/nonexistent")) / (first.get("file") or "x")
            record("pdf_extract_images", pics.get("pictures", 0) >= 1 and pic.exists() and first.get("page") == 1
                   and (Path(pics["folder"]) / "manifest.json").exists()
                   and ("Riverside" in first.get("text", "") or "not installed" in pics.get("note", "")),
                   f"{dt:.1f}s {text_of(res)[:160]}")
            if pic.exists():
                res, dt = await call(session, "pdf_from_images", images=[str(pic)], output=str(WORK / "from-picture.pdf"))
                made = json.loads(text_of(res)) if not res.isError else {}
                record("pdf_from_images", made.get("pages") == 1 and Path(made.get("output", "/x")).exists(),
                       f"{dt:.1f}s {text_of(res)[:160]}")
                if made.get("textRecognised"):
                    res, _ = await call(session, "pdf_find_text", path=made["output"], terms=["Riverside Dental"])
                    record("search a PDF made from a picture", json.loads(text_of(res)).get("matchCount", 0) >= 1)
            res, _ = await call(session, "pdf_from_images", images=[c])
            record("pdf_from_images refuses a PDF", res.isError and "Expected a" in text_of(res), text_of(res)[:90])

            cert = str(WORK / "signer.p12")
            res, _ = await call(session, "pdf_create_certificate", name="Ana Example", password="test-1234", output=cert)
            record("pdf_create_certificate", not res.isError and Path(cert).exists(), text_of(res)[:100])
            res, _ = await call(session, "pdf_sign", path=c, certificate=cert, certificate_password="test-1234",
                                reason="Approved", location="Portland")
            signed = json.loads(text_of(res)) if not res.isError else {}
            sigs = signed.get("verification", {}).get("signatures", [])
            record("pdf_sign", bool(sigs) and sigs[0].get("page") == 2, f"on page {sigs[0].get('page') if sigs else '?'}")
            if signed.get("output"):
                res, _ = await call(session, "pdf_verify_signatures", path=signed["output"])
                record("pdf_verify_signatures", "signatures" in text_of(res), text_of(res)[:160])
            # a signed form with the name in a field: the field value must not survive redaction
            res, _ = await call(session, "pdf_fill_form", path=f, values={"legal_name": "John Smith"},
                                output=str(WORK / "form-john.pdf"))
            res, _ = await call(session, "pdf_sign", path=str(WORK / "form-john.pdf"), certificate=cert,
                                certificate_password="test-1234")
            sf = json.loads(text_of(res)).get("output") if not res.isError else None
            if sf:
                res, _ = await call(session, "pdf_redact", path=sf, terms=["John Smith"])
                rep = json.loads(text_of(res)) if not res.isError else {}
                raw = raw_contains(rep["output"], ["John Smith"]) if rep.get("output") else ["(failed)"]
                record("redact signed form field", rep.get("verified") is True and not raw,
                       f"{text_of(res)[:150]} raw={raw}")
            # a signed scan: OCR refuses signed files, so the signature must go first
            res, _ = await call(session, "pdf_sign", path=s, certificate=cert, certificate_password="test-1234",
                                visible=False)
            ss = json.loads(text_of(res)).get("output") if not res.isError else None
            if ss:
                res, _ = await call(session, "pdf_redact", path=ss, terms=["Riverside Dental"])
                rep = json.loads(text_of(res)) if not res.isError else {}
                record("redact signed scan", rep.get("verified") is True and rep.get("scannedPagesSearched") is True,
                       text_of(res)[:150])
            res, _ = await call(session, "pdf_redact", path=c, terms=["000123456789", "First Example Bank"])
            rep = json.loads(text_of(res)) if not res.isError else {}
            record("redact a long number", rep.get("verified") is True, text_of(res)[:150])
            # shared resources: page 1's form must not survive through page 2; "Ja ne Doe" counts
            res, _ = await call(session, "pdf_redact", path=str(WORK / "shared.pdf"), terms=["Jane Doe"],
                                restore_text=False)
            rep = json.loads(text_of(res)) if not res.isError else {}
            # page 1 stays text: the rest of its form ("account 7731") stays, only the name goes
            raw = raw_contains(rep["output"], ["Jane Doe", "Ja ne"]) if rep.get("output") else ["(failed)"]
            kept = raw_contains(rep["output"], ["Public notice", "account 7731"]) if rep.get("output") else []
            record("redact with shared page resources", rep.get("verified") is True and not raw and len(kept) == 2
                   and rep.get("termMatches", {}).get("Jane Doe") == 3
                   and [p["page"] for p in rep.get("redactedPages", [])] == [1],
                   f"raw={raw} kept={kept} {json.dumps(rep.get('termMatches'))} {text_of(res)[:120]}")
            # a short term must not be refused because it occurs inside ids or XML markup
            res, _ = await call(session, "pdf_redact", path=c, terms=["USD"], restore_text=False)
            rep = json.loads(text_of(res)) if not res.isError else {}
            record("redact a short term", rep.get("verified") is True, text_of(res)[:150])
            res, _ = await call(session, "pdf_sign", path=c, certificate=cert, certificate_password="test-1234",
                                timestamp_url="http://169.254.169.254/latest")
            record("refuses unknown timestamp server", res.isError and "not a known public timestamp" in text_of(res))
            res, _ = await call(session, "pdf_sign", path=c, certificate=cert, certificate_password="wrong")
            record("pdf_sign wrong password", res.isError and "password" in text_of(res).lower(), text_of(res)[:80])

            merged = str(WORK / "merged.pdf")
            res, _ = await call(session, "pdf_merge", paths=[c, f], output=merged)
            record("pdf_merge", '"pages": 3' in text_of(res), text_of(res)[:100])
            res, _ = await call(session, "pdf_merge", paths=[c, f], output=merged)
            record("refuses to overwrite", res.isError and "already exists" in text_of(res))
            res, _ = await call(session, "pdf_rotate_pages", path=c, output=c, overwrite=True)
            record("never replaces the original", res.isError and "input" in text_of(res), text_of(res)[:90])
            link = WORK / "trap.pdf"
            link.symlink_to(WORK / "form.pdf")
            res, _ = await call(session, "pdf_rotate_pages", path=c, output=str(link), overwrite=True)
            record("refuses a symlink as output", res.isError and "symbolic link" in text_of(res), text_of(res)[:90])
            res, _ = await call(session, "pdf_extract_pages", path=merged, pages="3")
            record("pdf_extract_pages", not res.isError, text_of(res)[:100])
            res, _ = await call(session, "pdf_select_pages", path=merged, order="3,1")
            record("pdf_select_pages", '"pages": 2' in text_of(res))
            res, _ = await call(session, "pdf_rotate_pages", path=c, angle=90, pages="1")
            record("pdf_rotate_pages", not res.isError)
            res, _ = await call(session, "pdf_add_text", path=f, page=1, x=250, y=40, text="RECEIVED 2026-10-13", font_size=12)
            record("pdf_add_text", not res.isError)
            res, _ = await call(session, "pdf_add_note", path=c, page=1, x=500, y=90, text="Check the amount")
            record("pdf_add_note", not res.isError)
            res, _ = await call(session, "pdf_highlight", path=c, terms=["30 days"])
            record("pdf_highlight", '"highlights": 1' in text_of(res), text_of(res)[:120])
            res, _ = await call(session, "pdf_flatten", path=f)
            record("pdf_flatten", not res.isError)
            res, _ = await call(session, "pdf_encrypt", path=c, password="s3cret")
            enc = json.loads(text_of(res)).get("output") if not res.isError else None
            record("pdf_encrypt", bool(enc))
            if enc:
                res, _ = await call(session, "pdf_info", path=enc)
                record("encrypted needs password", res.isError, text_of(res)[:80])
                res, _ = await call(session, "pdf_decrypt", path=enc, password="s3cret")
                record("pdf_decrypt", not res.isError)

            res, _ = await call(session, "pdf_info", path="/etc/hostname")
            record("refuses files outside its folders", res.isError, text_of(res)[:90])
            res, _ = await call(session, "pdf_info", path="relative.pdf")
            record("needs absolute paths", res.isError)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", help="command that starts the MCP server on stdio")
    args = ap.parse_args()
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    subprocess.run([sys.executable, str(HERE / "make_fixtures.py"), str(WORK)], check=True, capture_output=True)
    env = dict(os.environ)
    if args.server:
        cmd = shlex.split(args.server)
    else:
        cmd = [sys.executable, "-m", "pdf_engine.server"]
        env.setdefault("PDF_ENGINE_GATEWAY", "http://127.0.0.1:28090")
        env["PDF_ENGINE_ROOTS"] = str(WORK)
    t0 = time.monotonic()
    asyncio.run(run(cmd, env))
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed in {time.monotonic() - t0:.0f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
