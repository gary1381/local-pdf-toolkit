package com.pdfgateway;

import java.awt.Color;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSObject;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDFormContentStream;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.optionalcontent.PDOptionalContentGroup;
import org.apache.pdfbox.pdmodel.graphics.optionalcontent.PDOptionalContentProperties;

/**
 * The editor's text boxes ("Edit text" and "Cover") and comments live in the
 * browser and are kept in the file's metadata, so OpenPDF can edit them
 * again. This class also draws them into the pages, so every PDF reader shows
 * and prints them, and erases what each Cover box covers (RegionEraser).
 *
 * The drawing is one form XObject per page, in the optional content group
 * (layer) "OpenPDF edits", tagged /OpenPDFEdits so the next save can take the
 * old drawing out before drawing the boxes again. OpenPDF hides that layer on
 * screen, where it draws the boxes itself.
 */
final class EditsLayer {
    static final String LAYER_NAME = "OpenPDF edits";
    static final COSName MARK = COSName.getPDFName("OpenPDFEdits");
    private static final COSName OC = COSName.getPDFName("OC");

    private EditsLayer() {
    }

    /** Draw the items into their pages (replacing an earlier drawing) and report. */
    static Map<String, Object> apply(PDDocument doc, List<Map<String, Object>> items,
                                     PdfboxServer.FontResources fonts) throws IOException {
        return apply(doc, items, fonts, false);
    }

    /**
     * As above; with {@code permanent} the items become ordinary page content:
     * no layer, no tag (a later save cannot take them out), and the caller drops
     * the editable copy. Used before redaction, which must not leave text the
     * editor would draw again on top of a redacted page.
     */
    static Map<String, Object> apply(PDDocument doc, List<Map<String, Object>> items,
                                     PdfboxServer.FontResources fonts, boolean permanent) throws IOException {
        int pages = doc.getNumberOfPages();
        // the look of replaced text found by an earlier save (the text itself is gone by now)
        Map<String, TextStyle> styles = keptStyles(doc);
        for (int i = 0; i < pages; i++) {
            removeDrawing(doc.getPage(i));
        }
        Map<Integer, List<Map<String, Object>>> byPage = new TreeMap<>();
        for (Map<String, Object> item : items) {
            if (item == null) {
                continue;
            }
            int page = (int) num(item.get("pageIndex"), -1);
            if (page < 0 || page >= pages || str(item.get("text")).isBlank()
                    || num(item.get("width"), 0) <= 0 || num(item.get("height"), 0) <= 0) {
                continue;
            }
            byPage.computeIfAbsent(page, k -> new ArrayList<>()).add(item);
        }

        RegionEraser.Result erased = new RegionEraser.Result();
        int covers = 0;
        for (Map.Entry<Integer, List<Map<String, Object>>> entry : byPage.entrySet()) {
            PDPage page = doc.getPage(entry.getKey());
            PdfboxServer.PageSpace space = new PdfboxServer.PageSpace(page);
            List<PDRectangle> rects = new ArrayList<>();
            for (Map<String, Object> item : entry.getValue()) {
                // Edit text on the page's own text: note its look before it is erased
                String id = str(item.get("id"));
                if ("cover".equals(item.get("kind")) && Boolean.TRUE.equals(item.get("matchStyle"))
                        && !styles.containsKey(id) && item.get("origin") instanceof Map<?, ?> o) {
                    try {
                        TextStyle style = TextStyle.probe(page, num(o.get("x"), 0), num(o.get("y"), 0),
                                num(o.get("width"), 0), num(o.get("height"), 0));
                        if (style != null) {
                            styles.put(id, style);
                        }
                    } catch (IOException | RuntimeException exc) {
                        // a standard font then
                    }
                }
                if ("cover".equals(item.get("kind"))) {
                    float[] area = eraseArea(item);
                    rects.add(space.userRect(area[0], area[1], area[2], area[3]));
                }
            }
            covers += rects.size();
            erased.add(RegionEraser.erase(doc, page, rects));
        }

        int drawn = 0;
        if (byPage.isEmpty() || permanent) {
            removeLayer(doc);
        }
        if (!byPage.isEmpty()) {
            PDOptionalContentGroup layer = permanent ? null : layer(doc);
            for (Map.Entry<Integer, List<Map<String, Object>>> entry : byPage.entrySet()) {
                draw(doc, doc.getPage(entry.getKey()), entry.getValue(), layer, fonts, !permanent, styles);
                drawn += entry.getValue().size();
            }
        }
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("drawn", drawn);
        report.put("covers", covers);
        report.put("glyphsErased", erased.glyphs);
        report.put("imagesErased", erased.images);
        report.put("annotationsErased", erased.annotations);
        report.put("textLeft", erased.textLeft);
        report.put("notErased", new ArrayList<>(erased.notErased));
        return report;
    }

