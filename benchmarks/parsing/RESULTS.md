# olmOCR-Bench results

s/page: median wall time per page on a shared machine (load varies between runs, so only runs
made together compare). All on the CPU only, except openpdf-markdown-model: its model ran on the
GPU (RTX 3060), the rest of its work on the CPU.

| System | ArXiv math | Old scans: math | Tables | Old scans | Headers / footers | Multi-column | Long tiny text | Base | Overall | s/page |
|---|---|---|---|---|---|---|---|---|---|---|
| openpdf-markdown-model | 64.6 | 32.3 | 76.0 | 32.3 | 88.6 | 69.2 | 78.7 | 97.9 | **67.5** ± 1.1 | 6.08 |
| indra-ocr-math | 55.9 | 3.5 | 64.3 | 27.6 | 89.6 | 71.9 | 76.0 | 99.6 | **61.1** ± 1.0 | 1.9 |
| indra-ocr | 0.3 | 2.8 | 67.4 | 27.4 | 89.6 | 75.6 | 76.0 | 99.6 | **54.8** ± 0.9 | 0.4 |
| docling-default | 0.0 | 0.0 | 71.1 | 25.1 | 89.9 | 73.8 | 70.8 | 98.9 | **53.7** ± 0.9 | 19.04 |
| openpdf-markdown-auto | 0.0 | 0.0 | 70.9 | 24.3 | 88.7 | 69.6 | 76.2 | 98.1 | **53.5** ± 0.9 | 7.76 |
| openpdf-markdown-ocr | 0.0 | 0.0 | 68.4 | 24.3 | 91.7 | 70.5 | 70.4 | 98.9 | **53.0** ± 1.0 | 8.0 |
| openpdf-markdown | 0.0 | 0.0 | 64.2 | 13.3 | 92.2 | 70.2 | 52.3 | 93.7 | **48.2** ± 0.9 | 6.57 |
| pymupdf4llm | 0.0 | 0.0 | 61.4 | 13.3 | 38.9 | 66.7 | 33.7 | 87.2 | **37.7** ± 0.9 | 2.35 |
| openpdf-text-ocr | 0.0 | 0.0 | 0.2 | 18.8 | 39.5 | 58.1 | 67.2 | 97.9 | **35.2** ± 0.9 | 0.33 |
| openpdf-text | 0.0 | 0.0 | 0.1 | 13.3 | 41.7 | 58.1 | 47.1 | 87.3 | **31.0** ± 1.0 | 0.3 |
| pdfcraft-rs-markdown | 0.6 | 0.0 | 27.1 | 13.3 | 37.6 | 42.4 | 10.9 | 87.0 | **27.4** ± 0.9 | 0.02 |
| pdfcraft-markdown | 0.0 | 0.0 | 32.6 | 13.3 | 52.0 | 5.8 | 3.2 | 87.3 | **24.3** ± 0.8 | 0.12 |
| openpdf-text-ordered | 0.0 | 0.0 | 0.1 | 13.3 | 33.2 | 13.2 | 17.0 | 87.3 | **20.5** ± 0.8 | 0.28 |
