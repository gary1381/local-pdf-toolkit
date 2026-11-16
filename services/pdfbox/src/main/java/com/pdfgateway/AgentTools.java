package com.pdfgateway;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.http.Context;
import io.javalin.http.UploadedFile;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineNode;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
import org.apache.pdfbox.pdmodel.interactive.form.PDNonTerminalField;
import org.apache.pdfbox.pdmodel.interactive.form.PDSignatureField;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Endpoints made for AI agents: page geometry, per-page text, text search with
 * positions, and redaction that really removes the content.
 *
 * Coordinates are PDF points (1/72 inch) on the page as displayed (crop box,
 * page rotation applied), origin at the top-left corner, y growing downwards:
 * the same frame as a rendered page image divided by its scale.
 */
final class AgentTools {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final ObjectMapper ASCII_MAPPER = new ObjectMapper();

    static {
        ASCII_MAPPER.getFactory().configure(JsonGenerator.Feature.ESCAPE_NON_ASCII, true);
    }

    private static final int MAX_TERMS = 200;
    private static final int MAX_REGIONS = 2000;
    private static final int MAX_MATCHES = 5000;

    private AgentTools() {}

    // ------------------------------------------------------------------ helpers

    private static byte[] readUpload(Context ctx) throws IOException {
        UploadedFile file = ctx.uploadedFile("file");
        if (file == null) {
            ctx.status(400).result("Missing file field");
            return null;
        }
        return file.content().readAllBytes();
    }

    private static PDDocument open(byte[] bytes, String password) throws IOException {
        if (password != null && !password.isBlank()) {
            return Loader.loadPDF(bytes, password);
        }
        return Loader.loadPDF(bytes);
    }

    private static void userError(Context ctx, String message) {
        ctx.status(400).json(Map.of("detail", "USER:" + message));
    }

    private static float round(double v) {
        return Math.round(v * 100.0) / 100.0f;
    }

    /** 1-based page spec "1-3,5,8-" (empty = all) to 0-based indexes, sorted, in range. */
    static List<Integer> parsePages(String spec, int pageCount) {
        TreeSet<Integer> out = new TreeSet<>();
        if (spec == null || spec.isBlank() || spec.trim().equalsIgnoreCase("all")) {
            for (int i = 0; i < pageCount; i++) {
                out.add(i);
            }
            return new ArrayList<>(out);
        }
        for (String part : spec.replace(" ", "").split(",")) {
            if (part.isEmpty()) {
                continue;
            }
            String[] ends = part.split("-", -1);
            int start = Integer.parseInt(ends[0]);
            int end = ends.length == 1 ? start : (ends[1].isEmpty() ? pageCount : Integer.parseInt(ends[1]));
            for (int p = Math.max(1, start); p <= Math.min(end, pageCount); p++) {
                out.add(p - 1);
            }
        }
        return new ArrayList<>(out);
    }

    // ------------------------------------------------------------------ page info