    /** Take out what an earlier save drew: the tagged content streams and the form. */
    static void removeDrawing(PDPage page) {
        COSDictionary dict = page.getCOSObject();
        if (dict.getDictionaryObject(COSName.CONTENTS) instanceof COSArray array) {
            COSArray keep = new COSArray();
            boolean changed = false;
            for (int i = 0; i < array.size(); i++) {
                if (array.getObject(i) instanceof COSStream s && s.getBoolean(MARK, false)) {
                    changed = true;
                } else {
                    keep.add(array.get(i));
                }
            }
            if (changed) {
                dict.setItem(COSName.CONTENTS, keep.size() == 1 ? keep.get(0) : keep);
            }
        }
        if (dict.getItem(COSName.RESOURCES) instanceof COSDictionary res
                && res.getItem(COSName.XOBJECT) instanceof COSDictionary xobjects) {
            xobjects.removeItem(MARK);
        }
    }

    /** Draw a page's items into a new form and show it after the page content. */
    private static void draw(PDDocument doc, PDPage page, List<Map<String, Object>> items,
                             PDOptionalContentGroup layer, PdfboxServer.FontResources fonts, boolean tag,
                             Map<String, TextStyle> styles) throws IOException {
        PdfboxServer.PageSpace space = new PdfboxServer.PageSpace(page);
        PDFormXObject form = new PDFormXObject(doc);
        PDRectangle media = page.getMediaBox();
        form.setBBox(new PDRectangle(media.getLowerLeftX(), media.getLowerLeftY(), media.getWidth(), media.getHeight()));
        form.setResources(new PDResources());
        if (layer != null) {
            form.getCOSObject().setItem(OC, layer);
        }
        if (tag) {
            form.getCOSObject().setBoolean(MARK, true);
        }
        try (PDFormContentStream cs = new PDFormContentStream(form)) {
            // tagged, so the editor can tell this drawing from the page's own text (pdf.js text content)
            cs.beginMarkedContent(MARK);
            cs.transform(space.toUser()); // from here on: displayed page, origin bottom-left
            for (Map<String, Object> item : items) {
                if ("callout".equals(item.get("kind"))) {
                    drawCallout(doc, cs, item, space.vh, fonts);
                } else {
                    TextStyle style = Boolean.TRUE.equals(item.get("matchStyle")) && "cover".equals(item.get("kind"))
                            ? styles.get(str(item.get("id"))) : null;
                    if (style == null && item.get("paragraph") instanceof Map<?, ?>) {
                        style = TextStyle.plain(num(item.get("fontSize"), 12));
                    }
                    drawBox(doc, cs, item, space.vh, fonts, style);
                }
            }
            cs.endMarkedContent();
        }
        COSDictionary xobjects = RegionEraser.ownSubDict(RegionEraser.ownResources(page), COSName.XOBJECT);
        COSName name = MARK;
        if (!tag) { // a free name: the tagged one is removed by the next save
            int n = 1;
            while (xobjects.containsKey(COSName.getPDFName("OpenPDFText" + n))) {
                n++;
            }
            name = COSName.getPDFName("OpenPDFText" + n);
        }
        xobjects.setItem(name, form);

        // q <page content> Q q /OpenPDFEdits Do Q: the page content cannot leave
        // its graphics state (a transformation, a clip) to the drawing.
        COSArray contents = new COSArray();
        contents.add(tagged(doc, "q\n", tag));
        COSDictionary dict = page.getCOSObject();
        if (dict.getDictionaryObject(COSName.CONTENTS) instanceof COSArray old) {
            for (int i = 0; i < old.size(); i++) {
                contents.add(old.get(i));
            }
        } else if (dict.getItem(COSName.CONTENTS) != null) {
            contents.add(dict.getItem(COSName.CONTENTS));
        }
        contents.add(tagged(doc, "Q\nq /" + name.getName() + " Do Q\n", tag));
        dict.setItem(COSName.CONTENTS, contents);
    }

