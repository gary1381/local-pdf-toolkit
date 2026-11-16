package com.pdfgateway;

import java.awt.geom.AffineTransform;
import java.awt.geom.NoninvertibleTransformException;
import java.awt.geom.Point2D;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.apache.pdfbox.contentstream.PDFStreamEngine;
import org.apache.pdfbox.contentstream.operator.DrawObject;
import org.apache.pdfbox.contentstream.operator.state.Concatenate;
import org.apache.pdfbox.contentstream.operator.state.Restore;
import org.apache.pdfbox.contentstream.operator.state.Save;
import org.apache.pdfbox.contentstream.operator.state.SetGraphicsStateParameters;
import org.apache.pdfbox.contentstream.operator.state.SetMatrix;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingColor;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingColorN;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingColorSpace;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingDeviceCMYKColor;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingDeviceGrayColor;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingDeviceRGBColor;
import org.apache.pdfbox.contentstream.operator.text.BeginText;
import org.apache.pdfbox.contentstream.operator.text.EndText;
import org.apache.pdfbox.contentstream.operator.text.MoveText;
import org.apache.pdfbox.contentstream.operator.text.MoveTextSetLeading;
import org.apache.pdfbox.contentstream.operator.text.NextLine;
import org.apache.pdfbox.contentstream.operator.text.SetCharSpacing;
import org.apache.pdfbox.contentstream.operator.text.SetFontAndSize;
import org.apache.pdfbox.contentstream.operator.text.SetTextHorizontalScaling;
import org.apache.pdfbox.contentstream.operator.text.SetTextLeading;
import org.apache.pdfbox.contentstream.operator.text.SetTextRenderingMode;
import org.apache.pdfbox.contentstream.operator.text.SetTextRise;
import org.apache.pdfbox.contentstream.operator.text.SetWordSpacing;
import org.apache.pdfbox.contentstream.operator.text.ShowText;
import org.apache.pdfbox.contentstream.operator.text.ShowTextAdjusted;
import org.apache.pdfbox.contentstream.operator.text.ShowTextLine;
import org.apache.pdfbox.contentstream.operator.text.ShowTextLineAndSpace;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSFloat;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDFontDescriptor;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.PDType3Font;
import org.apache.pdfbox.pdmodel.font.PDVectorFont;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.graphics.state.RenderingMode;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.util.Vector;

/**
 * The look of the text an "Edit text" box replaces: font, size, colour,
 * spacing and where its first character sat. EditsLayer writes the new text
 * with that font when it has every character needed, otherwise with a
 * standard font of the same kind (serif or not, bold, italic, fixed width).
 *
 * The style is found once, while the old text is still on the page, and kept
 * with the drawing (/OpenPDFStyle on the box's own form), so later saves, when
 * the old text is gone, still use it.
 */
final class TextStyle {
    static final COSName ITEM = COSName.getPDFName("OpenPDFItem");
    static final COSName STYLE = COSName.getPDFName("OpenPDFStyle");

    /** The font as found on the page (null: use a standard font). */
    PDFont font;
    COSDictionary fontDict;
    float size;
    float[] rgb = {0f, 0f, 0f};
    float charSpacing;
    float horizontalScaling = 100f;
    /** First character: from the box's left edge, and its baseline from the box's top (points). */
    float dx = Float.NaN;
    float dy = Float.NaN;
    String baseFont = "";
    boolean serif;
    boolean bold;
    boolean italic;
    boolean fixedPitch;

    private TextStyle() {
    }

    // ------------------------------------------------------------------ finding it

    /** The style of the visible text whose glyph middles lie in the rectangle (displayed coordinates), or null. */
    static TextStyle probe(PDPage page, float x, float y, float w, float h) throws IOException {
        PdfboxServer.PageSpace space = new PdfboxServer.PageSpace(page);
        PDRectangle user = space.userRect(x, y, w, h);
        AffineTransform toVisual;
        try {
            toVisual = space.toUser().createAffineTransform().createInverse();
        } catch (NoninvertibleTransformException exc) {
            return null;
        }
        Probe probe = new Probe(page, user, toVisual, space.vh);
        probe.processPage(page);
        Probe.Seen best = null;
        for (Probe.Seen s : probe.seen.values()) {
            if (best == null || s.count > best.count) {
                best = s;
            }
        }
        if (best == null) {
            return null;
        }
        TextStyle style = best.style;
        style.dx = best.firstX - x;
        style.dy = best.baselineTop - y;
        return style;
    }

