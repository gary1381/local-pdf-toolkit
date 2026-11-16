package com.pdfgateway;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.http.Context;
import io.javalin.http.UploadedFile;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.color.PDDeviceGray;
import org.apache.pdfbox.pdmodel.graphics.color.PDDeviceRGB;
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImage;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.util.Matrix;

import java.awt.geom.Point2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.metadata.IIOMetadata;
import javax.imageio.stream.ImageInputStream;
import org.w3c.dom.Node;

/**
 * Pictures out of a PDF, and pictures into one.
 *
 * /extract-images: every picture drawn on the chosen pages, as a ZIP of image
 * files plus manifest.json (page, position on the displayed page in points from
 * the top-left, pixel size). JPEG and JPEG 2000 pictures keep their original
 * bytes; the others are written as PNG with their transparency applied. A
 * picture drawn several times is written once.
 *
 * /images-to-pdf: JPEG, PNG, TIFF (every page), GIF and BMP files, one page per
 * picture, the page the size of the picture at its resolution. JPEG is embedded
 * as it is (no recompression); a photo's EXIF orientation becomes the page's
 * rotation.
 */
final class ImageTools {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int MAX_IMAGES = 5000;
    private static final int MAX_INPUT_IMAGES = 500;
    // Larger pictures are refused rather than decoded (memory).
    private static final long MAX_PIXELS = 150_000_000L;
    // Without a resolution in the file, fit the longer side to A4's (11.69 in).
    private static final float A4_LONG_INCHES = 11.69f;

    private ImageTools() {}

    private static void userError(Context ctx, String message) {
        ctx.status(400).json(Map.of("detail", "USER:" + message));
    }

    private static int parseInt(String raw, int fallback) {
        try {
            return raw == null || raw.isBlank() ? fallback : Integer.parseInt(raw.trim());
        } catch (NumberFormatException exc) {
            return fallback;
        }
    }

    private static float round(double v) {
        return Math.round(v * 100.0) / 100.0f;
    }

    // ------------------------------------------------------------------ extract

    /** One picture as written to the ZIP (shared by every place it is drawn). */
    private static final class Written {
        final String file;
        final String format;

        Written(String file, String format) {
            this.file = file;
            this.format = format;
        }
    }

    private static final class Finder extends PDFGraphicsStreamEngine {
        final List<Object[]> found = new ArrayList<>();   // {PDImage, float[4] user-space bbox}

        Finder(PDPage page) {
            super(page);
        }

        @Override
        public void drawImage(PDImage image) {
            Matrix ctm = getGraphicsState().getCurrentTransformationMatrix();
            float minX = Float.MAX_VALUE;
            float minY = Float.MAX_VALUE;
            float maxX = -Float.MAX_VALUE;
            float maxY = -Float.MAX_VALUE;
            for (float[] c : new float[][] {{0, 0}, {1, 0}, {0, 1}, {1, 1}}) {
                Point2D.Float p = ctm.transformPoint(c[0], c[1]);
                minX = Math.min(minX, p.x);
                maxX = Math.max(maxX, p.x);
                minY = Math.min(minY, p.y);
                maxY = Math.max(maxY, p.y);
            }
            if (found.size() < MAX_IMAGES) {
                found.add(new Object[] {image, new float[] {minX, minY, maxX, maxY}});
            }
        }

        @Override public void appendRectangle(Point2D p0, Point2D p1, Point2D p2, Point2D p3) {}
        @Override public void clip(int windingRule) {}
        @Override public void moveTo(float x, float y) {}
        @Override public void lineTo(float x, float y) {}
        @Override public void curveTo(float x1, float y1, float x2, float y2, float x3, float y3) {}
        @Override public Point2D getCurrentPoint() { return new Point2D.Float(); }
        @Override public void closePath() {}
        @Override public void endPath() {}
        @Override public void strokePath() {}
        @Override public void fillPath(int windingRule) {}
        @Override public void fillAndStrokePath(int windingRule) {}
        @Override public void shadingFill(COSName shadingName) {}
    }

