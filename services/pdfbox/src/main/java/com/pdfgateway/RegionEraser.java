package com.pdfgateway;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.geom.AffineTransform;
import java.awt.geom.NoninvertibleTransformException;
import java.awt.geom.Point2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.pdfbox.contentstream.PDContentStream;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSFloat;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.cos.COSObject;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDTransparencyGroup;
import org.apache.pdfbox.pdmodel.graphics.image.CCITTFactory;
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImage;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.graphics.state.PDTextState;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.util.Vector;

/**
 * Removes what lies under rectangles of a page, without turning the page into
 * a picture: the text drawn there (also invisible OCR text) is cut out of the
 * content streams, keeping every other character where it was, and the parts
 * of images under the rectangles are painted white. Annotations whose middle
 * lies in a rectangle are removed, and so are lines and shapes drawn inside
 * a rectangle (an underline, a box); drawings that reach beyond it are kept.
 *
 * Forms (XObjects) with something to remove are copied for this page, so other
 * pages that use the same form are not changed.
 *
 * Used for "Edit text" (Options.COVER: what lies mostly under the box) and by
 * the redaction (Options.REDACT: everything that touches it, also the
 * /ActualText and /Alt a reader could show instead of the removed glyphs).
 */
final class RegionEraser {
    private RegionEraser() {
    }

    /** How strict the removal is. */
    record Options(boolean strict) {
        /** Edit text: glyphs whose middle is under the box, shapes wholly inside it. */
        static final Options COVER = new Options(false);
        /** Redaction: every glyph that touches the box, shapes mostly inside it. */
        static final Options REDACT = new Options(true);
    }

    /** What happened on one page. */
    static final class Result {
        int glyphs;
        int images;
        int paths;
        int annotations;
        int textLeft;
        final Set<String> notErased = new LinkedHashSet<>();

        void add(Result other) {
            glyphs += other.glyphs;
            images += other.images;
            paths += other.paths;
            annotations += other.annotations;
            textLeft += other.textLeft;
            notErased.addAll(other.notErased);
        }
    }

    /** What to change at one operator of a content stream. */
    private static final class OpEdit {
        PDFont font;
        final Map<Integer, Float> removed = new HashMap<>(); // glyph number in the operator -> TJ gap
        PDImage image;
        final List<float[]> imageRects = new ArrayList<>(); // in the image's unit square
        PDFormXObject form; // replacement for a Do of a form
        boolean unpaint; // a path painting operator: end the path without painting it
    }

    /** One content stream as it was run: the page, or one use of a form. */
    private static final class Level {
        final Level parent;
        final int parentOp;
        final PDContentStream stream;
        final PDResources resources;
        final Map<Integer, OpEdit> edits = new HashMap<>();
        final List<Level> children = new ArrayList<>();
        int op = -1;
        int glyph;

        Level(Level parent, int parentOp, PDContentStream stream, PDResources resources) {
            this.parent = parent;
            this.parentOp = parentOp;
            this.stream = stream;
            this.resources = resources;
        }
    }

    /**
     * Runs a page and notes which glyphs and images fall in the rectangles,
     * by operator number within each content stream.
     */
    private static final class Finder extends PDFGraphicsStreamEngine {
        private final List<PDRectangle> rects;
        private final List<PDRectangle> glyphRects;
        private final Options options;
        private final boolean textOnly;
        private float pathX0 = Float.MAX_VALUE;
        private float pathY0 = Float.MAX_VALUE;
        private float pathX1 = -Float.MAX_VALUE;
        private float pathY1 = -Float.MAX_VALUE;
        private final Deque<Integer> dispatchStack = new ArrayDeque<>();
        final Level root;
        private Level cur;
        private int dispatch;
        int textHits;

        Finder(PDPage page, List<PDRectangle> rects, List<PDRectangle> glyphRects, Options options, boolean textOnly) {
            super(page);
            this.rects = rects;
            this.glyphRects = glyphRects;
            this.options = options;
            this.textOnly = textOnly;
            root = new Level(null, -1, page, page.getResources());
            cur = root;
        }

        private boolean inside(float x, float y) {
            for (PDRectangle r : rects) {
                if (x >= r.getLowerLeftX() - 0.5f && x <= r.getUpperRightX() + 0.5f
                        && y >= r.getLowerLeftY() - 0.5f && y <= r.getUpperRightY() + 0.5f) {
                    return true;
                }
            }
            return false;
        }

