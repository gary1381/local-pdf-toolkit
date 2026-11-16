"""OCRmyPDF plugin: RapidOCR (PaddleOCR models on ONNX Runtime) as the OCR engine.

OCRmyPDF still does everything around recognition: it skips pages that
already have text, renders pages, deskews, and writes the invisible text
layer. This plugin only replaces Tesseract with RapidOCR, which reads
Chinese far more reliably (see prototypes/ocr-bench).

Models (baked into the image, no downloads at run time):
- PP-OCRv6 tiny text detection, PP-OCRv6 small Chinese+English recognition
- PP-OCRv5 mobile English recognition: re-reads lines without Chinese,
  because the Chinese model sometimes drops the spaces between English
  words ("phoneor"). Its reading is used only when its characters match
  the Chinese model's exactly, so it can add spaces but never change text.

The service passes this plugin to ocrmypdf.ocr() by module name
("app.rapid_engine") with use_threads=True, so the module and its loaded
models stay in memory between requests.
"""
from __future__ import annotations

import math
import os
import re
import threading
import unicodedata
from pathlib import Path

import numpy as np
from PIL import Image

try:
    from app import ocr_models
except ImportError:  # loaded from its folder (bench / check scripts)
    import ocr_models
from ocrmypdf import hookimpl
from ocrmypdf.models.ocr_element import Baseline, BoundingBox, OcrClass, OcrElement
from ocrmypdf.pluginspec import OcrEngine, OrientationConfidence

LANGUAGES = {"eng", "chi_sim", "chi_tra"}
CJK = re.compile(r"[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]")
MIN_SCORE = 0.5  # lines RapidOCR is less sure of are left out of the text layer

_engines: dict[str, object] = {}
_engines_lock = threading.Lock()