    /** Collects, per font, how many visible upright glyphs fall in the rectangle and the leftmost one's style. */
    private static final class Probe extends PDFStreamEngine {
        static final class Seen {
            int count;
            float firstX = Float.MAX_VALUE;
            float baselineTop;
            TextStyle style;
        }

        final Map<COSDictionary, Seen> seen = new IdentityHashMap<>();
        private final PDRectangle rect;
        private final AffineTransform toVisual;
        private final float vh;

        Probe(PDPage page, PDRectangle rect, AffineTransform toVisual, float vh) {
            this.rect = rect;
            this.toVisual = toVisual;
            this.vh = vh;
            addOperator(new BeginText(this));
            addOperator(new EndText(this));
            addOperator(new Concatenate(this));
            addOperator(new Save(this));
            addOperator(new Restore(this));
            addOperator(new SetGraphicsStateParameters(this));
            addOperator(new SetMatrix(this));
            addOperator(new MoveText(this));
            addOperator(new MoveTextSetLeading(this));
            addOperator(new NextLine(this));
            addOperator(new SetCharSpacing(this));
            addOperator(new SetFontAndSize(this));
            addOperator(new SetTextHorizontalScaling(this));
            addOperator(new SetTextLeading(this));
            addOperator(new SetTextRenderingMode(this));
            addOperator(new SetTextRise(this));
            addOperator(new SetWordSpacing(this));
            addOperator(new ShowText(this));
            addOperator(new ShowTextAdjusted(this));
            addOperator(new ShowTextLine(this));
            addOperator(new ShowTextLineAndSpace(this));
            addOperator(new DrawObject(this));
            addOperator(new SetNonStrokingColor(this));
            addOperator(new SetNonStrokingColorN(this));
            addOperator(new SetNonStrokingColorSpace(this));
            addOperator(new SetNonStrokingDeviceCMYKColor(this));
            addOperator(new SetNonStrokingDeviceGrayColor(this));
            addOperator(new SetNonStrokingDeviceRGBColor(this));
        }

        @Override
        protected void showGlyph(Matrix trm, PDFont font, int code, Vector displacement) throws IOException {
            if (font == null || font.isVertical() || font instanceof PDType3Font) {
                return;
            }
            RenderingMode mode = getGraphicsState().getTextState().getRenderingMode();
            if (mode == RenderingMode.NEITHER || mode == RenderingMode.NEITHER_CLIP) {
                return; // invisible (OCR) text has no look to copy
            }
            Point2D.Float mid = trm.transformPoint(displacement.getX() / 2f, 0.3f);
            if (!rect.contains(mid.x, mid.y)) {
                return;
            }
            // the glyph's axes as displayed: must be upright and unskewed
            double[] m = new double[6];
            AffineTransform t = new AffineTransform(toVisual);
            t.concatenate(trm.createAffineTransform());
            t.getMatrix(m);
            double a = m[0];
            double b = m[1];
            double c = m[2];
            double d = m[3];
            if (a <= 0 || d <= 0 || Math.abs(b) > 0.01 * a || Math.abs(c) > 0.01 * d) {
                return;
            }
            Seen s = seen.computeIfAbsent(font.getCOSObject(), k -> new Seen());
            s.count++;
            // the first character: on the top line, the leftmost there
            float x = (float) m[4];
            float top = vh - (float) m[5];
            boolean higher = s.style == null || top < s.baselineTop - 0.5f * (float) d;
            boolean sameLine = s.style != null && Math.abs(top - s.baselineTop) <= 0.5f * (float) d;
            if (higher || sameLine && x < s.firstX) {
                s.firstX = x;
                s.baselineTop = top;
                TextStyle style = new TextStyle();
                style.font = font;
                style.fontDict = font.getCOSObject();
                style.size = (float) d;
                style.horizontalScaling = (float) (a / d * 100.0);
                float fontSize = getGraphicsState().getTextState().getFontSize();
                float k = fontSize != 0 ? (float) d / fontSize : 1f;
                style.charSpacing = getGraphicsState().getTextState().getCharacterSpacing() * k;
                try {
                    int rgb = getGraphicsState().getNonStrokingColor().toRGB();
                    style.rgb = new float[] {((rgb >> 16) & 255) / 255f, ((rgb >> 8) & 255) / 255f, (rgb & 255) / 255f};
                } catch (IOException | RuntimeException exc) {
                    // keep black
                }
                style.describe(font);
                s.style = style;
            }
        }
    }