        @Override
        protected void processOperator(Operator operator, List<COSBase> operands) throws IOException {
            // Only operators read from the stream count; some operators run others
            // (' runs T* and Tj), which must not shift the numbering.
            if (dispatch == 0) {
                cur.op++;
                cur.glyph = 0;
            }
            dispatch++;
            try {
                super.processOperator(operator, operands);
            } finally {
                dispatch--;
            }
        }

        private void enter(PDFormXObject form) {
            PDResources res = form.getResources() != null ? form.getResources() : cur.resources;
            Level child = new Level(cur, cur.op, form, res);
            cur.children.add(child);
            dispatchStack.push(dispatch);
            dispatch = 0;
            cur = child;
        }

        private void leave() {
            cur = cur.parent;
            dispatch = dispatchStack.pop();
        }

        @Override
        public void showForm(PDFormXObject form) throws IOException {
            enter(form);
            try {
                super.showForm(form);
            } finally {
                leave();
            }
        }

        @Override
        public void showTransparencyGroup(PDTransparencyGroup form) throws IOException {
            enter(form);
            try {
                super.showTransparencyGroup(form);
            } finally {
                leave();
            }
        }

        /** Whether a glyph's box (text space: one unit = the font size) touches a glyph rectangle. */
        private boolean touches(Matrix trm, boolean vertical, Vector displacement) {
            float[] box = vertical
                    ? new float[] {-0.5f, displacement.getY(), 0.5f, 0f}
                    : new float[] {0f, -0.2f, displacement.getX(), 0.8f};
            float x0 = Float.MAX_VALUE;
            float y0 = Float.MAX_VALUE;
            float x1 = -Float.MAX_VALUE;
            float y1 = -Float.MAX_VALUE;
            for (int i = 0; i < 4; i++) {
                Point2D.Float p = trm.transformPoint(box[(i & 1) == 0 ? 0 : 2], box[i < 2 ? 1 : 3]);
                x0 = Math.min(x0, p.x);
                x1 = Math.max(x1, p.x);
                y0 = Math.min(y0, p.y);
                y1 = Math.max(y1, p.y);
            }
            float area = Math.max((x1 - x0) * (y1 - y0), 0.01f);
            for (PDRectangle r : glyphRects) {
                // A fifth of the glyph under the box is enough; a box that only grazes it (the
                // line above a marked area, the next character) leaves it, readable as before.
                float w = Math.min(x1, r.getUpperRightX()) - Math.max(x0, r.getLowerLeftX());
                float h = Math.min(y1, r.getUpperRightY()) - Math.max(y0, r.getLowerLeftY());
                if (w > 0 && h > 0 && w * h >= 0.2f * area) {
                    return true;
                }
            }
            return false;
        }

        @Override
        protected void showGlyph(Matrix trm, PDFont font, int code, Vector displacement) {
            int number = cur.glyph++;
            boolean vertical = font != null && font.isVertical();
            boolean hit;
            if (options.strict()) {
                hit = touches(trm, vertical, displacement);
            } else {
                // the middle of the glyph box, in text space (one unit = the font size)
                Point2D.Float mid = vertical
                        ? trm.transformPoint(0f, displacement.getY() / 2f)
                        : trm.transformPoint(displacement.getX() / 2f, 0.3f);
                hit = inside(mid.x, mid.y);
            }
            if (!hit) {
                return;
            }
            textHits++;
            if (textOnly || font == null) {
                return;
            }
            // The gap a TJ number must leave so the following glyphs stay in place:
            // the glyph's advance plus character (and word) spacing, in 1/1000 of the font size.
            PDTextState ts = getGraphicsState().getTextState();
            float size = ts.getFontSize();
            float spacing = ts.getCharacterSpacing();
            if (code == 32 && !(font instanceof PDType0Font)) {
                spacing += ts.getWordSpacing();
            }
            float advance = vertical ? displacement.getY() : displacement.getX();
            float gap = -(advance * 1000f + (size != 0f ? spacing * 1000f / size : 0f));
            OpEdit edit = cur.edits.computeIfAbsent(cur.op, k -> new OpEdit());
            edit.font = font;
            edit.removed.put(number, gap);
        }