    private static COSStream tagged(PDDocument doc, String content, boolean tag) throws IOException {
        COSStream stream = doc.getDocument().createCOSStream();
        if (tag) {
            stream.setBoolean(MARK, true);
        }
        try (OutputStream out = stream.createOutputStream()) {
            out.write(content.getBytes(StandardCharsets.US_ASCII));
        }
        return stream;
    }

    /** The layer, created (visible) if the file has none yet. */
    private static PDOptionalContentGroup layer(PDDocument doc) {
        PDDocumentCatalog catalog = doc.getDocumentCatalog();
        PDOptionalContentProperties props = catalog.getOCProperties();
        if (props == null) {
            props = new PDOptionalContentProperties();
            catalog.setOCProperties(props);
        }
        for (PDOptionalContentGroup group : props.getOptionalContentGroups()) {
            if (group.getCOSObject().getBoolean(MARK, false)) {
                props.setGroupEnabled(group, true);
                return group;
            }
        }
        PDOptionalContentGroup group = new PDOptionalContentGroup(LAYER_NAME);
        group.getCOSObject().setBoolean(MARK, true);
        props.addGroup(group);
        props.setGroupEnabled(group, true);
        return group;
    }

    /** Nothing to draw any more: take the layer out of the file's layer list. */
    private static void removeLayer(PDDocument doc) {
        PDOptionalContentProperties props = doc.getDocumentCatalog().getOCProperties();
        if (props == null) {
            return;
        }
        COSDictionary root = props.getCOSObject();
        dropOurs(root.getDictionaryObject(COSName.getPDFName("OCGs")));
        if (root.getDictionaryObject(COSName.getPDFName("D")) instanceof COSDictionary config) {
            for (String key : new String[] {"ON", "OFF", "Order", "RBGroups", "Locked"}) {
                dropOurs(config.getDictionaryObject(COSName.getPDFName(key)));
            }
        }
    }

    private static void dropOurs(COSBase list) {
        if (!(list instanceof COSArray array)) {
            return;
        }
        for (int i = array.size() - 1; i >= 0; i--) {
            COSBase item = array.getObject(i);
            if (item instanceof COSDictionary d && d.getBoolean(MARK, false)) {
                array.remove(i);
            } else if (item instanceof COSArray nested) {
                dropOurs(nested);
            }
        }
    }

    // ------------------------------------------------------------------ drawing
    // Item coordinates are points from the displayed page's top-left (as the
    // editor sends them); vh turns them into the bottom-left origin used here.
    // The sizes follow the editor's CSS (styles.css: .placed-text-content,
    // .callout-overlay) so the printed boxes look like the ones on screen.