    private void describe(PDFont f) {
        String name = f.getName() == null ? "" : f.getName();
        baseFont = name.replaceFirst("^[A-Z]{6}\\+", "");
        String lower = baseFont.toLowerCase(Locale.ROOT);
        PDFontDescriptor fd = f.getFontDescriptor();
        serif = fd != null && fd.isSerif() || lower.contains("times") || lower.contains("serif") && !lower.contains("sans")
                || lower.contains("georgia") || lower.contains("garamond") || lower.contains("cambria")
                || lower.contains("song") || lower.contains("mincho") || lower.contains("ming");
        fixedPitch = fd != null && fd.isFixedPitch() || lower.contains("courier") || lower.contains("mono");
        bold = fd != null && (fd.isForceBold() || fd.getFontWeight() >= 600) || lower.contains("bold")
                || lower.contains("black") || lower.contains("heavy") || lower.contains("semibold");
        italic = fd != null && fd.isItalic() || lower.contains("italic") || lower.contains("oblique");
    }

    // ------------------------------------------------------------------ keeping it

    /** Stored with the box's form, so the next save finds the style again. */
    COSDictionary toDict() {
        COSDictionary d = new COSDictionary();
        d.setFloat("Size", size);
        COSArray color = new COSArray();
        for (float v : rgb) {
            color.add(new COSFloat(v));
        }
        d.setItem("Color", color);
        d.setFloat("Tc", charSpacing);
        d.setFloat("Tz", horizontalScaling);
        if (!Float.isNaN(dx)) {
            d.setFloat("DX", dx);
            d.setFloat("DY", dy);
        }
        d.setString("BaseFont", baseFont);
        d.setBoolean("Serif", serif);
        d.setBoolean("Bold", bold);
        d.setBoolean("Italic", italic);
        d.setBoolean("FixedPitch", fixedPitch);
        if (fontDict != null) {
            d.setItem("Font", fontDict);
        }
        return d;
    }

    static TextStyle fromDict(COSDictionary d) {
        if (d == null) {
            return null;
        }
        TextStyle s = new TextStyle();
        s.size = d.getFloat("Size", 0f);
        if (d.getDictionaryObject(COSName.getPDFName("Color")) instanceof COSArray color && color.size() == 3) {
            s.rgb = color.toFloatArray();
        }
        s.charSpacing = d.getFloat("Tc", 0f);
        s.horizontalScaling = d.getFloat("Tz", 100f);
        if (d.containsKey(COSName.getPDFName("DX"))) {
            s.dx = d.getFloat("DX", 0f);
            s.dy = d.getFloat("DY", 0f);
        }
        s.baseFont = d.getString("BaseFont", "");
        s.serif = d.getBoolean("Serif", false);
        s.bold = d.getBoolean("Bold", false);
        s.italic = d.getBoolean("Italic", false);
        s.fixedPitch = d.getBoolean("FixedPitch", false);
        if (d.getDictionaryObject(COSName.FONT) instanceof COSDictionary fd) {
            s.fontDict = fd;
            try {
                s.font = org.apache.pdfbox.pdmodel.font.PDFontFactory.createFont(fd);
            } catch (IOException | RuntimeException exc) {
                s.font = null;
            }
        }
        return s;
    }

    // ------------------------------------------------------------------ writing with it