        @Override
        public void drawImage(PDImage image) {
            if (textOnly) {
                return;
            }
            AffineTransform inverse;
            try {
                inverse = getGraphicsState().getCurrentTransformationMatrix().createAffineTransform().createInverse();
            } catch (NoninvertibleTransformException exc) {
                return;
            }
            List<float[]> hits = new ArrayList<>();
            for (PDRectangle r : rects) {
                float[] pts = {
                    r.getLowerLeftX(), r.getLowerLeftY(), r.getUpperRightX(), r.getLowerLeftY(),
                    r.getLowerLeftX(), r.getUpperRightY(), r.getUpperRightX(), r.getUpperRightY()
                };
                float[] unit = new float[8];
                inverse.transform(pts, 0, unit, 0, 4);
                float u0 = Float.MAX_VALUE;
                float v0 = Float.MAX_VALUE;
                float u1 = -Float.MAX_VALUE;
                float v1 = -Float.MAX_VALUE;
                for (int i = 0; i < 8; i += 2) {
                    u0 = Math.min(u0, unit[i]);
                    u1 = Math.max(u1, unit[i]);
                    v0 = Math.min(v0, unit[i + 1]);
                    v1 = Math.max(v1, unit[i + 1]);
                }
                u0 = Math.max(u0, 0f);
                v0 = Math.max(v0, 0f);
                u1 = Math.min(u1, 1f);
                v1 = Math.min(v1, 1f);
                if (u1 > u0 && v1 > v0) {
                    hits.add(new float[] {u0, v0, u1, v1});
                }
            }
            if (!hits.isEmpty()) {
                OpEdit edit = cur.edits.computeIfAbsent(cur.op, k -> new OpEdit());
                edit.image = image;
                edit.imageRects.addAll(hits);
            }
        }

        // Paths: their extent (points arrive in page space) decides at the painting operator.
        private void extend(float x, float y) {
            pathX0 = Math.min(pathX0, x);
            pathY0 = Math.min(pathY0, y);
            pathX1 = Math.max(pathX1, x);
            pathY1 = Math.max(pathY1, y);
        }

        private void resetPath() {
            pathX0 = Float.MAX_VALUE;
            pathY0 = Float.MAX_VALUE;
            pathX1 = -Float.MAX_VALUE;
            pathY1 = -Float.MAX_VALUE;
        }

        /** A painted path inside the rectangles (wholly, or for a redaction mostly) is not painted. */
        private void painted() {
            if (!textOnly && pathX1 >= pathX0 && pathY1 >= pathY0) {
                float w = Math.max(pathX1 - pathX0, 0.01f);
                float h = Math.max(pathY1 - pathY0, 0.01f);
                float area = w * h;
                for (PDRectangle r : rects) {
                    float iw = Math.min(pathX1, r.getUpperRightX() + 0.5f) - Math.max(pathX0, r.getLowerLeftX() - 0.5f);
                    float ih = Math.min(pathY1, r.getUpperRightY() + 0.5f) - Math.max(pathY0, r.getLowerLeftY() - 0.5f);
                    if (iw <= 0 || ih <= 0) {
                        continue;
                    }
                    float share = Math.min(iw, w) * Math.min(ih, h) / area;
                    if (share >= (options.strict() ? 0.5f : 0.999f)) {
                        cur.edits.computeIfAbsent(cur.op, k -> new OpEdit()).unpaint = true;
                        break;
                    }
                }
            }
            resetPath();
        }

        @Override
        public void appendRectangle(Point2D p0, Point2D p1, Point2D p2, Point2D p3) {
            for (Point2D p : new Point2D[] {p0, p1, p2, p3}) {
                extend((float) p.getX(), (float) p.getY());
            }
        }

        @Override public void moveTo(float x, float y) { extend(x, y); }
        @Override public void lineTo(float x, float y) { extend(x, y); }

        @Override
        public void curveTo(float x1, float y1, float x2, float y2, float x3, float y3) {
            extend(x1, y1);
            extend(x2, y2);
            extend(x3, y3);
        }

        @Override public Point2D getCurrentPoint() { return new Point2D.Float(); }
        @Override public void clip(int windingRule) { }
        @Override public void closePath() { }
        @Override public void endPath() { resetPath(); }
        @Override public void strokePath() { painted(); }
        @Override public void fillPath(int windingRule) { painted(); }
        @Override public void fillAndStrokePath(int windingRule) { painted(); }
        @Override public void shadingFill(COSName shadingName) { }
    }