    /** An "Edit text" or "Cover" box: one line of text, Cover with a white background. */
    private static void drawBox(PDDocument doc, PDFormContentStream cs, Map<String, Object> item, float vh,
                                PdfboxServer.FontResources fonts, TextStyle style) throws IOException {
        float x = num(item.get("x"), 0);
        float y = num(item.get("y"), 0);
        float w = num(item.get("width"), 0);
        float h = num(item.get("height"), 0);
        float size = Math.max(1f, num(item.get("fontSize"), 12));
        boolean cover = "cover".equals(item.get("kind"));
        Map<?, ?> colors = item.get("colors") instanceof Map<?, ?> m ? m : Map.of();
        Color background = color(colors.get("idleBackground"), cover ? Color.WHITE : null);
        Color ink = color(colors.get("idleColor"), new Color(0x11, 0x18, 0x27));
        float bottom = vh - y - h;

        cs.saveGraphicsState();
        if (background != null) {
            // a box grown past the text it replaces hides only that text (nothing else was erased)
            float[] area = cover ? eraseArea(item) : new float[] {x, y, w, h};
            cs.setNonStrokingColor(background);
            cs.addRect(area[0], vh - area[1] - area[3], area[2], area[3]);
            cs.fill();
        }
        cs.addRect(x, bottom, w, h);
        cs.clip();
        String raw = str(item.get("text"));
        if (style != null && !(colors.get("idleColor") instanceof String)) {
            boolean paragraph = item.get("paragraph") instanceof Map<?, ?>;
            cs.drawForm(styledText(doc, item, style, paragraph ? raw : raw.replaceAll("\\R", " "), vh, fonts));
            cs.restoreGraphicsState();
            return;
        }
        PDFont font = font(doc, fonts, str(item.get("fontFamily")), raw);
        String text = PdfboxServer.sanitizeText(font, raw, false);
        if (ink != null) {
            cs.setNonStrokingColor(ink);
            float baseline = vh - (y + 1f + size * (font instanceof PDType0Font ? 1.0f : 0.947f));
            cs.beginText();
            cs.setFont(font, size);
            cs.newLineAtOffset(x + 3f, baseline);
            cs.showText(text);
            cs.endText();
        }
        cs.restoreGraphicsState();
    }

    /**
     * The text of an Edit text box in the look of the text it replaces: its own
     * font when that has all the characters, else a standard font of the same
     * kind; its size, colour and spacing; its first character where the old one
     * was. A small form of its own, which also keeps the style for later saves.
     */
    private static PDFormXObject styledText(PDDocument doc, Map<String, Object> item, TextStyle style, String text,
                                            float vh, PdfboxServer.FontResources fonts) throws IOException {
        float itemSize = num(item.get("fontSize"), style.size);
        float size = style.size > 0 && Math.abs(itemSize - style.size) < 0.6f ? style.size : itemSize;
        float scaling = style.horizontalScaling / 100f;
        TextStyle.Face face = style.font != null
                ? TextStyle.Face.original(style.font, text, size, style.charSpacing, scaling) : null;
        if (face == null) {
            PDFont standard = style.similarStandardFont();
            PDFont font = PdfboxServer.canEncode(standard, text) ? standard : fonts.cjk(doc);
            text = PdfboxServer.sanitizeText(font, text, true);
            face = TextStyle.Face.of(font, size, style.charSpacing, scaling);
        }
        float x = num(item.get("x"), 0);
        float y = num(item.get("y"), 0);
        float left = Float.isNaN(style.dx) ? x + 3f : x + style.dx;
        float baselineTop = Float.isNaN(style.dy) ? y + 1f + size * 0.947f : y + style.dy;
        // a paragraph: wrapped to the width of the text it replaces, with its line spacing and alignment
        float maxWidth = Float.MAX_VALUE;
        float lineHeight = size * 1.2f;
        String align = "left";
        float indent = 0f;
        if (item.get("paragraph") instanceof Map<?, ?> para) {
            indent = Math.max(0f, num(para.get("indent"), 0f));
            maxWidth = Math.max(size, num(para.get("width"), num(item.get("width"), 0) - 6f));
            lineHeight = num(para.get("lineHeight"), lineHeight);
            align = para.get("align") instanceof String a ? a : "left";
            if (Float.isNaN(style.dx) && para.get("left") != null) {
                left = x + num(para.get("left"), 3f);
            }
        }
        if (indent > 0 && Float.isNaN(style.dx) == false) {
            left -= indent; // the style's first character sat at the indented start
        }
        List<TextStyle.Line> lines = TextStyle.layout(face, text, left, vh - baselineTop, maxWidth, lineHeight, align, indent);

        PDFormXObject form = new PDFormXObject(doc);
        form.setBBox(new PDRectangle(-20000f, -20000f, 40000f, 40000f));
        PDResources resources = new PDResources();
        resources.put(COSName.getPDFName("F0"), face.font);
        form.setResources(resources);
        form.getCOSObject().setString(TextStyle.ITEM, str(item.get("id")));
        form.getCOSObject().setItem(TextStyle.STYLE, style.toDict());
        try (OutputStream out = form.getContentStream().createOutputStream()) {
            out.write(style.showLines(lines, face).getBytes(StandardCharsets.US_ASCII));
        }
        return form;
    }