    /** The picture's original bytes when they are a file a viewer opens (JPEG, JPEG 2000), else null. */
    private static byte[] originalBytes(PDImage image, String[] ext) throws IOException {
        if (!(image instanceof PDImageXObject) || image.getDecode() != null) {
            return null;
        }
        PDImageXObject x = (PDImageXObject) image;
        if (x.getSoftMask() != null || x.getMask() != null) {
            return null;
        }
        List<COSName> filters = x.getStream().getFilters();
        if (filters.isEmpty()) {
            return null;
        }
        COSName last = filters.get(filters.size() - 1);
        boolean plainColor = image.getColorSpace() instanceof PDDeviceRGB || image.getColorSpace() instanceof PDDeviceGray;
        String stop;
        if (COSName.DCT_DECODE.equals(last) && plainColor) {
            stop = COSName.DCT_DECODE.getName();
            ext[0] = "jpg";
        } else if (COSName.JPX_DECODE.equals(last)) {
            stop = COSName.JPX_DECODE.getName();
            ext[0] = "jp2";
        } else {
            return null;
        }
        try (InputStream in = x.getStream().createInputStream(List.of(stop))) {
            return in.readAllBytes();
        }
    }

    private static byte[] png(BufferedImage image) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    static void extractImages(Context ctx) throws IOException {
        UploadedFile upload = ctx.uploadedFile("file");
        if (upload == null) {
            ctx.status(400).result("Missing file field");
            return;
        }
        byte[] bytes = upload.content().readAllBytes();
        String password = ctx.formParam("password");
        int minSize = Math.max(0, parseInt(ctx.formParam("minSize"), 32));
        boolean manifestOnly = "true".equalsIgnoreCase(ctx.formParam("manifestOnly"));

        try (PDDocument doc = password != null && !password.isBlank() ? Loader.loadPDF(bytes, password) : Loader.loadPDF(bytes)) {
            List<Integer> pages;
            try {
                pages = AgentTools.parsePages(ctx.formParam("pages"), doc.getNumberOfPages());
            } catch (NumberFormatException exc) {
                userError(ctx, "Pages must look like 1-3,5");
                return;
            }
            Map<COSStream, Written> written = new IdentityHashMap<>();
            List<Map<String, Object>> manifest = new ArrayList<>();
            List<Map<String, Object>> sizes = new ArrayList<>();
            List<String> unreadable = new ArrayList<>();
            ByteArrayOutputStream zipBytes = new ByteArrayOutputStream();
            int count = 0;
            try (ZipOutputStream zip = new ZipOutputStream(zipBytes)) {
                for (int pageIndex : pages) {
                    PDPage page = doc.getPage(pageIndex);
                    Finder finder = new Finder(page);
                    finder.processPage(page);
                    PdfboxServer.PageSpace space = new PdfboxServer.PageSpace(page);
                    sizes.add(Map.of("page", pageIndex + 1, "width", round(space.vw), "height", round(space.vh)));
                    int onPage = 0;
                    for (Object[] hit : finder.found) {
                        PDImage image = (PDImage) hit[0];
                        float[] b = (float[]) hit[1];
                        int pw = image.getWidth();
                        int ph = image.getHeight();
                        if (pw < minSize || ph < minSize || count >= MAX_IMAGES) {
                            continue;
                        }
                        onPage++;
                        count++;
                        float[] box = space.visualRect(new PDRectangle(b[0], b[1], b[2] - b[0], b[3] - b[1]));
                        Map<String, Object> entry = new LinkedHashMap<>();
                        entry.put("page", pageIndex + 1);
                        entry.put("index", onPage);
                        entry.put("x", round(box[0]));
                        entry.put("y", round(box[1]));
                        entry.put("width", round(box[2]));
                        entry.put("height", round(box[3]));
                        entry.put("pixelWidth", pw);
                        entry.put("pixelHeight", ph);
                        if (box[2] > 0) {
                            entry.put("dpi", Math.round(pw / (box[2] / 72f)));
                        }
                        COSStream key = image instanceof PDImageXObject ? ((PDImageXObject) image).getCOSObject() : null;
                        Written done = key != null ? written.get(key) : null;
                        if (done == null) {
                            String[] ext = {"png"};
                            String base = String.format(Locale.ROOT, "images/page%03d-%02d", pageIndex + 1, onPage);
                            String file = null;
                            if (!manifestOnly) {
                                byte[] data;
                                try {
                                    data = originalBytes(image, ext);
                                    if (data == null) {
                                        ext[0] = "png";
                                        data = png(image.getImage());
                                    }
                                } catch (IOException | RuntimeException exc) {
                                    // e.g. a JBIG2 or JPEG 2000 picture with a mask, and no decoder for it
                                    unreadable.add((pageIndex + 1) + ":" + onPage);
                                    entry.put("error", "This picture's format could not be decoded");
                                    manifest.add(entry);
                                    continue;
                                }
                                file = base + "." + ext[0];
                                zip.putNextEntry(new ZipEntry(file));
                                zip.write(data);
                                zip.closeEntry();
                            } else {
                                file = base;
                            }
                            done = new Written(file, ext[0]);
                            if (key != null) {
                                written.put(key, done);
                            }
                        } else {
                            entry.put("sameAs", done.file);
                        }
                        if (!manifestOnly) {
                            entry.put("file", done.file);
                            entry.put("format", done.format);
                        }
                        manifest.add(entry);
                    }
                }
                Map<String, Object> summary = new LinkedHashMap<>();
                summary.put("pageCount", doc.getNumberOfPages());
                summary.put("pages", pages.size());
                summary.put("pageSizes", sizes);
                summary.put("images", manifest);
                summary.put("files", written.size());
                if (!unreadable.isEmpty()) {
                    summary.put("unreadable", unreadable);
                }
                if (manifestOnly) {
                    ctx.json(summary);
                    return;
                }
                zip.putNextEntry(new ZipEntry("manifest.json"));
                zip.write(MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(summary));
                zip.closeEntry();
            }
            ctx.header("X-Image-Count", String.valueOf(manifest.size()));
            ctx.contentType("application/zip").result(zipBytes.toByteArray());
        }
    }

