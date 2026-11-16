"""Which RapidOCR models the OCR service uses, and how to fetch them.

Kept free of OCRmyPDF imports: the Docker build runs `python -m
app.ocr_models` right after pip install to download the models into the
same image layer (and delete the bundled ones the service doesn't use).
"""
from __future__ import annotations

import os

# Bundled with the rapidocr wheel but not used (we detect with "tiny" and
# don't classify line direction).
UNUSED_BUNDLED = ["PP-OCRv6_det_small.onnx", "ch_ppocr_mobile_v2.0_cls_mobile.onnx"]


def params(kind: str, threads: int = 1) -> dict:
    """RapidOCR parameters for one engine kind:

    'main' - detection + Chinese/English recognition (whole page)
    'en'   - English recognition only, on one cropped line
    'det'  - detection only (for deskew)

    What each kind does is fixed here, at construction. Never pass use_det /
    use_rec / box_thresh ... when calling an engine: RapidOCR stores those
    on the engine object, so they would leak into later calls from other
    threads and requests.
    """
    from rapidocr import LangRec, ModelType, OCRVersion

    p = {
        "Global.log_level": "error",
        "EngineConfig.onnxruntime.intra_op_num_threads": threads,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        # Tiny detection: a third of the CPU of "small" (1.1 vs 3.2 CPU-s per
        # A4 page) for nearly the same accuracy (prototypes/ocr-bench).
        "Det.model_type": ModelType.TINY,
        # No per-line 180° classifier: it now and then flips a slightly
        # tilted, upright line and the reading turns to garbage ("Ooptos u os
        # ns po xt." for "Optical character recognition turns scans into
        # text."). Page orientation is OCRmyPDF's job anyway.
        "Global.use_cls": False,
    }
    if kind == "en":
        p.update({
            "Global.use_det": False,
            "Global.use_cls": False,
            "Rec.ocr_version": OCRVersion.PPOCRV5,
            "Rec.lang_type": LangRec.EN,
            "Rec.model_type": ModelType.MOBILE,
        })
    elif kind == "det":
        p.update({"Global.use_rec": False})
    return p


def blank_page():
    """A small image with one dark bar, enough for every model to run once."""
    import numpy as np

    page = np.full((200, 400, 3), 255, np.uint8)
    page[90:110, 40:360] = 0
    return page


def fetch() -> None:
    """Download every model the service uses (RapidOCR loads lazily, on first use)."""
    import rapidocr
    from rapidocr import RapidOCR

    for kind in ("main", "en", "det"):
        RapidOCR(params=params(kind))(blank_page())
    models = os.path.join(os.path.dirname(rapidocr.__file__), "models")
    for name in UNUSED_BUNDLED:
        path = os.path.join(models, name)
        if os.path.exists(path):
            os.remove(path)
    for name in sorted(os.listdir(models)):
        print(f"{os.path.getsize(os.path.join(models, name)) / 1e6:6.1f} MB  {name}")


if __name__ == "__main__":
    fetch()