    /** What an Edit text box removes: the text it replaces when it knows it ("origin"), else the box. */
    private static float[] eraseArea(Map<String, Object> item) {
        if (item.get("origin") instanceof Map<?, ?> o && num(o.get("width"), 0) > 0 && num(o.get("height"), 0) > 0) {
            return new float[] {num(o.get("x"), 0), num(o.get("y"), 0), num(o.get("width"), 0), num(o.get("height"), 0)};
        }
        return new float[] {num(item.get("x"), 0), num(item.get("y"), 0), num(item.get("width"), 0),
            num(item.get("height"), 0)};
    }

    /** Styles kept with the boxes of an earlier drawing, by box id. */
    private static Map<String, TextStyle> keptStyles(PDDocument doc) {
        Map<String, TextStyle> styles = new java.util.HashMap<>();
        for (int i = 0; i < doc.getNumberOfPages(); i++) {
            if (!(doc.getPage(i).getCOSObject().getItem(COSName.RESOURCES) instanceof COSDictionary res)
                    || !(res.getDictionaryObject(COSName.XOBJECT) instanceof COSDictionary xobjects)
                    || !(xobjects.getDictionaryObject(MARK) instanceof COSStream drawing)
                    || !(drawing.getDictionaryObject(COSName.RESOURCES) instanceof COSDictionary inner)
                    || !(inner.getDictionaryObject(COSName.XOBJECT) instanceof COSDictionary boxes)) {
                continue;
            }
            for (COSName name : boxes.keySet()) {
                if (boxes.getDictionaryObject(name) instanceof COSStream box && box.getString(TextStyle.ITEM) != null
                        && box.getDictionaryObject(TextStyle.STYLE) instanceof COSDictionary st) {
                    styles.put(box.getString(TextStyle.ITEM), TextStyle.fromDict(st));
                }
            }
        }
        return styles;
    }