    // ------------------------------------------------------------------ images to PDF

    /** Pixels per inch stored in the file (JPEG JFIF / PNG pHYs / TIFF), or 0. */
    private static float storedDpi(IIOMetadata meta) {
        if (meta == null || !meta.isStandardMetadataFormatSupported()) {
            return 0;
        }
        try {
            Node root = meta.getAsTree("javax_imageio_1.0");
            for (Node n = root.getFirstChild(); n != null; n = n.getNextSibling()) {
                if (!"Dimension".equals(n.getNodeName())) {
                    continue;
                }
                for (Node d = n.getFirstChild(); d != null; d = d.getNextSibling()) {
                    if ("HorizontalPixelSize".equals(d.getNodeName())) {
                        float mm = Float.parseFloat(d.getAttributes().getNamedItem("value").getNodeValue());
                        return mm > 0 ? 25.4f / mm : 0;
                    }
                }
            }
        } catch (RuntimeException exc) {
            return 0;
        }
        return 0;
    }

    /** EXIF orientation of a JPEG (1 = upright), read from its APP1 segment. */
    static int exifOrientation(byte[] jpeg) {
        int i = 2;
        while (i + 4 < jpeg.length && (jpeg[i] & 0xFF) == 0xFF) {
            int marker = jpeg[i + 1] & 0xFF;
            int len = ((jpeg[i + 2] & 0xFF) << 8) | (jpeg[i + 3] & 0xFF);
            if (marker == 0xDA || len < 2) {
                break;
            }
            int start = i + 4;
            if (marker == 0xE1 && start + 14 < jpeg.length
                    && jpeg[start] == 'E' && jpeg[start + 1] == 'x' && jpeg[start + 2] == 'i' && jpeg[start + 3] == 'f') {
                int tiff = start + 6;
                boolean little = jpeg[tiff] == 'I';
                int ifd = tiff + readInt(jpeg, tiff + 4, little);
                if (ifd + 2 > jpeg.length) {
                    return 1;
                }
                int entries = readShort(jpeg, ifd, little);
                for (int e = 0; e < entries; e++) {
                    int at = ifd + 2 + e * 12;
                    if (at + 12 > jpeg.length) {
                        return 1;
                    }
                    if (readShort(jpeg, at, little) == 0x0112) {
                        return readShort(jpeg, at + 8, little);
                    }
                }
                return 1;
            }
            i += 2 + len;
        }
        return 1;
    }