    /**
     * Erase under rectangles given in user space of the page. Returns what was
     * removed, how much text is still found there afterwards, and what could not
     * be removed.
     */
    static Result erase(PDDocument doc, PDPage page, List<PDRectangle> rects) throws IOException {
        return erase(doc, page, rects, rects, Options.COVER);
    }

    /**
     * As above; glyphRects decide which characters go (a redaction passes the
     * exact boxes of the words there, and padded ones as rects for pictures,
     * shapes and annotations).
     */
    static Result erase(PDDocument doc, PDPage page, List<PDRectangle> rects, List<PDRectangle> glyphRects,
                        Options options) throws IOException {
        Result result = new Result();
        if (rects.isEmpty() && glyphRects.isEmpty()) {
            return result;
        }
        Finder finder = new Finder(page, rects, glyphRects, options, false);
        finder.processPage(page);
        if (rewrite(doc, page, finder.root, result, options) != null) {
            throw new IllegalStateException("the page level returns no form");
        }
        result.annotations += removeAnnotations(page, rects, options);

        Finder check = new Finder(page, rects, glyphRects, options, true);
        check.processPage(page);
        result.textLeft = check.textHits;
        return result;
    }

    /**
     * Rewrite a level whose operators (or forms below) have edits. The page is
     * rewritten in place; a form is copied and the copy returned, for its
     * parent to use instead.
     */
    private static PDFormXObject rewrite(PDDocument doc, PDPage page, Level level, Result result, Options options)
            throws IOException {
        for (Level child : level.children) {
            PDFormXObject copy = rewrite(doc, page, child, result, options);
            if (copy != null) {
                level.edits.computeIfAbsent(child.parentOp, k -> new OpEdit()).form = copy;
            }
        }
        if (level.edits.isEmpty()) {
            return null;
        }
        boolean isPage = level.parent == null;
        // Where new image and form names go: the page's own resources, or the copy's.
        COSDictionary resDict;
        if (isPage) {
            resDict = ownResources(page);
        } else {
            resDict = level.resources != null ? copyDict(level.resources.getCOSObject()) : new COSDictionary();
        }
        ownSubDict(resDict, COSName.XOBJECT);
        PDResources resources = new PDResources(resDict);

        List<Object> tokens = new PDFStreamParser(level.stream).parse();
        List<Object> out = new ArrayList<>(tokens.size() + 16);
        List<Object> operands = new ArrayList<>();
        int number = -1;
        for (Object token : tokens) {
            if (!(token instanceof Operator op)) {
                operands.add(token);
                continue;
            }
            number++;
            OpEdit edit = level.edits.get(number);
            if (options.strict() && "BDC".equals(op.getName()) && !operands.isEmpty()
                    && operands.get(operands.size() - 1) instanceof COSDictionary props) {
                // marked content can carry the words as text of its own (ActualText, Alt, E)
                COSDictionary copy = copyDict(props);
                copy.removeItem(COSName.getPDFName("ActualText"));
                copy.removeItem(COSName.getPDFName("Alt"));
                copy.removeItem(COSName.getPDFName("E"));
                operands.set(operands.size() - 1, copy);
            }
            if (edit == null || !apply(doc, op, operands, edit, resources, out, result)) {
                out.addAll(operands);
                out.add(op);
            }
            operands.clear();
        }
        out.addAll(operands);

        if (isPage) {
            PDStream stream = new PDStream(doc);
            try (OutputStream os = stream.createOutputStream(COSName.FLATE_DECODE)) {
                new ContentStreamWriter(os).writeTokens(out);
            }
            page.setContents(stream);
            return null;
        }
        COSStream original = ((PDFormXObject) level.stream).getCOSObject();
        COSStream copy = doc.getDocument().createCOSStream();
        for (Map.Entry<COSName, COSBase> e : original.entrySet()) {
            COSName key = e.getKey();
            if (!COSName.LENGTH.equals(key) && !COSName.FILTER.equals(key) && !COSName.DECODE_PARMS.equals(key)) {
                copy.setItem(key, e.getValue());
            }
        }
        copy.setItem(COSName.RESOURCES, resDict);
        try (OutputStream os = copy.createOutputStream(COSName.FLATE_DECODE)) {
            new ContentStreamWriter(os).writeTokens(out);
        }
        return new PDFormXObject(copy);
    }