    /** A comment: a rounded box with wrapped text and an arrow to where it points. */
    private static void drawCallout(PDDocument doc, PDFormContentStream cs, Map<String, Object> item, float vh,
                                    PdfboxServer.FontResources fonts) throws IOException {
        float x = num(item.get("x"), 0);
        float y = num(item.get("y"), 0);
        float w = num(item.get("width"), 0);
        float h = num(item.get("height"), 0);
        float ax = num(item.get("anchorX"), x);
        float ay = num(item.get("anchorY"), y);
        float size = Math.max(1f, num(item.get("fontSize"), 12));
        Map<?, ?> colors = item.get("colors") instanceof Map<?, ?> m ? m : Map.of();
        Color background = color(colors.get("idleBackground"), Color.WHITE);
        Color ink = color(colors.get("idleColor"), new Color(0x1e, 0x29, 0x3b));
        Color line = new Color(0x33, 0x41, 0x55);

        // the arrow: from the box edge towards the anchor (app.js: paintCalloutArrow)
        float cx = x + w / 2f;
        float cy = y + h / 2f;
        float dx = ax - cx;
        float dy = ay - cy;
        boolean inside = Math.abs(dx) <= w / 2f && Math.abs(dy) <= h / 2f;
        if (!inside) {
            float sx = dx != 0 ? (w / 2f) / Math.abs(dx) : Float.MAX_VALUE;
            float sy = dy != 0 ? (h / 2f) / Math.abs(dy) : Float.MAX_VALUE;
            float s = Math.min(sx, sy);
            float ex = cx + dx * s;
            float ey = cy + dy * s;
            double angle = Math.atan2(ay - ey, ax - ex);
            float endX = (float) (ax - Math.cos(angle) * 8);
            float endY = (float) (ay - Math.sin(angle) * 8);
            cs.saveGraphicsState();
            cs.setStrokingColor(line);
            cs.setNonStrokingColor(line);
            cs.setLineWidth(1.5f);
            cs.setLineCapStyle(1);
            cs.moveTo(ex, vh - ey);
            cs.lineTo(endX, vh - endY);
            cs.stroke();
            double a1 = angle + Math.PI * 0.82;
            double a2 = angle - Math.PI * 0.82;
            cs.moveTo(ax, vh - ay);
            cs.lineTo((float) (ax + Math.cos(a1) * 7), (float) (vh - (ay + Math.sin(a1) * 7)));
            cs.lineTo((float) (ax + Math.cos(a2) * 7), (float) (vh - (ay + Math.sin(a2) * 7)));
            cs.closePath();
            cs.fill();
            cs.restoreGraphicsState();
        }

        float bottom = vh - y - h;
        float r = Math.min(12f, Math.min(w, h) / 2f);
        cs.saveGraphicsState();
        roundedRect(cs, x, bottom, w, h, r);
        if (background != null) {
            cs.setNonStrokingColor(background);
        }
        // on screen a shadow sets the box off the page; on paper a thin border does
        cs.setStrokingColor(new Color(0xcb, 0xd5, 0xe1));
        cs.setLineWidth(0.75f);
        if (background != null) {
            cs.fillAndStroke();
        } else {
            cs.stroke();
        }
        roundedRect(cs, x, bottom, w, h, r);
        cs.clip();
        String raw = str(item.get("text"));
        PDFont font = font(doc, fonts, str(item.get("fontFamily")), raw);
        String text = PdfboxServer.sanitizeText(font, raw, true);
        float lineHeight = size * 1.35f;
        List<String> lines = wrap(font, size, text, Math.max(8f, w - 24f));
        if (ink != null) {
            cs.setNonStrokingColor(ink);
            float top = y + 8f + size * 1.02f;
            for (String l : lines) {
                if (top - size > y + h) {
                    break;
                }
                if (!l.isEmpty()) {
                    cs.beginText();
                    cs.setFont(font, size);
                    cs.newLineAtOffset(x + 12f, vh - top);
                    cs.showText(l);
                    cs.endText();
                }
                top += lineHeight;
            }
        }
        cs.restoreGraphicsState();
    }

    /**
     * Lines as the editor shows them (CSS white-space: pre-wrap; word-break:
     * break-word): break at spaces, inside a word only when it is wider than
     * the line. Chinese and Japanese text may break between any characters.
     */
    static List<String> wrap(PDFont font, float size, String text, float maxWidth) throws IOException {
        List<String> lines = new ArrayList<>();
        for (String paragraph : text.split("\\R", -1)) {
            StringBuilder line = new StringBuilder();
            int i = 0;
            while (i < paragraph.length()) {
                // the next piece: a run of spaces, a word, or one CJK character
                int start = i;
                int cp = paragraph.codePointAt(i);
                if (cp == ' ') {
                    while (i < paragraph.length() && paragraph.charAt(i) == ' ') {
                        i++;
                    }
                } else if (breaksAnywhere(cp)) {
                    i += Character.charCount(cp);
                } else {
                    while (i < paragraph.length()) {
                        int c = paragraph.codePointAt(i);
                        if (c == ' ' || breaksAnywhere(c)) {
                            break;
                        }
                        i += Character.charCount(c);
                    }
                }
                String piece = paragraph.substring(start, i);
                if (width(font, size, line + piece) <= maxWidth || line.length() == 0 && piece.isBlank()) {
                    line.append(piece);
                    continue;
                }
                if (piece.isBlank()) { // spaces at the end of a line do not move to the next one
                    lines.add(line.toString());
                    line.setLength(0);
                    continue;
                }
                if (line.length() > 0) {
                    lines.add(line.toString().stripTrailing());
                    line.setLength(0);
                }
                // a word longer than the line: break it where it no longer fits
                for (int j = 0; j < piece.length(); ) {
                    int c = piece.codePointAt(j);
                    String ch = new String(Character.toChars(c));
                    if (line.length() > 0 && width(font, size, line + ch) > maxWidth) {
                        lines.add(line.toString());
                        line.setLength(0);
                    }
                    line.append(ch);
                    j += Character.charCount(c);
                }
            }
            lines.add(line.toString().stripTrailing());
        }
        return lines;
    }