def _threads() -> int:
    """Compute threads per page: the CPUs shared among the pages done in parallel."""
    jobs = int(os.environ.get("OPENPDF_OCR_JOBS", "4"))
    return int(os.environ.get("OPENPDF_OCR_THREADS", "0")) or max(1, (os.cpu_count() or 2) // jobs)


def _no_spinning() -> None:
    """Stop ONNX Runtime's worker threads from spin-waiting between operators.

    Spinning keeps idle threads busy; with several pages in parallel that
    burns CPU for nothing (measured: 15% more CPU per page). RapidOCR has no
    setting for it, so its session-options builder is wrapped once.
    """
    import rapidocr.inference_engine.onnxruntime.main as ort_main

    for cls in vars(ort_main).values():
        build = getattr(cls, "_init_sess_opts", None) if isinstance(cls, type) else None
        if build is None or getattr(build, "_openpdf_no_spin", False):
            continue

        def init_sess_opts(cfg, _build=build):
            opts = _build(cfg)
            opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
            return opts

        init_sess_opts._openpdf_no_spin = True
        cls._init_sess_opts = staticmethod(init_sess_opts)


def _engine(kind: str):
    """One RapidOCR engine per kind ('main', 'en', 'det'; see ocr_models.params),
    shared by the page threads. Safe because ONNX Runtime sessions are
    thread-safe and the engines are always called with the image only: per-call
    options would be stored on the shared object (RapidOCR's update_params).
    """
    if kind in _engines:
        return _engines[kind]
    with _engines_lock:
        if kind in _engines:
            return _engines[kind]
        import onnxruntime
        from rapidocr import RapidOCR

        # No usage telemetry from a local PDF tool.
        onnxruntime.disable_telemetry_events()
        _no_spinning()
        _engines[kind] = RapidOCR(params=ocr_models.params(kind, _threads()))
    return _engines[kind]


def warm_up() -> None:
    """Load every model now (RapidOCR loads them lazily, on first use)."""
    for kind in ("main", "en", "det"):
        _engine(kind)(ocr_models.blank_page())


def _crop(img: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """The line straightened out of the page (handles slightly tilted lines)."""
    import cv2

    w = int(round(max(np.linalg.norm(quad[0] - quad[1]), np.linalg.norm(quad[3] - quad[2]))))
    h = int(round(max(np.linalg.norm(quad[0] - quad[3]), np.linalg.norm(quad[1] - quad[2]))))
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    m = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    return cv2.warpPerspective(img, m, (max(w, 1), max(h, 1)), borderMode=cv2.BORDER_REPLICATE)


def _reread_latin(img: np.ndarray, quad: np.ndarray, text: str) -> str:
    """English model's reading of a line without Chinese, if it agrees on every character."""
    r = _engine("en")(_crop(img, quad))
    en = r.txts[0] if r.txts else ""
    return en if en.replace(" ", "") == text.replace(" ", "") else text


def recognize(img: np.ndarray) -> list[tuple[np.ndarray, str, float]]:
    """Lines on a page image: (quad tl/tr/br/bl in pixels, text, confidence)."""
    r = _engine("main")(img)
    if r.boxes is None or r.txts is None:
        return []
    lines = []
    for box, text, score in zip(r.boxes, r.txts, r.scores):
        # Drop control / unassigned code points the model sometimes emits
        # (e.g. U+FFFE); they don't belong in a PDF's text.
        text = "".join(c for c in text if not unicodedata.category(c).startswith("C"))
        text = " ".join(text.split())
        if score < MIN_SCORE or not text:
            continue
        quad = np.asarray(box, dtype=np.float64)
        if not CJK.search(text):
            text = _reread_latin(img, quad, text)
        lines.append((quad, text, float(score)))
    return lines


def _line_angle(quad: np.ndarray) -> float:
    """Tilt of a line in degrees, counter-clockwise positive (text rising to the right)."""
    dx, dy = quad[2] - quad[3]          # along the bottom edge, image y points down
    return math.degrees(math.atan2(-dy, dx))


def _weight(ch: str) -> float:
    """Rough relative width of a character, to place words along a line."""
    if ch == " ":
        return 0.3
    return 1.0 if CJK.match(ch) else 0.55


def _line_element(quad: np.ndarray, text: str, score: float) -> OcrElement:
    """One text line for OCRmyPDF's text-layer renderer.

    A level line gets its axis-aligned box. A tilted line gets the box it
    would have if straightened around its bottom-left corner, plus a baseline
    slope: the renderer then lays the text along the tilt at the right size
    (an axis-aligned box around a tilted line would make the text too tall).
    Words are spread along the line in proportion to their characters.
    """
    angle = _line_angle(quad)
    if abs(angle) < 0.3:
        left, top = quad.min(axis=0)
        right, bottom = quad.max(axis=0)
        baseline = None
    else:
        length = (np.linalg.norm(quad[1] - quad[0]) + np.linalg.norm(quad[2] - quad[3])) / 2
        height = (np.linalg.norm(quad[3] - quad[0]) + np.linalg.norm(quad[2] - quad[1])) / 2
        left, bottom = quad[3]
        right, top = left + length, bottom - height
        # The renderer rotates in page coordinates (y down), so a line rising
        # to the right needs a negative slope, despite the Baseline docstring.
        # Checked against the image with textlayer_check.py.
        baseline = Baseline(slope=-math.tan(math.radians(angle)), intercept=0.0)

    weights = [_weight(c) for c in text]
    total = sum(weights) or 1.0
    words = []
    for m in re.finditer(r"\S+", text):
        start = sum(weights[: m.start()])
        end = start + sum(weights[m.start(): m.end()])
        x0 = left + (right - left) * start / total
        x1 = left + (right - left) * end / total
        words.append(OcrElement(
            ocr_class=OcrClass.WORD, text=m.group(),
            bbox=BoundingBox(left=float(x0), top=float(top), right=float(max(x1, x0 + 1)), bottom=float(bottom)),
            confidence=score,
        ))

    return OcrElement(
        ocr_class=OcrClass.LINE,
        bbox=BoundingBox(left=float(left), top=float(top), right=float(right), bottom=float(bottom)),
        baseline=baseline,
        language="chi_sim" if CJK.search(text) else "eng",
        confidence=score,
        children=words,
    )


def _load(input_file: Path) -> tuple[np.ndarray, float]:
    with Image.open(input_file) as im:
        dpi = im.info.get("dpi", (300, 300))
        return np.ascontiguousarray(np.array(im.convert("RGB"))), float(dpi[0] if isinstance(dpi, tuple) else dpi)


class RapidOcrEngine(OcrEngine):
    @staticmethod
    def version() -> str:
        from importlib.metadata import version

        return version("rapidocr")

    @staticmethod
    def creator_tag(options) -> str:
        return f"OpenPDF OCR (RapidOCR {RapidOcrEngine.version()}, PP-OCRv6)"

    def __str__(self) -> str:
        return f"RapidOCR {self.version()}"

    @staticmethod
    def languages(options) -> set[str]:
        # One model reads Chinese (simplified and traditional) and English together.
        return LANGUAGES

    @staticmethod
    def get_orientation(input_file: Path, options) -> OrientationConfidence:
        return OrientationConfidence(angle=0, confidence=0.0)

    @staticmethod
    def get_deskew(input_file: Path, options) -> float:
        """Angle for Image.rotate() that levels the text: minus the median line tilt."""
        img, _ = _load(input_file)
        r = _engine("det")(img)
        if r.boxes is None:
            return 0.0
        angles = [_line_angle(np.asarray(b, dtype=np.float64)) for b in r.boxes
                  if np.linalg.norm(b[2] - b[3]) > 3 * np.linalg.norm(b[3] - b[0])]
        return -float(np.median(angles)) if angles else 0.0

    @staticmethod
    def supports_generate_ocr() -> bool:
        return True

    @staticmethod
    def generate_ocr(input_file: Path, options, page_number: int = 0) -> tuple[OcrElement, str]:
        img, dpi = _load(input_file)
        h, w = img.shape[:2]
        lines = recognize(img)
        page = OcrElement(
            ocr_class=OcrClass.PAGE,
            bbox=BoundingBox(left=0, top=0, right=w, bottom=h),
            dpi=dpi,
            page_number=page_number,
            children=[_line_element(q, t, s) for q, t, s in lines],
        )
        return page, "\n".join(t for _, t, _ in lines)

    @staticmethod
    def generate_hocr(input_file, output_hocr, output_text, options):
        raise NotImplementedError("RapidOcrEngine uses generate_ocr()")

    @staticmethod
    def generate_pdf(input_file, output_pdf, output_text, options):
        raise NotImplementedError("RapidOcrEngine needs --pdf-renderer fpdf2")


@hookimpl
def initialize(plugin_manager):
    """Take out the built-in Tesseract plugin's checks (Tesseract isn't installed).

    Blocking that plugin outright is not enough: OCRmyPDF's option model and
    validation still expect the Tesseract options it defines. So it is
    swapped for a stand-in that keeps only those option definitions and the
    image-size guard, and drops check_options / validate / get_ocr_engine.
    """
    import types

    from ocrmypdf.builtin_plugins import tesseract_ocr as tess

    if plugin_manager.is_registered(tess):
        plugin_manager.unregister(tess)
    if plugin_manager.get_plugin("openpdf_tesseract_options") is None:
        shim = types.ModuleType("openpdf_tesseract_options")
        for name in ("register_options", "add_options", "filter_ocr_image"):
            setattr(shim, name, getattr(tess, name))
        plugin_manager.register(shim, name="openpdf_tesseract_options")


@hookimpl
def get_ocr_engine(options):
    return RapidOcrEngine()