    /** A standard font of the same kind (not embedded; readers have these). */
    PDFont similarStandardFont() {
        Standard14Fonts.FontName name;
        if (fixedPitch) {
            name = bold && italic ? Standard14Fonts.FontName.COURIER_BOLD_OBLIQUE
                    : bold ? Standard14Fonts.FontName.COURIER_BOLD
                    : italic ? Standard14Fonts.FontName.COURIER_OBLIQUE : Standard14Fonts.FontName.COURIER;
        } else if (serif) {
            name = bold && italic ? Standard14Fonts.FontName.TIMES_BOLD_ITALIC
                    : bold ? Standard14Fonts.FontName.TIMES_BOLD
                    : italic ? Standard14Fonts.FontName.TIMES_ITALIC : Standard14Fonts.FontName.TIMES_ROMAN;
        } else {
            name = bold && italic ? Standard14Fonts.FontName.HELVETICA_BOLD_OBLIQUE
                    : bold ? Standard14Fonts.FontName.HELVETICA_BOLD
                    : italic ? Standard14Fonts.FontName.HELVETICA_OBLIQUE : Standard14Fonts.FontName.HELVETICA;
        }
        return new PDType1Font(name);
    }

    /** A style for text without a page text to copy: a standard font, black. */
    static TextStyle plain(float size) {
        TextStyle s = new TextStyle();
        s.size = size;
        return s;
    }

    /**
     * A font as used for writing: its codes for characters and their widths.
     * For a font found on the page, codes come from its own ToUnicode/encoding,
     * so subset fonts work for the characters they contain (composite fonts:
     * Identity-H only). A standard or loaded font encodes anything it has.
     */
    static final class Face {
        final PDFont font;
        private final Map<String, Integer> codes; // null: the font encodes itself
        private final int bytes;
        final float size;
        final float charSpacing;
        final float scaling; // horizontal, 1 = 100 %

        private Face(PDFont font, Map<String, Integer> codes, int bytes, float size, float charSpacing, float scaling) {
            this.font = font;
            this.codes = codes;
            this.bytes = bytes;
            this.size = size;
            this.charSpacing = charSpacing;
            this.scaling = scaling;
        }

        /** The page's own font, if it can show every character of the text (spaces may be missing). */
        static Face original(PDFont font, String text, float size, float charSpacing, float scaling) {
            try {
                int bytes = 1;
                int last = 255;
                if (font instanceof PDType0Font t0) {
                    if (t0.getCMap() == null || !"Identity-H".equals(t0.getCMap().getName())) {
                        return null;
                    }
                    bytes = 2;
                    last = 65535;
                }
                Map<String, Integer> codes = new HashMap<>();
                for (int code = 0; code <= last; code++) {
                    String u = font.toUnicode(code);
                    if (u != null && !codes.containsKey(u) && hasGlyph(font, code)) {
                        codes.put(u, code);
                    }
                }
                if (codes.isEmpty()) {
                    return null; // no way to know which code shows which character
                }
                Face face = new Face(font, codes, bytes, size, charSpacing, scaling);
                return face.canShow(text) ? face : null;
            } catch (RuntimeException exc) {
                return null;
            }
        }

        /** A standard or loaded font (for a loaded one, the characters are added to its subset). */
        static Face of(PDFont font, float size, float charSpacing, float scaling) {
            return new Face(font, null, 1, size, charSpacing, scaling);
        }

        boolean canShow(String text) {
            for (int i = 0; i < text.length(); ) {
                int cp = text.codePointAt(i);
                i += Character.charCount(cp);
                if (Character.isWhitespace(cp)) {
                    continue;
                }
                if (encode(new String(Character.toChars(cp))) == null) {
                    return false;
                }
            }
            return true;
        }

        boolean hasSpace() {
            return codes == null || codes.containsKey(" ");
        }