    private static int readShort(byte[] b, int at, boolean little) {
        return little ? (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8) : ((b[at] & 0xFF) << 8) | (b[at + 1] & 0xFF);
    }

    private static int readInt(byte[] b, int at, boolean little) {
        return little
                ? (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8) | ((b[at + 2] & 0xFF) << 16) | ((b[at + 3] & 0xFF) << 24)
                : ((b[at] & 0xFF) << 24) | ((b[at + 1] & 0xFF) << 16) | ((b[at + 2] & 0xFF) << 8) | (b[at + 3] & 0xFF);
    }

    private static void addPage(PDDocument doc, PDImageXObject image, float dpi, int rotation) throws IOException {
        int pw = image.getWidth();
        int ph = image.getHeight();
        if (dpi < 50 || dpi > 2400) {
            dpi = Math.max(72f, Math.max(pw, ph) / A4_LONG_INCHES);
        }
        float w = pw * 72f / dpi;
        float h = ph * 72f / dpi;
        PDPage page = new PDPage(new PDRectangle(w, h));
        page.setRotation(rotation);
        doc.addPage(page);
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            cs.drawImage(image, 0, 0, w, h);
        }
    }

    private static int addImageFile(PDDocument doc, String name, byte[] data) throws IOException {
        boolean jpeg = data.length > 3 && (data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8;
        try (ImageInputStream in = ImageIO.createImageInputStream(new ByteArrayInputStream(data))) {
            Iterator<ImageReader> readers = in == null ? null : ImageIO.getImageReaders(in);
            if (readers == null || !readers.hasNext()) {
                throw new IllegalArgumentException(name + " is not a picture OpenPDF can read (JPEG, PNG, TIFF, GIF or BMP)");
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(in);
                int frames = jpeg ? 1 : Math.max(1, reader.getNumImages(true));
                for (int f = 0; f < frames; f++) {
                    long pixels = (long) reader.getWidth(f) * reader.getHeight(f);
                    if (pixels > MAX_PIXELS) {
                        throw new IllegalArgumentException(name + " is too large (" + reader.getWidth(f) + " × "
                                + reader.getHeight(f) + " pixels)");
                    }
                    float dpi = storedDpi(reader.getImageMetadata(f));
                    if (jpeg) {
                        int rotation;
                        switch (exifOrientation(data)) {
                            case 3: rotation = 180; break;
                            case 6: rotation = 90; break;
                            case 8: rotation = 270; break;
                            default: rotation = 0;
                        }
                        // Embedded as it is; CMYK and grey JPEGs too.
                        addPage(doc, JPEGFactory.createFromByteArray(doc, data), dpi, rotation);
                    } else {
                        BufferedImage image = reader.read(f);
                        addPage(doc, LosslessFactory.createFromImage(doc, image), dpi, 0);
                    }
                }
                return frames;
            } finally {
                reader.dispose();
            }
        }
    }

    static void imagesToPdf(Context ctx) throws IOException {
        List<UploadedFile> files = ctx.uploadedFiles("file");
        if (files.isEmpty()) {
            ctx.status(400).result("Missing file field");
            return;
        }
        if (files.size() > MAX_INPUT_IMAGES) {
            userError(ctx, "At most " + MAX_INPUT_IMAGES + " pictures at a time");
            return;
        }
        try (PDDocument doc = new PDDocument()) {
            for (UploadedFile file : files) {
                byte[] data = file.content().readAllBytes();
                try {
                    addImageFile(doc, file.filename(), data);
                } catch (IllegalArgumentException exc) {
                    userError(ctx, exc.getMessage());
                    return;
                } catch (IOException exc) {
                    userError(ctx, file.filename() + " could not be read as a picture (it may be damaged)");
                    return;
                }
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            doc.save(out);
            ctx.header("X-Page-Count", String.valueOf(doc.getNumberOfPages()));
            ctx.contentType("application/pdf").result(out.toByteArray());
        }
    }
}
