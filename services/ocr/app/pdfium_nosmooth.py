"""OCRmyPDF plugin: rasterize pages without pdfium's image smoothing.

pdfium smooths (resamples) embedded images by default. On scans that slight
blur is enough to tip Tesseract into reading mixed Chinese/English lines as
Latin gibberish. Ghostscript, which OCRmyPDF used before we dropped it, does
not smooth, so this restores the old, more stable input to Tesseract.

Loaded with ``ocrmypdf --plugin``; OCRmyPDF imports plugins in every worker
process, so the patch applies wherever pages are rendered.
"""
import functools

import pypdfium2

_render = pypdfium2.PdfPage.render

if not getattr(_render, "_openpdf_nosmooth", False):

    @functools.wraps(_render)
    def render(self, *args, **kwargs):
        kwargs.setdefault("no_smoothimage", True)
        return _render(self, *args, **kwargs)

    render._openpdf_nosmooth = True
    pypdfium2.PdfPage.render = render
