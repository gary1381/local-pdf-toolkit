"""Fetch the models the service uses into OPENPDF_STRUCTURE_MODELS (default
/models), so nothing is downloaded at run time:

    python -m app.models

Layout (Docling Heron) and table structure (TableFormer) only; no OCR, formula
or picture models.
"""
import os
import shutil
from pathlib import Path

from docling.utils.model_downloader import download_models

if __name__ == "__main__":
    target = Path(os.environ.get("OPENPDF_STRUCTURE_MODELS", "/models"))
    download_models(output_dir=target, with_layout=True, with_tableformer=True, with_code_formula=False,
                    with_picture_classifier=False, with_rapidocr=False, with_easyocr=False)
    # Not used: the ONNX copy of the layout model and the fast table model
    # (the service runs the PyTorch layout model and the accurate table model).
    for unused in ("docling-project--docling-layout-heron-onnx", "docling-project--docling-models/model_artifacts/tableformer/fast"):
        shutil.rmtree(target / unused, ignore_errors=True)
    for cache in target.glob("*/.cache"):
        shutil.rmtree(cache, ignore_errors=True)
    print("models in", target)
