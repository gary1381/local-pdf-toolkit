// pdf.js is bundled under /ui/vendor so the editor works offline and loads no third-party scripts.
import * as pdfjsLib from "/ui/vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/ui/vendor/pdfjs/pdf.worker.min.mjs";
window.pdfjsLib = pdfjsLib;