    static void pageInfo(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        try (PDDocument doc = open(bytes, ctx.formParam("password"))) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("pageCount", doc.getNumberOfPages());
            payload.put("encrypted", doc.isEncrypted());
            PDDocumentInformation info = doc.getDocumentInformation();
            Map<String, Object> meta = new LinkedHashMap<>();
            if (info != null) {
                putIf(meta, "title", info.getTitle());
                putIf(meta, "author", info.getAuthor());
                putIf(meta, "subject", info.getSubject());
                putIf(meta, "keywords", info.getKeywords());
                putIf(meta, "creator", info.getCreator());
                putIf(meta, "producer", info.getProducer());
                if (info.getCreationDate() != null) {
                    meta.put("created", info.getCreationDate().toInstant().toString());
                }
                if (info.getModificationDate() != null) {
                    meta.put("modified", info.getModificationDate().toInstant().toString());
                }
            }
            payload.put("metadata", meta);

            int fields = 0;
            int signatures = 0;
            PDAcroForm form = doc.getDocumentCatalog().getAcroForm();
            if (form != null) {
                for (PDField field : form.getFieldTree()) {
                    if (field instanceof PDNonTerminalField) {
                        continue;
                    }
                    if (field instanceof PDSignatureField sig) {
                        if (sig.getValue() != null) {
                            signatures++;
                        }
                    } else {
                        fields++;
                    }
                }
            }
            payload.put("formFieldCount", fields);
            payload.put("signatureCount", signatures);

            // Characters of extractable text per page: 0 on a page means it is
            // a scan (or a picture) and needs OCR before its words can be read.
            PDFTextStripper stripper = new PDFTextStripper();
            List<Map<String, Object>> pages = new ArrayList<>();
            int scanned = 0;
            for (int i = 0; i < doc.getNumberOfPages(); i++) {
                PDPage page = doc.getPage(i);
                PdfboxServer.PageSpace space = new PdfboxServer.PageSpace(page);
                stripper.setStartPage(i + 1);
                stripper.setEndPage(i + 1);
                int chars = stripper.getText(doc).replaceAll("\\s+", "").length();
                if (chars == 0) {
                    scanned++;
                }
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("page", i + 1);
                p.put("width", round(space.vw));
                p.put("height", round(space.vh));
                p.put("rotation", space.rotation);
                p.put("textChars", chars);
                p.put("annotations", page.getAnnotations().size());
                pages.add(p);
            }
            payload.put("pagesWithoutText", scanned);
            payload.put("pages", pages);
            ctx.json(payload);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to read PDF info: " + exc.getMessage());
        }
    }

    private static void putIf(Map<String, Object> map, String key, String value) {
        if (value != null && !value.isBlank()) {
            map.put(key, value);
        }
    }

    // ------------------------------------------------------------------ per-page text

    static void pageText(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        try (PDDocument doc = open(bytes, ctx.formParam("password"))) {
            List<Integer> pages;
            try {
                pages = parsePages(ctx.formParam("pages"), doc.getNumberOfPages());
            } catch (NumberFormatException exc) {
                userError(ctx, "Invalid page range; use a form like 1-3,5,8-");
                return;
            }
            PDFTextStripper stripper = new PDFTextStripper();
            stripper.setSortByPosition("1".equals(ctx.formParam("sortByPosition")));
            List<Map<String, Object>> out = new ArrayList<>();
            for (int i : pages) {
                stripper.setStartPage(i + 1);
                stripper.setEndPage(i + 1);
                String text = stripper.getText(doc);
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("page", i + 1);
                p.put("text", text);
                out.add(p);
            }
            ctx.json(Map.of("pageCount", doc.getNumberOfPages(), "pages", out));
        } catch (IOException exc) {
            ctx.status(422).result("Failed to extract text: " + exc.getMessage());
        }
    }

    // ------------------------------------------------------------------ text search

    /** Page text with, for every character, the glyph it came from (null for separators). */
    static final class MappedText {
        final StringBuilder text = new StringBuilder();
        final List<TextPosition> glyphs = new ArrayList<>();
    }

    static final class MappingStripper extends PDFTextStripper {
        MappedText current;
        /** Glyphs drawn invisibly (render mode 3): an OCR text layer over a picture. */
        final java.util.Set<TextPosition> invisible =
                java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        /**
         * Marked content with /ActualText: PDFBox gives the whole replacement
         * text to the span's first glyph and none to the others, so a match there
         * must cover every glyph of the span (first glyph -> all of them).
         */
        final Map<TextPosition, List<TextPosition>> actualTextSpans = new java.util.IdentityHashMap<>();
        private final java.util.ArrayDeque<List<TextPosition>> openSpans = new java.util.ArrayDeque<>();
        private static final List<TextPosition> NO_ACTUAL_TEXT = List.of();

        @Override
        public void beginMarkedContentSequence(org.apache.pdfbox.cos.COSName tag,
                                               org.apache.pdfbox.cos.COSDictionary properties) {
            boolean actual = properties != null && properties.getItem(org.apache.pdfbox.cos.COSName.ACTUAL_TEXT) != null;
            openSpans.push(actual ? new ArrayList<>() : NO_ACTUAL_TEXT);
            super.beginMarkedContentSequence(tag, properties);
        }

        @Override
        public void endMarkedContentSequence() {
            List<TextPosition> span = openSpans.poll();
            if (span != null && !span.isEmpty()) {
                actualTextSpans.put(span.get(0), span);
            }
            super.endMarkedContentSequence();
        }

        @Override
        protected void processTextPosition(TextPosition text) {
            if (getGraphicsState().getTextState().getRenderingMode()
                    == org.apache.pdfbox.pdmodel.graphics.state.RenderingMode.NEITHER) {
                invisible.add(text);
            }
            // the innermost span with /ActualText, as PDFBox uses
            for (List<TextPosition> span : openSpans) {
                if (span != NO_ACTUAL_TEXT) {
                    span.add(text);
                    break;
                }
            }
            super.processTextPosition(text);
        }

        MappingStripper() throws IOException {
            super();
            setSortByPosition(true);
        }

        MappedText page(PDDocument doc, int index) throws IOException {
            current = new MappedText();
            actualTextSpans.clear();
            openSpans.clear();
            setStartPage(index + 1);
            setEndPage(index + 1);
            getText(doc);
            return current;
        }

        @Override
        protected void writeString(String text, List<TextPosition> positions) {
            for (TextPosition tp : positions) {
                String u = tp.getUnicode();
                if (u == null) {
                    continue;
                }
                for (int k = 0; k < u.length(); k++) {
                    current.text.append(u.charAt(k));
                    current.glyphs.add(tp);
                }
            }
        }

        @Override
        protected void writeWordSeparator() {
            current.text.append(' ');
            current.glyphs.add(null);
        }

        @Override
        protected void writeLineSeparator() {
            current.text.append('\n');
            current.glyphs.add(null);
        }
    }

    /** A box in display space, top-left origin. */
    record Box(float x, float y, float w, float h) {
        Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("x", round(x));
            m.put("y", round(y));
            m.put("width", round(w));
            m.put("height", round(h));
            return m;
        }
    }

    /** {@code ocrText}: the match is in an invisible OCR layer, whose boxes only approximate the pixels. */
    record Match(int pageIndex, String term, String text, List<Box> boxes, boolean ocrText) {}

    /** Whitespace runs folded to one space, optionally lower-cased; keeps a map back to the source. */
    private static String fold(String s, boolean caseSensitive, List<Integer> map) {
        StringBuilder b = new StringBuilder();
        boolean space = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isWhitespace(c) || c == ' ') {
                if (!space && b.length() > 0) {
                    b.append(' ');
                    if (map != null) {
                        map.add(i);
                    }
                }
                space = true;
                continue;
            }
            space = false;
            b.append(caseSensitive ? c : Character.toLowerCase(c));
            if (map != null) {
                map.add(i);
            }
        }
        return b.toString();
    }

    static List<Match> find(PDDocument doc, List<String> terms, boolean caseSensitive, List<Integer> pages)
            throws IOException {
        return find(doc, terms, caseSensitive, pages, false);
    }

    /** Text with every whitespace character dropped (for letter-spaced text such as "J o h n"). */
    private static String squeeze(String s, boolean caseSensitive, List<Integer> map) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isWhitespace(c) || c == ' ' || c == '­') {
                continue;
            }
            b.append(caseSensitive ? c : Character.toLowerCase(c));
            if (map != null) {
                map.add(i);
            }
        }
        return b.toString();
    }

    /**
     * True when source[start..end] may be the term with spaces or line breaks
     * inside ("J o h n", "Jo hn", a term wrapped across lines): it begins and ends
     * at a word boundary, so "an" inside "a nice" does not count.
     */
    static boolean letterSpaced(String source, int start, int end) {
        if (start > 0 && joins(source.charAt(start - 1), source.charAt(start))) {
            return false;
        }
        return end + 1 >= source.length() || !joins(source.charAt(end), source.charAt(end + 1));
    }

    /** True if two neighbouring characters belong to one word (scripts written without spaces never join). */
    static boolean joins(char a, char b) {
        return Character.isLetterOrDigit(a) && Character.isLetterOrDigit(b) && !unspaced(a) && !unspaced(b);
    }

    /** Han, Kana, Thai, Lao, Khmer, Myanmar: words are not separated by spaces. */
    static boolean unspaced(int cp) {
        Character.UnicodeScript s = Character.UnicodeScript.of(cp);
        return s == Character.UnicodeScript.HAN || s == Character.UnicodeScript.HIRAGANA
                || s == Character.UnicodeScript.KATAKANA || s == Character.UnicodeScript.THAI
                || s == Character.UnicodeScript.LAO || s == Character.UnicodeScript.KHMER
                || s == Character.UnicodeScript.MYANMAR;
    }

    /**
     * Find terms on pages. {@code loose} (used by redaction) also matches when
     * the text has extra spaces or line breaks inside the term, so letter-spaced
     * or wrapped words are not missed.
     */
    static List<Match> find(PDDocument doc, List<String> terms, boolean caseSensitive, List<Integer> pages,
                            boolean loose) throws IOException {
        MappingStripper stripper = new MappingStripper();
        List<Match> matches = new ArrayList<>();
        for (int pageIndex : pages) {
            MappedText mt = stripper.page(doc, pageIndex);
            int rotation = new PdfboxServer.PageSpace(doc.getPage(pageIndex)).rotation;
            java.util.Set<Long> starts = new java.util.HashSet<>(); // (term index, source start): exact, no hashing
            String source = mt.text.toString();
            for (int pass = 0; pass < (loose ? 2 : 1); pass++) {
            List<Integer> map = new ArrayList<>();
            String hay = pass == 0 ? fold(source, caseSensitive, map)
                    : squeeze(source, caseSensitive, map);
            for (int ti = 0; ti < terms.size(); ti++) {
                String term = terms.get(ti);
                String needle = pass == 0 ? fold(term, caseSensitive, null).trim() : squeeze(term, caseSensitive, null);
                if (needle.isEmpty()) {
                    continue;
                }
                int from = 0;
                while (matches.size() < MAX_MATCHES) {
                    int at = hay.indexOf(needle, from);
                    if (at < 0) {
                        break;
                    }
                    int srcStart = map.get(at);
                    int srcEnd = map.get(at + needle.length() - 1);
                    if (pass == 1 && !letterSpaced(source, srcStart, srcEnd)) {
                        from = at + 1;
                        continue; // the loose pass is only for letter-spaced text, not text across words
                    }
                    if (!starts.add(((long) ti << 32) | srcStart)) {
                        from = at + needle.length();
                        continue; // already found by the first pass
                    }
                    List<TextPosition> glyphs = new ArrayList<>();
                    for (int k = srcStart; k <= srcEnd; k++) {
                        TextPosition tp = mt.glyphs.get(k);
                        if (tp != null && (glyphs.isEmpty() || glyphs.get(glyphs.size() - 1) != tp)) {
                            // text given as /ActualText: every glyph it stands for
                            glyphs.addAll(stripper.actualTextSpans.getOrDefault(tp, List.of(tp)));
                        }
                    }
                    boolean ocrText = glyphs.stream().anyMatch(stripper.invisible::contains);
                    matches.add(new Match(pageIndex, term, mt.text.substring(srcStart, srcEnd + 1),
                            boxesFor(glyphs, rotation), ocrText));
                    from = at + needle.length();
                }
            }
            }
        }
        return matches;
    }

    /**
     * One box per line of glyphs, generous enough to cover ascenders and
     * descenders. getX/getY are the glyph's baseline start on the displayed
     * page; the text may run in any of four directions there (its own
     * direction plus the page rotation).
     */
    static List<Box> boxesFor(List<TextPosition> glyphs, int pageRotation) {
        List<Box> boxes = new ArrayList<>();
        float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
        float lastLine = Float.NaN;
        int lastDir = -1;
        for (TextPosition tp : glyphs) {
            float size = Math.max(tp.getFontSizeInPt(), tp.getHeightDir());
            if (size <= 0) {
                size = 10f;
            }
            int dir = ((Math.round(tp.getDir() / 90f) * 90 + pageRotation) % 360 + 360) % 360;
            float bx = tp.getX();
            float by = tp.getY();
            float adv = Math.max(tp.getWidthDirAdj(), 0.5f);
            float asc = size * 0.9f;
            float desc = size * 0.3f;
            float left, right, top, bottom, line;
            switch (dir) {
                case 90 -> { left = bx - desc; right = bx + asc; top = by; bottom = by + adv; line = bx; }
                case 180 -> { left = bx - adv; right = bx; top = by - desc; bottom = by + asc; line = by; }
                case 270 -> { left = bx - asc; right = bx + desc; top = by - adv; bottom = by; line = bx; }
                default -> { left = bx; right = bx + adv; top = by - asc; bottom = by + desc; line = by; }
            }
            boolean sameLine = dir == lastDir && !Float.isNaN(lastLine) && Math.abs(line - lastLine) < size * 0.5f;
            if (!sameLine) {
                if (!Float.isNaN(lastLine)) {
                    boxes.add(new Box(x0, y0, x1 - x0, y1 - y0));
                }
                x0 = left;
                x1 = right;
                y0 = top;
                y1 = bottom;
            } else {
                x0 = Math.min(x0, left);
                x1 = Math.max(x1, right);
                y0 = Math.min(y0, top);
                y1 = Math.max(y1, bottom);
            }
            lastLine = line;
            lastDir = dir;
        }
        if (!Float.isNaN(lastLine)) {
            boxes.add(new Box(x0, y0, x1 - x0, y1 - y0));
        }
        return boxes;
    }

    // ------------------------------------------------------------------ text layout

    /**
     * The page's text as phrases with boxes: a line is cut where the gap between
     * two glyphs is wider than about a character, so separate labels on one line
     * (form captions, table cells) come out separately.
     */
    static List<Map<String, Object>> phrases(PDDocument doc, int pageIndex, MappingStripper stripper)
            throws IOException {
        MappedText mt = stripper.page(doc, pageIndex);
        int rotation = new PdfboxServer.PageSpace(doc.getPage(pageIndex)).rotation;
        List<Map<String, Object>> out = new ArrayList<>();
        StringBuilder text = new StringBuilder();
        List<TextPosition> glyphs = new ArrayList<>();
        Box last = null;
        for (int k = 0; k <= mt.text.length(); k++) {
            boolean end = k == mt.text.length() || mt.text.charAt(k) == '\n';
            TextPosition tp = end ? null : mt.glyphs.get(k);
            if (!end && tp == null) { // word separator
                if (text.length() > 0) {
                    text.append(' ');
                }
                continue;
            }
            boolean split = end;
            Box b = null;
            if (tp != null) {
                b = boxesFor(List.of(tp), rotation).get(0);
                if (last != null) {
                    float size = Math.max(tp.getFontSizeInPt(), 6f);
                    float gap = b.x() - (last.x() + last.w());
                    boolean otherLine = Math.abs((b.y() + b.h()) - (last.y() + last.h())) > size * 0.6f;
                    split = gap > Math.max(size * 1.2f, 7f) || gap < -size * 2 || otherLine;
                }
            }
            if (split && !glyphs.isEmpty()) {
                String s = text.toString().strip();
                if (!s.isEmpty()) {
                    float x0 = Float.MAX_VALUE, y0 = Float.MAX_VALUE, x1 = -Float.MAX_VALUE, y1 = -Float.MAX_VALUE;
                    for (Box lb : boxesFor(glyphs, rotation)) {
                        x0 = Math.min(x0, lb.x());
                        y0 = Math.min(y0, lb.y());
                        x1 = Math.max(x1, lb.x() + lb.w());
                        y1 = Math.max(y1, lb.y() + lb.h());
                    }
                    Map<String, Object> m = new Box(x0, y0, x1 - x0, y1 - y0).toMap();
                    m.put("text", s);
                    out.add(m);
                }
                text.setLength(0);
                glyphs.clear();
                last = null;
            }
            if (tp != null) {
                if (glyphs.isEmpty() || glyphs.get(glyphs.size() - 1) != tp) {
                    glyphs.add(tp);
                }
                text.append(mt.text.charAt(k));
                last = b;
            }
        }
        return out;
    }

    static void textLayout(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        try (PDDocument doc = open(bytes, ctx.formParam("password"))) {
            List<Integer> pages;
            try {
                pages = parsePages(ctx.formParam("pages"), doc.getNumberOfPages());
            } catch (NumberFormatException exc) {
                userError(ctx, "Invalid page range; use a form like 1-3,5,8-");
                return;
            }
            MappingStripper stripper = new MappingStripper();
            List<Map<String, Object>> out = new ArrayList<>();
            for (int i : pages) {
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("page", i + 1);
                p.put("phrases", phrases(doc, i, stripper));
                out.add(p);
            }
            ctx.json(Map.of("pageCount", doc.getNumberOfPages(), "pages", out));
        } catch (IOException exc) {
            ctx.status(422).result("Failed to read text layout: " + exc.getMessage());
        }
    }

    private static List<String> readTerms(Context ctx) throws IOException {
        String raw = ctx.formParam("terms");
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        List<String> terms = MAPPER.readValue(raw, new TypeReference<List<String>>() {});
        List<String> out = new ArrayList<>();
        for (String t : terms) {
            if (t != null && !t.isBlank()) {
                out.add(t);
            }
        }
        if (out.size() > MAX_TERMS) {
            throw new IllegalArgumentException("Too many search terms (limit " + MAX_TERMS + ")");
        }
        return out;
    }

    static void findText(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        List<String> terms;
        try {
            terms = readTerms(ctx);
        } catch (IllegalArgumentException | IOException exc) {
            userError(ctx, "terms must be a JSON array of strings");
            return;
        }
        if (terms.isEmpty()) {
            userError(ctx, "Give at least one search term");
            return;
        }
        boolean caseSensitive = "1".equals(ctx.formParam("caseSensitive"));
        try (PDDocument doc = open(bytes, ctx.formParam("password"))) {
            List<Integer> pages;
            try {
                pages = parsePages(ctx.formParam("pages"), doc.getNumberOfPages());
            } catch (NumberFormatException exc) {
                userError(ctx, "Invalid page range; use a form like 1-3,5,8-");
                return;
            }
            List<Match> matches = find(doc, terms, caseSensitive, pages);
            List<Map<String, Object>> out = new ArrayList<>();
            for (Match m : matches) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("page", m.pageIndex() + 1);
                item.put("term", m.term());
                item.put("text", m.text());
                List<Map<String, Object>> boxes = new ArrayList<>();
                for (Box b : m.boxes()) {
                    boxes.add(b.toMap());
                }
                item.put("boxes", boxes);
                out.add(item);
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("matchCount", out.size());
            payload.put("truncated", out.size() >= MAX_MATCHES);
            payload.put("matches", out);
            ctx.json(payload);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to search text: " + exc.getMessage());
        }
    }

    /** Small shim so the DPI rule lives in one place. */
    static final class PdfboxServerAccess {
        static float clampDpi(String raw) {
            float dpi = 200f;
            if (raw != null && !raw.isBlank()) {
                try {
                    dpi = Float.parseFloat(raw.trim());
                } catch (NumberFormatException exc) {
                    dpi = 200f;
                }
            }
            if (!Float.isFinite(dpi)) {
                dpi = 200f;
            }
            return Math.max(72f, Math.min(dpi, 400f));
        }
    }
}