    private static final Set<String> PAINTING = Set.of("S", "s", "f", "F", "f*", "B", "B*", "b", "b*");

    /** Write the changed form of one operator; false keeps it as it was. */
    private static boolean apply(PDDocument doc, Operator op, List<Object> operands, OpEdit edit,
                                 PDResources resources, List<Object> out, Result result) throws IOException {
        String name = op.getName();
        if (edit.unpaint && PAINTING.contains(name)) {
            result.paths++;
            out.add(Operator.getOperator("n"));
            return true;
        }
        if (edit.form != null && "Do".equals(name)) {
            out.add(resources.add(edit.form));
            out.add(Operator.getOperator("Do"));
            return true;
        }
        if (edit.image != null && ("Do".equals(name) || "BI".equals(name))) {
            PDImageXObject painted = paint(doc, edit.image, edit.imageRects, result);
            if (painted == null) {
                return false;
            }
            result.images++;
            out.add(resources.add(painted));
            out.add(Operator.getOperator("Do"));
            return true;
        }
        if (edit.removed.isEmpty() || edit.font == null) {
            return false;
        }
        int[] counter = {0};
        COSArray shown = new COSArray();
        switch (name) {
            case "Tj", "'", "\"" -> {
                if (operands.isEmpty() || !(operands.get(operands.size() - 1) instanceof COSString s)) {
                    return false;
                }
                cut(s.getBytes(), edit, counter, shown, result);
                if ("\"".equals(name)) {
                    if (operands.size() < 3) {
                        return false;
                    }
                    out.add(operands.get(0));
                    out.add(Operator.getOperator("Tw"));
                    out.add(operands.get(1));
                    out.add(Operator.getOperator("Tc"));
                }
                if (!"Tj".equals(name)) {
                    out.add(Operator.getOperator("T*"));
                }
            }
            case "TJ" -> {
                if (operands.isEmpty() || !(operands.get(operands.size() - 1) instanceof COSArray array)) {
                    return false;
                }
                for (COSBase item : array) {
                    COSBase value = item instanceof COSObject ref ? ref.getObject() : item;
                    if (value instanceof COSString s) {
                        cut(s.getBytes(), edit, counter, shown, result);
                    } else if (value instanceof COSNumber) {
                        shown.add(value);
                    }
                }
            }
            default -> {
                return false;
            }
        }
        out.add(shown);
        out.add(Operator.getOperator("TJ"));
        return true;
    }

    /** Copy the codes of a string into a TJ array, a gap in place of each removed glyph. */
    private static void cut(byte[] bytes, OpEdit edit, int[] counter, COSArray target, Result result)
            throws IOException {
        ByteArrayInputStream in = new ByteArrayInputStream(bytes);
        ByteArrayOutputStream run = new ByteArrayOutputStream();
        while (in.available() > 0) {
            int start = bytes.length - in.available();
            edit.font.readCode(in);
            int end = bytes.length - in.available();
            Float gap = edit.removed.get(counter[0]++);
            if (gap == null) {
                run.write(bytes, start, end - start);
            } else {
                if (run.size() > 0) {
                    target.add(new COSString(run.toByteArray()));
                    run.reset();
                }
                target.add(new COSFloat(gap));
                result.glyphs++;
            }
        }
        if (run.size() > 0) {
            target.add(new COSString(run.toByteArray()));
        }
    }