    private static boolean breaksAnywhere(int cp) {
        Character.UnicodeScript s = Character.UnicodeScript.of(cp);
        return s == Character.UnicodeScript.HAN || s == Character.UnicodeScript.HIRAGANA
                || s == Character.UnicodeScript.KATAKANA // Korean breaks at spaces, like Latin text
                || Character.UnicodeBlock.of(cp) == Character.UnicodeBlock.CJK_SYMBOLS_AND_PUNCTUATION
                || Character.UnicodeBlock.of(cp) == Character.UnicodeBlock.HALFWIDTH_AND_FULLWIDTH_FORMS;
    }

    private static float width(PDFont font, float size, String s) throws IOException {
        return font.getStringWidth(s) / 1000f * size;
    }

    private static void roundedRect(PDFormContentStream cs, float x, float y, float w, float h, float r)
            throws IOException {
        float k = 0.5523f * r; // control point distance for a quarter circle
        cs.moveTo(x + r, y);
        cs.lineTo(x + w - r, y);
        cs.curveTo(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
        cs.lineTo(x + w, y + h - r);
        cs.curveTo(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
        cs.lineTo(x + r, y + h);
        cs.curveTo(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
        cs.lineTo(x, y + r);
        cs.curveTo(x, y + r - k, x + r - k, y, x + r, y);
        cs.closePath();
    }

    /** The editor's font choice as a PDF font; Chinese (or anything Latin fonts lack) uses the CJK font. */
    private static PDFont font(PDDocument doc, PdfboxServer.FontResources fonts, String family, String text)
            throws IOException {
        String f = family.toLowerCase();
        if (f.contains("宋") || f.contains("黑") || f.contains("song") || f.contains("hei")) {
            return fonts.cjk(doc);
        }
        Standard14Fonts.FontName name = f.contains("times") ? Standard14Fonts.FontName.TIMES_ROMAN
                : f.contains("courier") ? Standard14Fonts.FontName.COURIER
                : Standard14Fonts.FontName.HELVETICA;
        PDFont latin = new PDType1Font(name);
        return PdfboxServer.canEncode(latin, text) ? latin : fonts.cjk(doc);
    }

    /** "#rrggbb" (or "#rgb") as a colour; "transparent" as null; anything else gives the fallback. */
    private static Color color(Object value, Color fallback) {
        if (!(value instanceof String s)) {
            return fallback;
        }
        s = s.trim();
        if ("transparent".equalsIgnoreCase(s)) {
            return null;
        }
        if (s.matches("#[0-9a-fA-F]{3}")) {
            s = "#" + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2) + s.charAt(3) + s.charAt(3);
        }
        if (s.matches("#[0-9a-fA-F]{6}")) {
            return new Color(Integer.parseInt(s.substring(1), 16));
        }
        return fallback;
    }

    private static float num(Object value, float fallback) {
        if (value instanceof Number n && Float.isFinite(n.floatValue())) {
            return n.floatValue();
        }
        return fallback;
    }

    private static String str(Object value) {
        return value instanceof String s ? s : "";
    }
}