        /** The codes of a piece of text, or null when a character is missing. */
        byte[] encode(String s) {
            if (codes == null) {
                try {
                    if (font instanceof PDType0Font t0) {
                        s.codePoints().forEach(t0::addToSubset);
                    }
                    return font.encode(s);
                } catch (IOException | IllegalArgumentException exc) {
                    return null;
                }
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            for (int i = 0; i < s.length(); ) {
                int cp = s.codePointAt(i);
                i += Character.charCount(cp);
                Integer code = codes.get(new String(Character.toChars(cp)));
                if (code == null) {
                    return null;
                }
                if (bytes == 2) {
                    out.write(code >> 8);
                }
                out.write(code & 255);
            }
            return out.toByteArray();
        }

        /** Advance of a piece of text, in points. */
        float width(String s) {
            byte[] b = encode(s);
            if (b == null) {
                return 0f;
            }
            float w = 0f;
            int glyphs = 0;
            try {
                if (codes == null) {
                    w = font.getStringWidth(s) / 1000f * size;
                    glyphs = s.codePointCount(0, s.length());
                } else {
                    for (int i = 0; i + bytes <= b.length; i += bytes) {
                        int code = bytes == 2 ? ((b[i] & 255) << 8) | (b[i + 1] & 255) : b[i] & 255;
                        w += font.getWidth(code) / 1000f * size;
                        glyphs++;
                    }
                }
            } catch (IOException | IllegalArgumentException exc) {
                return 0f;
            }
            return (w + charSpacing * glyphs) * scaling;
        }

        float spaceWidth() {
            if (hasSpace()) {
                return width(" ");
            }
            float space = font.getSpaceWidth();
            return (space > 0 ? space : 278f) / 1000f * size * scaling;
        }

        /** A gap of so many points, as a TJ number. */
        float gap(float points) {
            return -points * 1000f / (size * scaling);
        }
    }

    /** One line of words: where it starts, and the TJ array that shows it. */
    record Line(float x, float baseline, COSArray shown) {}

    /** A piece of a paragraph: a word, or one CJK character; with or without a space before it. */
    private record Piece(String text, boolean spaceBefore) {}

    private static List<Piece> pieces(String paragraph) {
        List<Piece> out = new ArrayList<>();
        StringBuilder word = new StringBuilder();
        boolean space = false;
        for (int i = 0; i < paragraph.length(); ) {
            int cp = paragraph.codePointAt(i);
            i += Character.charCount(cp);
            if (Character.isWhitespace(cp)) {
                if (word.length() > 0) {
                    out.add(new Piece(word.toString(), space));
                    word.setLength(0);
                }
                space = true;
                continue;
            }
            if (breaksAnywhere(cp)) {
                if (word.length() > 0) {
                    out.add(new Piece(word.toString(), space));
                    word.setLength(0);
                    space = false;
                }
                out.add(new Piece(new String(Character.toChars(cp)), space));
                space = false;
                continue;
            }
            word.appendCodePoint(cp);
        }
        if (word.length() > 0) {
            out.add(new Piece(word.toString(), space));
        }
        return out;
    }

    private static boolean breaksAnywhere(int cp) {
        Character.UnicodeScript s = Character.UnicodeScript.of(cp);
        return s == Character.UnicodeScript.HAN || s == Character.UnicodeScript.HIRAGANA
                || s == Character.UnicodeScript.KATAKANA
                || Character.UnicodeBlock.of(cp) == Character.UnicodeBlock.CJK_SYMBOLS_AND_PUNCTUATION
                || Character.UnicodeBlock.of(cp) == Character.UnicodeBlock.HALFWIDTH_AND_FULLWIDTH_FORMS;
    }