    /** A copy of the image with the rectangles (unit square, y up) painted white. */
    private static PDImageXObject paint(PDDocument doc, PDImage image, List<float[]> rects, Result result)
            throws IOException {
        if (image.isStencil()) {
            // a stencil mask paints the fill colour through its pixels; not handled
            result.notErased.add("image mask");
            return null;
        }
        BufferedImage source = image.getImage();
        if (source == null) {
            result.notErased.add("image");
            return null;
        }
        int w = source.getWidth();
        int h = source.getHeight();
        boolean alpha = source.getColorModel().hasAlpha();
        BufferedImage copy = new BufferedImage(w, h, alpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
        Graphics2D g = copy.createGraphics();
        g.drawImage(source, 0, 0, null);
        g.setColor(Color.WHITE);
        for (float[] r : rects) {
            int x0 = (int) Math.floor(r[0] * w);
            int x1 = (int) Math.ceil(r[2] * w);
            int y0 = (int) Math.floor((1f - r[3]) * h);
            int y1 = (int) Math.ceil((1f - r[1]) * h);
            g.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        }
        g.dispose();

        String space = image.getColorSpace() != null ? image.getColorSpace().getName() : "";
        boolean bilevel = image.getBitsPerComponent() == 1 && !alpha
                && ("DeviceGray".equals(space) || "CalGray".equals(space));
        if (bilevel) {
            BufferedImage bw = new BufferedImage(w, h, BufferedImage.TYPE_BYTE_BINARY);
            Graphics2D g2 = bw.createGraphics();
            g2.drawImage(copy, 0, 0, null);
            g2.dispose();
            return CCITTFactory.createFromImage(doc, bw);
        }
        boolean jpeg = image instanceof PDImageXObject x && "jpg".equals(x.getSuffix());
        if (jpeg && !alpha) {
            return JPEGFactory.createFromImage(doc, copy, 0.9f);
        }
        return LosslessFactory.createFromImage(doc, copy);
    }

    /**
     * Remove annotations whose middle lies in a rectangle (not form fields or
     * links); for a redaction every annotation that touches one.
     */
    private static int removeAnnotations(PDPage page, List<PDRectangle> rects, Options options) throws IOException {
        List<PDAnnotation> annotations = page.getAnnotations();
        List<PDAnnotation> keep = new ArrayList<>();
        Set<COSDictionary> popups = new java.util.HashSet<>();
        int removed = 0;
        for (PDAnnotation a : annotations) {
            String type = a.getSubtype();
            PDRectangle r = a.getRectangle();
            boolean skip = "Popup".equals(type) || r == null
                    || !options.strict() && ("Widget".equals(type) || "Link".equals(type));
            float mx = skip ? 0 : (r.getLowerLeftX() + r.getUpperRightX()) / 2f;
            float my = skip ? 0 : (r.getLowerLeftY() + r.getUpperRightY()) / 2f;
            boolean hit = false;
            for (PDRectangle c : rects) {
                if (skip) {
                    break;
                }
                if (options.strict()
                        ? r.getLowerLeftX() < c.getUpperRightX() && r.getUpperRightX() > c.getLowerLeftX()
                            && r.getLowerLeftY() < c.getUpperRightY() && r.getUpperRightY() > c.getLowerLeftY()
                        : c.contains(mx, my)) {
                    hit = true;
                }
            }
            if (hit) {
                removed++;
                COSDictionary popup = a.getCOSObject().getCOSDictionary(COSName.getPDFName("Popup"));
                if (popup != null) {
                    popups.add(popup);
                }
            } else {
                keep.add(a);
            }
        }
        if (removed > 0) {
            keep.removeIf(a -> popups.contains(a.getCOSObject()));
            page.setAnnotations(keep);
        }
        return removed;
    }

    // ------------------------------------------------------------------ resources

    /**
     * The page's own resource dictionary, to add names to. Resources that are
     * inherited or shared with other pages (an indirect object) are copied
     * first, so other pages do not see the new names.
     */
    static COSDictionary ownResources(PDPage page) {
        COSDictionary pageDict = page.getCOSObject();
        COSBase item = pageDict.getItem(COSName.RESOURCES);
        if (item instanceof COSDictionary direct) {
            return direct;
        }
        PDResources inherited = page.getResources();
        COSDictionary copy = inherited != null ? copyDict(inherited.getCOSObject()) : new COSDictionary();
        pageDict.setItem(COSName.RESOURCES, copy);
        return copy;
    }

    /** Make a sub-dictionary (XObject, Font, ...) of resources a direct copy of its own. */
    static COSDictionary ownSubDict(COSDictionary resources, COSName key) {
        COSBase item = resources.getItem(key);
        if (item instanceof COSDictionary direct) {
            return direct;
        }
        COSBase value = resources.getDictionaryObject(key);
        COSDictionary copy = value instanceof COSDictionary d ? copyDict(d) : new COSDictionary();
        resources.setItem(key, copy);
        return copy;
    }

    /** A shallow copy: the same values (references stay references). */
    static COSDictionary copyDict(COSDictionary source) {
        COSDictionary copy = new COSDictionary();
        for (Map.Entry<COSName, COSBase> e : source.entrySet()) {
            copy.setItem(e.getKey(), e.getValue());
        }
        return copy;
    }
}
