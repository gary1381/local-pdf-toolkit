package com.pdfgateway;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.http.Context;
import io.javalin.http.UploadedFile;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSDocument;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSObject;
import org.apache.pdfbox.cos.COSObjectKey;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineNode;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDChoice;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
import org.apache.pdfbox.pdmodel.interactive.form.PDNonTerminalField;
import org.apache.pdfbox.pdmodel.interactive.form.PDSignatureField;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Redaction that removes content. For every page with a matched term or a
 * given region, the page dictionary itself is rewritten (not replaced, so
 * nothing else in the file keeps the old page alive) to a single image of the
 * page with black boxes burnt in. Interactive and hidden content that could
 * carry the terms is removed: form fields (signed or not) after flattening,
 * matching annotations with their popups and replies, the structure tree,
 * embedded files, document JavaScript, matching metadata and bookmark titles.
 * Finally the saved file is checked twice: the page text is searched again,
 * and every object in the file (decompressed) is scanned for the terms.
 *
 * Coordinates: points on the displayed page, origin top-left (see AgentTools).
 * Pages that are not rebuilt get their own resources, pruned to what they draw,
 * so nothing a rebuilt page used survives through shared resources.
 *
 * Response: see {@link #writeResult}.
 */
final class Redactor {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int MAX_REGIONS = 2000;
    private static final int MAX_TERMS = 200;
    private static final long RAW_SCAN_LIMIT = 300L * 1024 * 1024;
    private static final COSName[] PAGE_KEYS_TO_DROP = {
        COSName.ANNOTS, COSName.STRUCT_PARENTS, COSName.getPDFName("Thumb"), COSName.getPDFName("PieceInfo"),
        COSName.getPDFName("B"), COSName.METADATA, COSName.AA, COSName.getPDFName("VP"), COSName.ID,
        COSName.getPDFName("PZ"), COSName.getPDFName("SeparationInfo"), COSName.GROUP, COSName.BLEED_BOX,
        COSName.TRIM_BOX, COSName.ART_BOX, COSName.getPDFName("BoxColorInfo"), COSName.getPDFName("UserUnit"),
        COSName.getPDFName("Tabs"), COSName.getPDFName("TemplateInstantiated"), COSName.getPDFName("PresSteps"),
        COSName.getPDFName("DPart"), COSName.getPDFName("AF"), COSName.getPDFName("OutputIntents"),
    };

    private Redactor() {}

    record Region(int pageIndex, float x, float y, float w, float h) {}

    record Box(float x, float y, float w, float h) {}

    static void redact(Context ctx) throws IOException {
        UploadedFile upload = ctx.uploadedFile("file");
        if (upload == null) {
            ctx.status(400).result("Missing file field");
            return;
        }
        byte[] bytes = upload.content().readAllBytes();
        List<String> terms = new ArrayList<>();
        List<Map<String, Object>> rawRegions;
        try {
            String t = ctx.formParam("terms");
            if (t != null && !t.isBlank()) {
                for (String s : MAPPER.readValue(t, new TypeReference<List<String>>() {})) {
                    if (s != null && !s.isBlank()) {
                        terms.add(s);
                    }
                }
            }
            String r = ctx.formParam("regions");
            rawRegions = r == null || r.isBlank() ? List.of()
                    : MAPPER.readValue(r, new TypeReference<List<Map<String, Object>>>() {});
        } catch (IOException exc) {
            user(ctx, "terms must be a JSON array of strings and regions a JSON array of {page, x, y, width, height}");
            return;
        }
        if (terms.isEmpty() && rawRegions.isEmpty()) {
            user(ctx, "Give search terms or regions to redact");
            return;
        }
        if (terms.size() > MAX_TERMS || rawRegions.size() > MAX_REGIONS) {
            user(ctx, "Too many terms or regions (limits: " + MAX_TERMS + " terms, " + MAX_REGIONS + " regions)");
            return;
        }
        boolean caseSensitive = "1".equals(ctx.formParam("caseSensitive"));
        boolean removeMetadata = "1".equals(ctx.formParam("removeMetadata"));
        // keepText=0: rebuild every page with marks as a picture (the old behaviour)
        boolean keepText = !"0".equals(ctx.formParam("keepText"));
        float dpi = AgentTools.PdfboxServerAccess.clampDpi(ctx.formParam("dpi"));
        boolean lossless = "lossless".equals(ctx.formParam("imageFormat"));
        String password = ctx.formParam("password");

        try (PDDocument doc = password != null && !password.isBlank()
                ? Loader.loadPDF(bytes, password) : Loader.loadPDF(bytes)) {
            int pageCount = doc.getNumberOfPages();
            List<Region> regions = new ArrayList<>();
            for (Map<String, Object> r : rawRegions) {
                int page = num(r.get("page"), -1).intValue();
                float w = num(r.get("width"), 0).floatValue();
                float h = num(r.get("height"), 0).floatValue();
                if (page < 1 || page > pageCount) {
                    user(ctx, "Region page " + page + " is outside the document (1-" + pageCount + ")");
                    return;
                }
                if (w <= 0 || h <= 0) {
                    user(ctx, "Region width and height must be greater than 0");
                    return;
                }
                regions.add(new Region(page - 1, num(r.get("x"), 0).floatValue(), num(r.get("y"), 0).floatValue(), w, h));
            }
            Map<String, Object> report = new LinkedHashMap<>();
            List<String> removed = new ArrayList<>();
            boolean wasEncrypted = doc.isEncrypted();
            if (wasEncrypted) {
                doc.setAllSecurityToBeRemoved(true);
            }
            report.put("encryptionRemoved", wasEncrypted);

            // 1. Forms: values become page content, then the form goes (signed or not:
            //    redaction changes the file, so signatures could not stay valid anyway).
            int[] formCounts = removeForm(doc);
            if (formCounts[0] > 0) {
                removed.add(formCounts[0] + " form field(s), flattened into the page");
            }
            if (formCounts[1] > 0) {
                removed.add(formCounts[1] + " digital signature(s) (redaction invalidates them)");
            }
            if (formCounts[2] > 0) {
                removed.add(formCounts[2] + " form field value(s) not shown on the page (hidden or without an appearance), removed");
            }

            // 2. Where the terms are.
            List<Integer> all = AgentTools.parsePages("", pageCount);
            Map<Integer, List<Box>> boxes = new TreeMap<>();
            Map<Integer, List<Box>> exact = new TreeMap<>(); // the words themselves: which characters go
            Map<String, Integer> termCounts = new LinkedHashMap<>();
            for (String t : terms) {
                termCounts.put(t, 0);
            }
            if (!terms.isEmpty()) {
                for (AgentTools.Match m : AgentTools.find(doc, terms, caseSensitive, all, true)) {
                    termCounts.merge(m.term(), 1, Integer::sum);
                    for (AgentTools.Box b : m.boxes()) {
                        exact.computeIfAbsent(m.pageIndex(), k -> new ArrayList<>()).add(new Box(b.x(), b.y(), b.w(), b.h()));
                        float px = m.ocrText() ? Math.max(4f, b.h() * 0.45f) : 1.5f;
                        float py = m.ocrText() ? Math.max(2f, b.h() * 0.2f) : 1.5f;
                        boxes.computeIfAbsent(m.pageIndex(), k -> new ArrayList<>())
                                .add(new Box(b.x() - px, b.y() - py, b.w() + 2 * px, b.h() + 2 * py));
                    }
                }
            }
            for (Region r : regions) {
                boxes.computeIfAbsent(r.pageIndex(), k -> new ArrayList<>()).add(new Box(r.x(), r.y(), r.w(), r.h()));
                exact.computeIfAbsent(r.pageIndex(), k -> new ArrayList<>()).add(new Box(r.x(), r.y(), r.w(), r.h()));
            }
            List<String> notFound = new ArrayList<>();
            termCounts.forEach((t, n) -> {
                if (n == 0) {
                    notFound.add(t);
                }
            });

            // 3. Annotations carrying a term go, with their popups and replies (before
            //    rendering, so they are not drawn into rebuilt pages either).
            if (!terms.isEmpty()) {
                int n = cleanAnnotations(doc, Set.of(), terms, caseSensitive, null);
                if (n > 0) {
                    removed.add(n + " annotation(s) mentioning a term or holding an attachment");
                }
            }

            // 4. Document-level places text can hide.
            removed.addAll(cleanDocument(doc, terms, caseSensitive, removeMetadata, !boxes.isEmpty()));

            // 5a. Take what is marked out of the page content, keeping the page as text: the
            //     characters touching a box, image pixels under it, shapes mostly inside it,
            //     annotations touching it. Then check: no character may be found there any more.
            //     A page where that cannot be done or checked is rebuilt as a picture (5b).
            Map<Integer, String> pictureBecause = new TreeMap<>();
            Set<Integer> asText = new java.util.TreeSet<>();
            RegionEraser.Result erased = new RegionEraser.Result();
            for (Map.Entry<Integer, List<Box>> entry : boxes.entrySet()) {
                int index = entry.getKey();
                if (!keepText) {
                    pictureBecause.put(index, "asked for");
                    continue;
                }
                PDPage page = doc.getPage(index);
                String blocker = keepTextBlocker(page);
                if (blocker != null) {
                    pictureBecause.put(index, blocker);
                    continue;
                }
                PdfboxServer.PageSpace space = new PdfboxServer.PageSpace(page);
                List<PDRectangle> rects = new ArrayList<>();
                for (Box b : entry.getValue()) {
                    rects.add(space.userRect(b.x(), b.y(), b.w(), b.h()));
                }
                List<PDRectangle> glyphRects = new ArrayList<>();
                for (Box b : exact.getOrDefault(index, List.of())) {
                    glyphRects.add(space.userRect(b.x(), b.y(), b.w(), b.h()));
                }
                try {
                    RegionEraser.Result r = RegionEraser.erase(doc, page, rects, glyphRects, RegionEraser.Options.REDACT);
                    if (r.textLeft > 0) {
                        pictureBecause.put(index, "text that could not be taken out");
                    } else if (!r.notErased.isEmpty()) {
                        pictureBecause.put(index, String.join(", ", r.notErased) + " that could not be cleaned");
                    } else {
                        blackBoxes(doc, page, space, entry.getValue());
                        asText.add(index);
                        erased.add(r);
                    }
                } catch (IOException | RuntimeException exc) {
                    pictureBecause.put(index, "content that could not be read");
                }
            }
            if (erased.annotations > 0) {
                removed.add(erased.annotations + " annotation(s) over the redacted areas");
            }

            // 5b. Rebuild the other pages in place as a picture with the boxes burnt in.
            PDFRenderer renderer = new PDFRenderer(doc);
            // Annotations are not drawn into rebuilt pages: their text may not be readable to the
            // search (embedded fonts), so it cannot be checked. Visible ones were flattened into the
            // page by the gateway before the search, where the search can read them.
            renderer.setAnnotationsFilter(a -> false);
            int droppedAnnots = 0;
            for (int i : pictureBecause.keySet()) {
                droppedAnnots += doc.getPage(i).getAnnotations().size();
            }
            if (droppedAnnots > 0) {
                removed.add(droppedAnnots + " annotation(s) on pages rebuilt as pictures");
            }
            List<Map<String, Object>> pageReport = new ArrayList<>();
            for (Map.Entry<Integer, List<Box>> entry : boxes.entrySet()) {
                int index = entry.getKey();
                if (asText.contains(index)) {
                    Map<String, Object> p = new LinkedHashMap<>();
                    p.put("page", index + 1);
                    p.put("boxes", entry.getValue().size());
                    p.put("method", "text");
                    pageReport.add(p);
                    continue;
                }
                PDPage page = doc.getPage(index);
                PdfboxServer.PageSpace space = new PdfboxServer.PageSpace(page);
                BufferedImage img = renderer.renderImageWithDPI(index, dpi, ImageType.RGB);
                float sx = img.getWidth() / space.vw;
                float sy = img.getHeight() / space.vh;
                Graphics2D g = img.createGraphics();
                g.setColor(Color.BLACK);
                for (Box b : entry.getValue()) {
                    g.fillRect((int) Math.floor(b.x() * sx), (int) Math.floor(b.y() * sy),
                            (int) Math.ceil(b.w() * sx) + 1, (int) Math.ceil(b.h() * sy) + 1);
                }
                g.dispose();
                rewritePage(doc, page, img, space.vw, space.vh, lossless);
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("page", index + 1);
                p.put("boxes", entry.getValue().size());
                p.put("method", "picture");
                p.put("pictureBecause", pictureBecause.get(index));
                pageReport.add(p);
            }

            if (!boxes.isEmpty()) {
                // replies and popups elsewhere that point at a removed annotation would keep it
                int orphans = cleanAnnotations(doc, pictureBecause.keySet(), List.of(), caseSensitive, null);
                if (orphans > 0) {
                    removed.add(orphans + " reply or popup annotation(s) belonging to removed annotations");
                }
                // Nothing a rebuilt page used may survive through another page; pages kept as text
                // keep only the names their content still uses (not the images and forms replaced
                // by cleaned copies).
                pruneResources(doc, pictureBecause.keySet());
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            doc.save(out);
            byte[] result = out.toByteArray();

            // Pages that show pictures but were not rebuilt: words inside those pictures
            // are only searchable if they were OCR'd.
            List<Integer> pictures = new ArrayList<>();
            for (int i = 0; i < pageCount && !terms.isEmpty(); i++) {
                if (!boxes.containsKey(i) && drawsImages(doc.getPage(i))) {
                    pictures.add(i + 1);
                }
            }

            Map<String, Object> check = verify(result, terms, caseSensitive);
            report.put("redactedPages", pageReport);
            report.put("pagesKeptAsText", asText.size());
            report.put("charactersRemoved", erased.glyphs);
            report.put("termMatches", termCounts);
            if (!notFound.isEmpty()) {
                report.put("termsNotFound", notFound);
            }
            report.put("regions", regions.size());
            report.put("alsoRemoved", removed);
            if (!pictures.isEmpty()) {
                report.put("otherPagesWithPictures", compact(pictures));
            }
            report.putAll(check);
            report.put("dpi", dpi);
            writeResult(ctx, report, result);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to redact: " + exc.getMessage());
        }
    }

    // ------------------------------------------------------------------ verification

    /** POST file + terms (JSON array) [+ caseSensitive=1]: the same checks as at the end of redact. */
    static void verifyEndpoint(Context ctx) throws IOException {
        UploadedFile upload = ctx.uploadedFile("file");
        if (upload == null) {
            ctx.status(400).result("Missing file field");
            return;
        }
        List<String> terms;
        try {
            String t = ctx.formParam("terms");
            terms = t == null || t.isBlank() ? List.of() : MAPPER.readValue(t, new TypeReference<List<String>>() {});
        } catch (IOException exc) {
            user(ctx, "terms must be a JSON array of strings");
            return;
        }
        try {
            ctx.json(verify(upload.content().readAllBytes(), terms, "1".equals(ctx.formParam("caseSensitive"))));
        } catch (IOException exc) {
            ctx.status(422).result("Failed to check the file: " + exc.getMessage());
        }
    }

    /**
     * Search the saved file. The page text is searched again (loose), so whatever a
     * reader can see or copy is covered, including text in form XObjects. Then
     * every string in every object (titles, author fields, link addresses,
     * destination names, ...) and every metadata, XML and attachment stream is
     * scanned for the terms. Content streams and fonts are not scanned raw: their
     * bytes are font-encoded, so the text search is the check for them.
     */
    static Map<String, Object> verify(byte[] pdf, List<String> terms, boolean caseSensitive) throws IOException {
        Map<String, Object> out = new LinkedHashMap<>();
        if (terms.isEmpty()) {
            out.put("remainingMatches", 0);
            out.put("rawObjectHits", List.of());
            out.put("verified", true);
            return out;
        }
        int remaining;
        List<String> hits = new ArrayList<>();
        long[] budget = {RAW_SCAN_LIMIT};
        try (PDDocument check = Loader.loadPDF(pdf)) {
            remaining = AgentTools.find(check, terms, caseSensitive,
                    AgentTools.parsePages("", check.getNumberOfPages()), true).size();
            List<String> needles = new ArrayList<>();
            for (String t : terms) {
                String n = norm(t, caseSensitive).strip();
                if (n.codePointCount(0, n.length()) >= 2) {
                    needles.add(n);
                }
            }
            COSDocument cos = check.getDocument();
            for (COSObjectKey key : new ArrayList<>(cos.getXrefTable().keySet())) {
                COSObject obj = cos.getObjectFromPool(key);
                COSBase base = obj == null ? null : obj.getObject();
                if (base != null && scan(base, needles, caseSensitive, budget, new IdentityHashMap<>())) {
                    hits.add("object " + key.getNumber());
                    if (hits.size() >= 20) {
                        break;
                    }
                }
            }
            if (scan(cos.getTrailer(), needles, caseSensitive, budget, new IdentityHashMap<>())) {
                hits.add("trailer");
            }
        }
        boolean complete = budget[0] > 0;
        out.put("remainingMatches", remaining);
        out.put("rawObjectHits", hits);
        out.put("rawScanComplete", complete);
        out.put("verified", remaining == 0 && hits.isEmpty() && complete);
        return out;
    }

    /** True if a term occurs in a string, or in a metadata / XML / attachment stream, inside this object. */
    private static boolean scan(COSBase base, List<String> needles, boolean caseSensitive, long[] budget,
                                IdentityHashMap<COSBase, Boolean> seen) throws IOException {
        if (base == null || needles.isEmpty() || seen.put(base, true) != null || base instanceof COSObject) {
            return false; // referenced objects are scanned on their own
        }
        if (base instanceof COSString s) {
            return hasNeedle(s.getString(), needles, caseSensitive);
        }
        if (base instanceof COSArray arr) {
            for (COSBase b : arr) {
                if (scan(b, needles, caseSensitive, budget, seen)) {
                    return true;
                }
            }
            return false;
        }
        if (base instanceof COSDictionary dict) {
            for (Map.Entry<COSName, COSBase> e : dict.entrySet()) {
                if (scan(e.getValue(), needles, caseSensitive, budget, seen)) {
                    return true;
                }
            }
            COSName type = dict.getCOSName(COSName.TYPE);
            COSName subtype = dict.getCOSName(COSName.SUBTYPE);
            boolean textual = COSName.METADATA.equals(type) || COSName.getPDFName("EmbeddedFile").equals(type)
                    || COSName.getPDFName("XML").equals(subtype);
            if (dict instanceof COSStream stream && textual) {
                if (budget[0] <= 0) {
                    return false;
                }
                byte[] data;
                try (InputStream in = stream.createInputStream()) {
                    data = in.readNBytes((int) Math.min(budget[0], 64L * 1024 * 1024));
                    if (in.read() >= 0) {
                        budget[0] = 0; // larger than we read: the scan is incomplete
                    }
                } catch (IOException exc) {
                    return false;
                }
                budget[0] -= data.length;
                String utf8 = new String(data, StandardCharsets.UTF_8);
                String latin = new String(data, StandardCharsets.ISO_8859_1);
                boolean xml = !COSName.getPDFName("EmbeddedFile").equals(type) || utf8.stripLeading().startsWith("<");
                if (xml) {
                    // metadata and XML: only what the XML says, not its tag names
                    return hasNeedle(xmlText(utf8), needles, caseSensitive)
                            || hasNeedle(xmlText(latin), needles, caseSensitive)
                            || (data.length % 2 == 0 && data.length > 1 && (data[0] == 0 || data[1] == 0
                                    || (data[0] & 0xFF) >= 0xFE)
                                && hasNeedle(xmlText(new String(data, StandardCharsets.UTF_16)), needles, caseSensitive));
                }
                return hasNeedle(utf8, needles, caseSensitive)
                        || hasNeedle(xmlUnescape(utf8), needles, caseSensitive)
                        || hasNeedle(latin, needles, caseSensitive)
                        || (data.length % 2 == 0 && hasNeedle(new String(data, StandardCharsets.UTF_16BE), needles, caseSensitive));
            }
        }
        return false;
    }

    /** Whitespace runs folded to one space, optionally lower-cased (word boundaries stay). */
    private static String norm(String s, boolean caseSensitive) {
        String t = s.replaceAll("[\\s\\u00a0\\u00ad]+", " ");
        return caseSensitive ? t : t.toLowerCase(java.util.Locale.ROOT);
    }

    private static boolean hasNeedle(String text, List<String> needles, boolean caseSensitive) {
        if (text == null || text.isEmpty()) {
            return false;
        }
        String hay = norm(text, caseSensitive);
        for (String n : needles) {
            // Short terms ("JS", "Bob") must stand as a word, or ids, hashes and
            // binary strings would match them by chance. Longer terms count anywhere.
            boolean word = n.codePointCount(0, n.length()) <= 3;
            for (int at = hay.indexOf(n); at >= 0; at = hay.indexOf(n, at + 1)) {
                int end = at + n.length();
                if (!word || ((at == 0 || !AgentTools.joins(hay.charAt(at - 1), hay.charAt(at)))
                        && (end >= hay.length() || !AgentTools.joins(hay.charAt(end - 1), hay.charAt(end))))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static final java.util.regex.Pattern ATTR_NAME = java.util.regex.Pattern.compile("([\\w:.-]+)\\s*=\\s*$");

    /**
     * The text an XML document carries: element text, attribute values, comments,
     * CDATA and processing-instruction bodies, entities decoded. Element and
     * attribute names and namespace URIs are markup, not content, so a term like
     * "rdf", "id" or "Adobe" does not match them.
     */
    static String xmlText(String xml) {
        StringBuilder b = new StringBuilder(xml.length());
        int i = 0;
        int n = xml.length();
        while (i < n) {
            int lt = xml.indexOf('<', i);
            if (lt < 0) {
                b.append(xmlUnescape(xml.substring(i)));
                break;
            }
            b.append(xmlUnescape(xml.substring(i, lt))).append(' ');
            if (xml.startsWith("<!--", lt)) {
                int e = xml.indexOf("-->", lt + 4);
                b.append(xml, lt + 4, e < 0 ? n : e).append(' ');
                i = e < 0 ? n : e + 3;
            } else if (xml.startsWith("<![CDATA[", lt)) {
                int e = xml.indexOf("]]>", lt + 9);
                b.append(xml, lt + 9, e < 0 ? n : e).append(' ');
                i = e < 0 ? n : e + 3;
            } else {
                int e = lt + 1;
                char quote = 0;
                StringBuilder value = null;
                for (; e < n; e++) {
                    char c = xml.charAt(e);
                    if (quote != 0) {
                        if (c == quote) {
                            b.append(xmlUnescape(value.toString())).append(' ');
                            quote = 0;
                        } else {
                            value.append(c);
                        }
                    } else if (c == '"' || c == '\'') {
                        java.util.regex.Matcher name = ATTR_NAME.matcher(xml.substring(Math.max(lt, e - 200), e));
                        if (name.find() && (name.group(1).equals("xmlns") || name.group(1).startsWith("xmlns:"))) {
                            // a namespace URI ("http://ns.adobe.com/xap/1.0/") is markup, not content
                            int close = xml.indexOf(c, e + 1);
                            e = close < 0 ? n - 1 : close;
                            continue;
                        }
                        quote = c;
                        value = new StringBuilder();
                    } else if (c == '>') {
                        break;
                    }
                }
                if (quote != 0) {
                    b.append(xmlUnescape(value.toString())); // unterminated: keep what was there
                }
                if (xml.startsWith("<?", lt)) {
                    // processing instruction bodies that are not attributes (rare) are kept whole
                    int sp = xml.indexOf(' ', lt);
                    if (sp > 0 && sp < e && xml.substring(sp, e).indexOf('=') < 0) {
                        b.append(xml, sp, e).append(' ');
                    }
                }
                i = e + 1;
            }
        }
        return b.toString();
    }

    private static String squeeze(String s, boolean caseSensitive) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (!Character.isWhitespace(c) && c != ' ' && c != '­') {
                b.append(caseSensitive ? c : Character.toLowerCase(c));
            }
        }
        return b.toString();
    }

    private static boolean containsAny(String text, List<String> needles, boolean caseSensitive) {
        if (text == null || text.isEmpty()) {
            return false;
        }
        String hay = squeeze(text, caseSensitive);
        for (String n : needles) {
            if (hay.contains(n)) {
                return true;
            }
        }
        return false;
    }

    /**
     * True if the text mentions a term. Longer terms match ignoring all spaces
     * ("J o h n S m i t h"); terms of up to 3 characters must stand as a word, or
     * ids and names would match them by chance ("Al" in "Alice").
     */
    private static boolean containsAnyTerm(String text, List<String> terms, boolean caseSensitive) {
        if (text == null || text.isEmpty()) {
            return false;
        }
        List<String> loose = new ArrayList<>();
        List<String> words = new ArrayList<>();
        for (String t : terms) {
            String sq = squeeze(t, caseSensitive);
            if (sq.codePointCount(0, sq.length()) <= 3) {
                words.add(norm(t, caseSensitive).strip());
            } else {
                loose.add(sq);
            }
        }
        String unescaped = xmlUnescape(text);
        return containsAny(text, loose, caseSensitive) || containsAny(unescaped, loose, caseSensitive)
                || hasNeedle(text, words, caseSensitive) || hasNeedle(unescaped, words, caseSensitive);
    }

    private static String xmlUnescape(String s) {
        if (s.indexOf('&') < 0) {
            return s;
        }
        StringBuilder b = new StringBuilder();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);").matcher(s);
        int last = 0;
        while (m.find()) {
            b.append(s, last, m.start());
            String e = m.group(1);
            switch (e) {
                case "amp" -> b.append('&');
                case "lt" -> b.append('<');
                case "gt" -> b.append('>');
                case "quot" -> b.append('"');
                case "apos" -> b.append('\'');
                default -> {
                    try {
                        int cp = e.startsWith("#x") || e.startsWith("#X")
                                ? Integer.parseInt(e.substring(2), 16) : Integer.parseInt(e.substring(1));
                        b.appendCodePoint(cp);
                    } catch (IllegalArgumentException exc) {
                        b.append(m.group());
                    }
                }
            }
            last = m.end();
        }
        b.append(s.substring(last));
        return b.toString();
    }

    // ------------------------------------------------------------------ cleaning

    /**
     * Flatten ordinary fields into the page, drop signature widgets, remove the form
     * and the signature validation data. Returns {fields flattened, signatures, fields
     * whose values could not be flattened and were dropped}.
     */
    static int[] removeForm(PDDocument doc) throws IOException {
        PDDocumentCatalog catalog = doc.getDocumentCatalog();
        catalog.getCOSObject().removeItem(COSName.getPDFName("DSS")); // certificates, OCSP, CRLs: names in plain DER
        PDAcroForm form = catalog.getAcroForm();
        if (form == null) {
            return new int[] {0, 0, 0};
        }
        List<PDField> ordinary = new ArrayList<>();
        List<PDSignatureField> signatures = new ArrayList<>();
        for (PDField f : form.getFieldTree()) {
            if (f instanceof PDNonTerminalField) {
                continue;
            }
            if (f instanceof PDSignatureField s) {
                signatures.add(s);
            } else {
                ordinary.add(f);
            }
        }
        form.getCOSObject().removeItem(COSName.getPDFName("XFA"));
        int flattened = 0;
        int dropped = 0;
        if (!ordinary.isEmpty()) {
            try {
                form.setNeedAppearances(false);
                form.refreshAppearances(ordinary);
            } catch (IOException | RuntimeException exc) {
                // keep the appearances the file has
            }
            // A value is only kept (as page content) if some widget shows it: visible, with an appearance.
            List<PDField> shown = new ArrayList<>();
            for (PDField f : ordinary) {
                String value = f instanceof PDChoice c ? String.join(" ", c.getValue()) : f.getValueAsString();
                boolean visible = value == null || value.isBlank();
                for (PDAnnotationWidget w : f.getWidgets()) {
                    if (!w.isHidden() && !w.isInvisible() && !w.isNoView() && w.getNormalAppearanceStream() != null) {
                        visible = true;
                    }
                }
                if (visible) {
                    shown.add(f);
                }
            }
            try {
                form.flatten(ordinary, false);
                flattened = shown.size();
                dropped = ordinary.size() - shown.size();
            } catch (IOException | RuntimeException exc) {
                // flattening failed: the fields are removed below and their values with them
                dropped = ordinary.size();
            }
        }
        // signature boxes: take the widgets off the pages
        Set<COSDictionary> sigWidgets = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
        for (PDSignatureField s : signatures) {
            for (PDAnnotationWidget w : s.getWidgets()) {
                sigWidgets.add(w.getCOSObject());
            }
        }
        // any widget left (signatures, fields that could not be flattened) goes too
        for (PDPage page : doc.getPages()) {
            List<PDAnnotation> keep = new ArrayList<>();
            boolean changed = false;
            for (PDAnnotation a : page.getAnnotations()) {
                if (a instanceof PDAnnotationWidget || sigWidgets.contains(a.getCOSObject())) {
                    changed = true;
                } else {
                    keep.add(a);
                }
            }
            if (changed) {
                page.setAnnotations(keep);
            }
        }
        catalog.setAcroForm(null);
        catalog.getCOSObject().removeItem(COSName.getPDFName("Perms"));
        return new int[] {flattened, signatures.size(), dropped};
    }

    /**
     * Remove annotations that mention a term, then popups and replies whose parent
     * is gone (removed here, flattened earlier, or on a page that is rebuilt):
     * they point at that parent and would keep its text in the file. With terms,
     * file attachment annotations go too (their content cannot be checked).
     * {@code termHits}, if given, receives the number of annotations that
     * actually mentioned a term (not attachments, popups or replies).
     */
    private static int cleanAnnotations(PDDocument doc, Set<Integer> rebuilt, List<String> terms, boolean cs,
                                        int[] termHits) throws IOException {
        Map<Integer, List<PDAnnotation>> pages = new TreeMap<>();
        Set<COSDictionary> present = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
        Set<COSDictionary> drop = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
        for (int i = 0; i < doc.getNumberOfPages(); i++) {
            if (rebuilt.contains(i)) {
                continue; // the page loses all annotations when rebuilt
            }
            List<PDAnnotation> annots = doc.getPage(i).getAnnotations();
            pages.put(i, annots);
            for (PDAnnotation a : annots) {
                COSDictionary d = a.getCOSObject();
                present.add(d);
                if (terms.isEmpty()) {
                    continue;
                }
                if (annotationMentions(d, terms, cs)) {
                    drop.add(d);
                    if (termHits != null) {
                        termHits[0]++;
                    }
                } else if (d.getDictionaryObject(COSName.FS) != null) {
                    drop.add(d); // file attachment: its content cannot be checked, so it goes
                } else if (d.getDictionaryObject(COSName.getPDFName("NM")) instanceof COSString nm
                        && containsAnyTerm(nm.getString(), terms, cs)) {
                    d.removeItem(COSName.getPDFName("NM")); // only the id names the term
                }
            }
        }
        boolean grew = true;
        while (grew) {
            grew = false;
            for (List<PDAnnotation> annots : pages.values()) {
                for (PDAnnotation a : annots) {
                    COSDictionary d = a.getCOSObject();
                    if (drop.contains(d)) {
                        continue;
                    }
                    COSBase parent = COSName.getPDFName("Popup").equals(d.getCOSName(COSName.SUBTYPE))
                            ? d.getDictionaryObject(COSName.PARENT) : null;
                    COSBase irt = d.getDictionaryObject(COSName.getPDFName("IRT"));
                    if ((parent instanceof COSDictionary p && (drop.contains(p) || !present.contains(p)))
                            || (irt instanceof COSDictionary r && (drop.contains(r) || !present.contains(r)))) {
                        drop.add(d);
                        grew = true;
                    }
                }
            }
        }
        int removed = 0;
        for (Map.Entry<Integer, List<PDAnnotation>> e : pages.entrySet()) {
            List<PDAnnotation> keep = new ArrayList<>();
            for (PDAnnotation a : e.getValue()) {
                if (!drop.contains(a.getCOSObject())) {
                    keep.add(a);
                }
            }
            if (keep.size() != e.getValue().size()) {
                removed += e.getValue().size() - keep.size();
                doc.getPage(e.getKey()).setAnnotations(keep);
            }
        }
        // a kept annotation may still point at a removed popup (/Popup): unlink it
        for (List<PDAnnotation> annots : pages.values()) {
            for (PDAnnotation a : annots) {
                COSDictionary d = a.getCOSObject();
                if (!drop.contains(d) && d.getDictionaryObject(COSName.getPDFName("Popup")) instanceof COSDictionary p
                        && (drop.contains(p) || !present.contains(p))) {
                    d.removeItem(COSName.getPDFName("Popup"));
                }
            }
        }
        return removed;
    }

    /** Visible annotations with an appearance: what a flattening step will turn into page content. */
    private static int visibleAnnotations(PDDocument doc) throws IOException {
        int n = 0;
        for (PDPage page : doc.getPages()) {
            for (PDAnnotation a : page.getAnnotations()) {
                if (!(a instanceof PDAnnotationWidget) && !COSName.getPDFName("Popup").equals(a.getCOSObject().getCOSName(COSName.SUBTYPE))
                        && !a.isHidden() && !a.isInvisible() && a.getCOSObject().getDictionaryObject(COSName.AP) != null) {
                    n++;
                }
            }
        }
        return n;
    }

    /**
     * Any text the annotation carries: contents, rich text, author, subject, link target, appearance.
     * (Its /NM is an id: a term there only removes the id, see cleanAnnotations.)
     */
    private static boolean annotationMentions(COSDictionary a, List<String> terms, boolean cs) throws IOException {
        for (String key : List.of("Contents", "RC", "T", "Subj", "TU")) {
            COSBase v = a.getDictionaryObject(COSName.getPDFName(key));
            String s = v instanceof COSString str ? str.getString() : v instanceof COSStream st ? read(st) : null;
            if (containsAnyTerm(s, terms, cs)) {
                return true;
            }
        }
        COSBase action = a.getDictionaryObject(COSName.A);
        if (action instanceof COSDictionary act) {
            COSBase uri = act.getDictionaryObject(COSName.URI);
            if (uri instanceof COSString u && containsAnyTerm(u.getString(), terms, cs)) {
                return true;
            }
        }
        COSBase ap = a.getDictionaryObject(COSName.AP);
        if (ap instanceof COSDictionary apd) {
            for (COSBase state : apd.getValues()) {
                COSBase s = state instanceof COSObject o ? o.getObject() : state;
                if (s instanceof COSStream st && containsAnyTerm(read(st), terms, cs)) {
                    return true;
                }
                if (s instanceof COSDictionary sub) {
                    for (COSBase inner : sub.getValues()) {
                        COSBase in = inner instanceof COSObject o ? o.getObject() : inner;
                        if (in instanceof COSStream st && containsAnyTerm(read(st), terms, cs)) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }

    private static String read(COSStream st) {
        try (InputStream in = st.createInputStream()) {
            return new String(in.readNBytes(4 * 1024 * 1024), StandardCharsets.ISO_8859_1);
        } catch (IOException exc) {
            return null;
        }
    }

    private static List<String> cleanDocument(PDDocument doc, List<String> terms, boolean cs, boolean removeMetadata,
                                              boolean pagesRebuilt) throws IOException {
        List<String> removed = new ArrayList<>();
        PDDocumentCatalog catalog = doc.getDocumentCatalog();
        COSDictionary cat = catalog.getCOSObject();
        // the structure tree holds alt text and copies of text, and points at rebuilt pages
        if (cat.containsKey(COSName.STRUCT_TREE_ROOT) && (pagesRebuilt || !terms.isEmpty())) {
            cat.removeItem(COSName.STRUCT_TREE_ROOT);
            cat.removeItem(COSName.MARK_INFO);
            removed.add("accessibility tags (they repeat the page text)");
        }
        COSBase names = cat.getDictionaryObject(COSName.NAMES);
        if (names instanceof COSDictionary nd) {
            if (nd.containsKey(COSName.EMBEDDED_FILES)) {
                nd.removeItem(COSName.EMBEDDED_FILES);
                removed.add("embedded files");
            }
            if (nd.containsKey(COSName.JAVA_SCRIPT)) {
                nd.removeItem(COSName.JAVA_SCRIPT);
                removed.add("document JavaScript");
            }
        }
        if (cat.containsKey(COSName.AA)) {
            cat.removeItem(COSName.AA);
            removed.add("document actions");
        }
        COSBase open = cat.getDictionaryObject(COSName.OPEN_ACTION);
        if (open instanceof COSDictionary oa && !COSName.getPDFName("GoTo").equals(oa.getCOSName(COSName.S))) {
            cat.removeItem(COSName.OPEN_ACTION);
            removed.add("open action");
        }
        cat.removeItem(COSName.getPDFName("Collection"));
        cat.removeItem(COSName.getPDFName("AF"));
        cat.removeItem(COSName.getPDFName("PieceInfo"));
        if (catalog.getDocumentOutline() != null && !terms.isEmpty()) {
            int n = scrubOutline(catalog.getDocumentOutline(), terms, cs);
            if (n > 0) {
                removed.add(n + " bookmark title(s)");
            }
        }
        PDDocumentInformation info = doc.getDocumentInformation();
        if (removeMetadata) {
            doc.setDocumentInformation(new PDDocumentInformation());
            catalog.setMetadata(null);
            removed.add("all document metadata (requested)");
        } else if (!terms.isEmpty()) {
            if (info != null) {
                for (String key : new ArrayList<>(info.getMetadataKeys())) {
                    if (containsAnyTerm(info.getCustomMetadataValue(key), terms, cs)) {
                        info.getCOSObject().removeItem(COSName.getPDFName(key));
                        removed.add("metadata field " + key);
                    }
                }
            }
            if (catalog.getMetadata() != null) {
                String xmp = new String(catalog.getMetadata().toByteArray(), StandardCharsets.UTF_8);
                if (containsAnyTerm(xmp, terms, cs)) {
                    catalog.setMetadata(null);
                    removed.add("XMP metadata");
                }
            }
        }
        return removed;
    }

    private static int scrubOutline(PDOutlineNode node, List<String> terms, boolean cs) {
        int n = 0;
        for (PDOutlineItem item : node.children()) {
            if (containsAnyTerm(item.getTitle(), terms, cs)) {
                item.setTitle("[redacted]");
                n++;
            }
            COSBase action = item.getCOSObject().getDictionaryObject(COSName.A);
            if (action instanceof COSDictionary act && act.getDictionaryObject(COSName.URI) instanceof COSString u
                    && containsAnyTerm(u.getString(), terms, cs)) {
                item.getCOSObject().removeItem(COSName.A);
                n++;
            }
            n += scrubOutline(item, terms, cs);
        }
        return n;
    }

    // ------------------------------------------------------------------ rebuilding a page

    /** Turn this page object into one image, keeping its identity (links and bookmarks still lead here). */
    /** Black boxes over the redacted areas of a page kept as text (what was there is gone already). */
    private static void blackBoxes(PDDocument doc, PDPage page, PdfboxServer.PageSpace space, List<Box> boxes)
            throws IOException {
        try (PDPageContentStream cs = new PDPageContentStream(doc, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
            cs.transform(space.toUser());
            cs.setNonStrokingColor(0f, 0f, 0f);
            for (Box b : boxes) {
                cs.addRect(b.x(), space.vh - b.y() - b.h(), b.w(), b.h());
            }
            cs.fill();
        }
    }

    /**
     * Why a page cannot be redacted as text, or null. Tiling patterns can draw
     * text and pictures of their own, which the removal does not look into.
     */
    private static String keepTextBlocker(PDPage page) {
        return usesPatterns(page.getCOSObject().getDictionaryObject(COSName.RESOURCES),
                new IdentityHashMap<>()) ? "patterns" : null;
    }

    private static boolean usesPatterns(COSBase resources, IdentityHashMap<COSBase, Boolean> seen) {
        if (!(resources instanceof COSDictionary res) || seen.put(res, true) != null) {
            return false;
        }
        if (res.getDictionaryObject(COSName.PATTERN) instanceof COSDictionary patterns && patterns.size() > 0) {
            return true;
        }
        if (res.getDictionaryObject(COSName.XOBJECT) instanceof COSDictionary xobjects) {
            for (COSName name : xobjects.keySet()) {
                if (xobjects.getDictionaryObject(name) instanceof COSStream x
                        && usesPatterns(x.getDictionaryObject(COSName.RESOURCES), seen)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static void rewritePage(PDDocument doc, PDPage page, BufferedImage img, float w, float h,
                                    boolean lossless) throws IOException {
        PDImageXObject picture = lossless ? LosslessFactory.createFromImage(doc, img)
                : JPEGFactory.createFromImage(doc, img, 0.9f);
        COSDictionary d = page.getCOSObject();
        for (COSName key : PAGE_KEYS_TO_DROP) {
            d.removeItem(key);
        }
        d.removeItem(COSName.CONTENTS);
        page.setResources(new PDResources());
        PDRectangle box = new PDRectangle(w, h);
        page.setMediaBox(box);
        page.setCropBox(box);
        page.setRotation(0);
        try (PDPageContentStream cs = new PDPageContentStream(doc, page, PDPageContentStream.AppendMode.OVERWRITE, true)) {
            cs.drawImage(picture, 0, 0, w, h);
        }
    }

    private static final COSName[] RESOURCE_KINDS = {
        COSName.FONT, COSName.XOBJECT, COSName.EXT_G_STATE, COSName.COLORSPACE, COSName.PATTERN,
        COSName.SHADING, COSName.PROPERTIES,
    };

    /**
     * Give every page that was not rebuilt its own resources, cut down to the names
     * its content actually uses, and do the same inside the form XObjects, tiling
     * patterns, Type 3 fonts, soft masks and annotation appearances it keeps.
     * Resources are often shared between pages (or inherited from the page tree);
     * without this, the images and forms a rebuilt page used would stay in the file
     * through a page that still lists them, even though nothing draws them.
     * Existing dictionaries are never changed, only replaced, so nothing outside
     * this page sees a difference. A content stream that cannot be parsed fails
     * the redaction (what it uses is unknown).
     */
    private static void pruneResources(PDDocument doc, Set<Integer> rebuilt) throws IOException {
        IdentityHashMap<COSBase, Boolean> done = new IdentityHashMap<>();
        for (int i = 0; i < doc.getNumberOfPages(); i++) {
            if (rebuilt.contains(i)) {
                continue;
            }
            PDPage page = doc.getPage(i);
            PDResources res = page.getResources(); // its own or inherited
            List<byte[]> contents = new ArrayList<>();
            try (InputStream in = page.getContents()) {
                contents.add(in == null ? new byte[0] : in.readAllBytes());
            }
            List<COSStream> appearances = new ArrayList<>();
            for (PDAnnotation a : page.getAnnotations()) {
                collectAppearances(a.getCOSObject().getDictionaryObject(COSName.AP), appearances);
            }
            for (COSStream ap : appearances) {
                if (!(ap.getDictionaryObject(COSName.RESOURCES) instanceof COSDictionary)) {
                    contents.add(bytes(ap)); // an appearance without resources uses the page's
                }
            }
            String where = "page " + (i + 1);
            page.getCOSObject().setItem(COSName.RESOURCES,
                    prune(res == null ? null : res.getCOSObject(), contents, done, where));
            for (COSStream ap : appearances) {
                pruneNested(ap, done, where);
            }
        }
        stripInherited((COSDictionary) doc.getPages().getCOSObject(), new IdentityHashMap<>());
    }

    private static void collectAppearances(COSBase ap, List<COSStream> out) {
        if (ap instanceof COSObject o) {
            ap = o.getObject();
        }
        if (ap instanceof COSStream s) {
            out.add(s);
        } else if (ap instanceof COSDictionary d) {
            for (COSBase v : d.getValues()) { // N / R / D, or appearance states
                COSBase x = v instanceof COSObject o ? o.getObject() : v;
                if (x instanceof COSStream s) {
                    out.add(s);
                } else if (x instanceof COSDictionary sub) {
                    collectAppearances(sub, out);
                }
            }
        }
    }

    /** A new resources dictionary holding only what {@code contents} name, with nested resources pruned too. */
    private static COSDictionary prune(COSDictionary res, List<byte[]> contents, IdentityHashMap<COSBase, Boolean> done,
                                       String where) throws IOException {
        COSDictionary out = new COSDictionary();
        if (res == null) {
            return out;
        }
        Set<COSName> used = new java.util.HashSet<>();
        for (byte[] c : contents) {
            collectNames(c, used, where);
        }
        // forms, tiling patterns and Type 3 fonts with no resources of their own use these ones
        Set<COSBase> inheriting = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
        boolean grew = true;
        while (grew) {
            grew = false;
            for (COSName kind : new COSName[] {COSName.XOBJECT, COSName.PATTERN, COSName.FONT}) {
                COSDictionary sub = res.getCOSDictionary(kind);
                if (sub == null) {
                    continue;
                }
                for (COSName name : new ArrayList<>(sub.keySet())) {
                    if (!used.contains(name)) {
                        continue;
                    }
                    COSBase v = sub.getDictionaryObject(name);
                    if (v instanceof COSDictionary d && !(d.getDictionaryObject(COSName.RESOURCES) instanceof COSDictionary)
                            && inheriting.add(d)) {
                        for (byte[] c : ownContents(d)) {
                            collectNames(c, used, where);
                        }
                        grew = true;
                    }
                }
            }
        }
        COSBase procSet = res.getItem(COSName.PROC_SET);
        if (procSet != null) {
            out.setItem(COSName.PROC_SET, procSet);
        }
        for (COSName kind : RESOURCE_KINDS) {
            COSDictionary sub = res.getCOSDictionary(kind);
            if (sub == null) {
                continue;
            }
            COSDictionary keep = new COSDictionary();
            for (Map.Entry<COSName, COSBase> e : sub.entrySet()) {
                if (used.contains(e.getKey())) {
                    keep.setItem(e.getKey(), e.getValue()); // the reference itself, not a copy
                    pruneNested(e.getValue(), done, where);
                }
            }
            if (keep.size() > 0) {
                out.setItem(kind, keep);
            }
        }
        return out;
    }

    /** Prune the resources inside a form, tiling pattern, Type 3 font or graphics state (its soft mask). */
    private static void pruneNested(COSBase value, IdentityHashMap<COSBase, Boolean> done, String where)
            throws IOException {
        COSBase v = value instanceof COSObject o ? o.getObject() : value;
        if (!(v instanceof COSDictionary d) || done.put(d, true) != null) {
            return;
        }
        COSBase smask = d.getDictionaryObject(COSName.SMASK);
        if (smask instanceof COSDictionary sm) {
            pruneNested(sm.getItem(COSName.G), done, where); // soft mask group: a form
        }
        if (d.getDictionaryObject(COSName.RESOURCES) instanceof COSDictionary own) {
            List<byte[]> contents = ownContents(d);
            if (!contents.isEmpty()) {
                d.setItem(COSName.RESOURCES, prune(own, contents, done, where));
            }
        }
    }

    /** The content streams of a form or tiling pattern (itself) or of a Type 3 font (its glyph procedures). */
    private static List<byte[]> ownContents(COSDictionary d) throws IOException {
        List<byte[]> out = new ArrayList<>();
        if (d instanceof COSStream s && (COSName.FORM.equals(d.getCOSName(COSName.SUBTYPE))
                || d.getInt(COSName.PATTERN_TYPE) == 1)) {
            out.add(bytes(s));
        } else if (COSName.getPDFName("Type3").equals(d.getCOSName(COSName.SUBTYPE))
                && d.getDictionaryObject(COSName.CHAR_PROCS) instanceof COSDictionary procs) {
            for (COSBase p : procs.getValues()) {
                COSBase x = p instanceof COSObject o ? o.getObject() : p;
                if (x instanceof COSStream s) {
                    out.add(bytes(s));
                }
            }
        }
        return out;
    }

    private static byte[] bytes(COSStream s) throws IOException {
        try (InputStream in = s.createInputStream()) {
            return in.readAllBytes();
        }
    }

    /** Every name operand in a content stream (and in inline image dictionaries): a superset of the resources used. */
    private static void collectNames(byte[] content, Set<COSName> used, String where) throws IOException {
        if (content.length == 0) {
            return;
        }
        try {
            org.apache.pdfbox.pdfparser.PDFStreamParser parser = new org.apache.pdfbox.pdfparser.PDFStreamParser(content);
            for (Object tok = parser.parseNextToken(); tok != null; tok = parser.parseNextToken()) {
                if (tok instanceof org.apache.pdfbox.contentstream.operator.Operator op) {
                    if (op.getImageParameters() != null) {
                        namesIn(op.getImageParameters(), used);
                    }
                } else if (tok instanceof COSBase b) {
                    namesIn(b, used);
                }
            }
        } catch (IOException | RuntimeException exc) {
            throw new IOException("could not read the content of " + where
                    + " to check which resources it uses; the file was not redacted", exc);
        }
    }

    private static void namesIn(COSBase b, Set<COSName> used) {
        if (b instanceof COSName n) {
            used.add(n);
        } else if (b instanceof COSArray arr) {
            for (COSBase x : arr) {
                namesIn(x, used);
            }
        } else if (b instanceof COSDictionary d && !(b instanceof COSStream)) {
            for (COSBase x : d.getValues()) {
                namesIn(x, used);
            }
        }
    }

    private static void stripInherited(COSDictionary node, IdentityHashMap<COSDictionary, Boolean> seen) {
        if (seen.put(node, true) != null) {
            return;
        }
        if (COSName.PAGES.equals(node.getCOSName(COSName.TYPE))) {
            node.removeItem(COSName.RESOURCES);
            COSBase kids = node.getDictionaryObject(COSName.KIDS);
            if (kids instanceof COSArray arr) {
                for (COSBase k : arr) {
                    COSBase kid = k instanceof COSObject o ? o.getObject() : k;
                    if (kid instanceof COSDictionary d) {
                        stripInherited(d, seen);
                    }
                }
            }
        }
    }

    /**
     * Response: "PDFREDACT1 <n>\n", then n bytes of JSON report, then the PDF.
     * (A header would overflow for long reports; base64 JSON would triple memory.)
     */
    private static void writeResult(Context ctx, Map<String, Object> report, byte[] pdf) throws IOException {
        byte[] json = MAPPER.writeValueAsBytes(report);
        byte[] head = ("PDFREDACT1 " + json.length + "\n").getBytes(StandardCharsets.US_ASCII);
        ByteArrayOutputStream body = new ByteArrayOutputStream(head.length + json.length + pdf.length);
        body.write(head);
        body.write(json);
        body.write(pdf);
        ctx.contentType("application/x-pdf-redaction");
        ctx.result(body.toByteArray());
    }

    /**
     * Step before OCR and the search: flatten form fields into the page, remove the
     * form, signatures and their validation data (OCR refuses signed files).
     */
    static void prepare(Context ctx) throws IOException {
        UploadedFile upload = ctx.uploadedFile("file");
        if (upload == null) {
            ctx.status(400).result("Missing file field");
            return;
        }
        String password = ctx.formParam("password");
        List<String> terms = new ArrayList<>();
        try {
            String t = ctx.formParam("terms");
            if (t != null && !t.isBlank()) {
                for (String s : MAPPER.readValue(t, new TypeReference<List<String>>() {})) {
                    if (s != null && !s.isBlank()) {
                        terms.add(s);
                    }
                }
            }
        } catch (IOException exc) {
            user(ctx, "terms must be a JSON array of strings");
            return;
        }
        boolean caseSensitive = "1".equals(ctx.formParam("caseSensitive"));
        byte[] bytes = upload.content().readAllBytes();
        try (PDDocument doc = password != null && !password.isBlank()
                ? Loader.loadPDF(bytes, password) : Loader.loadPDF(bytes)) {
            boolean wasEncrypted = doc.isEncrypted();
            if (wasEncrypted) {
                doc.setAllSecurityToBeRemoved(true);
            }
            int[] counts = removeForm(doc);
            // Annotations mentioning a term go before the next step flattens the rest into the
            // page (a flattened note's popup text would otherwise be lost to the check).
            int[] termHits = {0};
            int annotationsRemoved = terms.isEmpty() ? 0 : cleanAnnotations(doc, Set.of(), terms, caseSensitive, termHits);
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("encryptionRemoved", wasEncrypted);
            report.put("fieldsFlattened", counts[0]);
            report.put("signaturesRemoved", counts[1]);
            report.put("fieldsDropped", counts[2]);
            report.put("annotationsRemoved", annotationsRemoved);
            report.put("annotationTermMatches", termHits[0]);
            report.put("annotationsToFlatten", visibleAnnotations(doc));
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            doc.save(out);
            writeResult(ctx, report, out.toByteArray());
        } catch (IOException exc) {
            ctx.status(422).result("Failed to prepare for redaction: " + exc.getMessage());
        }
    }

    private static boolean drawsImages(PDPage page) {
        try {
            PDResources res = page.getResources();
            if (res == null) {
                return false;
            }
            for (COSName name : res.getXObjectNames()) {
                PDXObject x = res.getXObject(name);
                if (x instanceof PDImageXObject) {
                    return true;
                }
            }
        } catch (IOException exc) {
            return false;
        }
        return false;
    }

    // ------------------------------------------------------------------ small helpers

    private static void user(Context ctx, String message) {
        ctx.status(400).json(Map.of("detail", "USER:" + message));
    }

    private static Number num(Object value, Number fallback) {
        if (value instanceof Number n) {
            return n;
        }
        if (value instanceof String s) {
            try {
                return Double.parseDouble(s.trim());
            } catch (NumberFormatException exc) {
                return fallback;
            }
        }
        return fallback;
    }

    /** [1,2,3,5] -> "1-3,5" */
    static String compact(List<Integer> pages) {
        TreeSet<Integer> sorted = new TreeSet<>(pages);
        StringBuilder b = new StringBuilder();
        Integer start = null;
        Integer prev = null;
        for (int p : sorted) {
            if (start == null) {
                start = p;
            } else if (p != prev + 1) {
                b.append(b.length() > 0 ? "," : "").append(start.equals(prev) ? "" + start : start + "-" + prev);
                start = p;
            }
            prev = p;
        }
        if (start != null) {
            b.append(b.length() > 0 ? "," : "").append(start.equals(prev) ? "" + start : start + "-" + prev);
        }
        return b.toString();
    }
}