    /**
     * Lay the text out: one line (maxWidth infinite), or wrapped to maxWidth
     * with lines lineHeight apart, aligned left, right, center or justify (the
     * last line of each paragraph stays left). Line breaks in the text start a
     * new paragraph. The very first line starts firstIndent further right.
     * Coordinates are displayed ones with y up.
     */
    static List<Line> layout(Face face, String text, float left, float firstBaseline, float maxWidth,
                             float lineHeight, String align, float firstIndent) {
        List<Line> lines = new ArrayList<>();
        float baseline = firstBaseline;
        float space = face.spaceWidth();
        for (String paragraph : text.split("\\R", -1)) {
            List<Piece> all = pieces(paragraph);
            int start = 0;
            if (all.isEmpty()) {
                baseline -= lineHeight;
                continue;
            }
            while (start < all.size()) {
                float indent = lines.isEmpty() ? firstIndent : 0f;
                float room = maxWidth - indent;
                float w = face.width(all.get(start).text());
                int end = start + 1;
                while (end < all.size()) {
                    Piece p = all.get(end);
                    float add = (p.spaceBefore() ? space : 0f) + face.width(p.text());
                    if (w + add > room) {
                        break;
                    }
                    w += add;
                    end++;
                }
                boolean last = end >= all.size();
                List<Piece> words = all.subList(start, end);
                int gaps = 0;
                for (int i = 1; i < words.size(); i++) {
                    if (words.get(i).spaceBefore()) {
                        gaps++;
                    }
                }
                float extra = 0f;
                float x = left + indent;
                boolean bounded = maxWidth < Float.MAX_VALUE / 2;
                if (bounded && "justify".equals(align) && !last && gaps > 0) {
                    extra = (room - w) / gaps;
                } else if (bounded && "center".equals(align)) {
                    x = left + indent + (room - w) / 2f;
                } else if (bounded && "right".equals(align)) {
                    x = left + indent + room - w;
                }
                lines.add(new Line(x, baseline, show(face, words, extra)));
                baseline -= lineHeight;
                start = end;
            }
        }
        return lines;
    }

    private static COSArray show(Face face, List<Piece> words, float extra) {
        COSArray out = new COSArray();
        ByteArrayOutputStream run = new ByteArrayOutputStream();
        for (int i = 0; i < words.size(); i++) {
            Piece p = words.get(i);
            if (i > 0 && p.spaceBefore()) {
                if (face.hasSpace()) {
                    run.writeBytes(face.encode(" "));
                    if (extra > 0) {
                        flush(out, run);
                        out.add(new COSFloat(face.gap(extra)));
                    }
                } else {
                    flush(out, run);
                    out.add(new COSFloat(face.gap(face.spaceWidth() + extra)));
                }
            }
            byte[] b = face.encode(p.text());
            if (b != null) {
                run.writeBytes(b);
            }
        }
        flush(out, run);
        return out;
    }

    private static void flush(COSArray out, ByteArrayOutputStream run) {
        if (run.size() > 0) {
            out.add(new org.apache.pdfbox.cos.COSString(run.toByteArray()));
            run.reset();
        }
    }

    private static boolean hasGlyph(PDFont font, int code) {
        try {
            return !(font instanceof PDVectorFont v) || v.hasGlyph(code) || code == 32;
        } catch (IOException | RuntimeException exc) {
            return false;
        }
    }

    /** Content (displayed coordinates) that shows the lines with font resource /F0. */
    String showLines(List<Line> lines, Face face) {
        StringBuilder sb = new StringBuilder("BT\n");
        sb.append("/F0 ").append(num(face.size)).append(" Tf\n");
        sb.append(num(rgb[0])).append(' ').append(num(rgb[1])).append(' ').append(num(rgb[2])).append(" rg\n");
        if (face.charSpacing != 0f) {
            sb.append(num(face.charSpacing)).append(" Tc\n");
        }
        if (Math.abs(face.scaling - 1f) > 0.005f) {
            sb.append(num(face.scaling * 100f)).append(" Tz\n");
        }
        for (Line line : lines) {
            sb.append("1 0 0 1 ").append(num(line.x())).append(' ').append(num(line.baseline())).append(" Tm\n[");
            for (int i = 0; i < line.shown().size(); i++) {
                if (line.shown().getObject(i) instanceof org.apache.pdfbox.cos.COSString s) {
                    sb.append('<').append(s.toHexString()).append('>');
                } else if (line.shown().getObject(i) instanceof COSFloat f) {
                    sb.append(' ').append(num(f.floatValue())).append(' ');
                }
            }
            sb.append("] TJ\n");
        }
        sb.append("ET\n");
        return sb.toString();
    }

    private static String num(float v) {
        String s = String.format(Locale.ROOT, "%.4f", v);
        s = s.replaceFirst("\\.?0+$", "");
        return s.isEmpty() || "-".equals(s) || "-0".equals(s) ? "0" : s;
    }
}
