package com.pdfgateway;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.UploadedFile;
import org.apache.fontbox.ttf.TrueTypeCollection;
import org.apache.fontbox.ttf.TrueTypeFont;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.graphics.color.PDColor;
import org.apache.pdfbox.pdmodel.graphics.color.PDDeviceRGB;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationHighlight;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationInk;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceDictionary;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceStream;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDBorderStyleDictionary;
import org.apache.pdfbox.pdmodel.graphics.blend.BlendMode;
import org.apache.pdfbox.pdmodel.graphics.state.PDExtendedGraphicsState;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationText;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationTextMarkup;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDCheckBox;
import org.apache.pdfbox.pdmodel.interactive.form.PDChoice;
import org.apache.pdfbox.pdmodel.interactive.form.PDComboBox;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
import org.apache.pdfbox.pdmodel.interactive.form.PDListBox;
import org.apache.pdfbox.pdmodel.interactive.form.PDNonTerminalField;
import org.apache.pdfbox.pdmodel.interactive.form.PDPushButton;
import org.apache.pdfbox.pdmodel.interactive.form.PDRadioButton;
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField;
import org.apache.pdfbox.pdmodel.interactive.form.PDVariableText;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.util.Matrix;

import java.awt.geom.AffineTransform;
import java.awt.geom.NoninvertibleTransformException;
import java.awt.geom.Point2D;
import java.awt.image.BufferedImage;
import java.io.Closeable;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;

public final class PdfboxServer {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String PLACEMENTS_META_KEY = "PdfGatewayPlacements";
    private static final float ERASE_PAD = 6f;
    private static final String CJK_FONT_PATH = envOr(
            "CJK_FONT_PATH", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc");
    private static final float MAX_RENDER_SCALE = 4f;
    private static final double MAX_RENDER_PIXELS = 40_000_000d;

    private PdfboxServer() {}

    /**
     * Desktop app: stop when the app that started us is gone, even if it could
     * not stop us itself (it crashed or was killed). The app passes its process
     * id in OPENPDF_PARENT_PID. Works the same on Windows, macOS and Linux.
     */
    static void exitWithParent() {
        String pid = System.getenv("OPENPDF_PARENT_PID");
        if (pid == null || pid.isBlank()) {
            return;
        }
        try {
            java.util.Optional<ProcessHandle> parent = ProcessHandle.of(Long.parseLong(pid.trim()));
            if (parent.isEmpty() || !parent.get().isAlive()) {
                System.exit(0);
            }
            parent.get().onExit().thenRun(() -> System.exit(0));
        } catch (NumberFormatException exc) {
            // not started by the desktop app
        }
    }

    /**
     * The first time PDFBox needs a font that is not embedded (Helvetica in
     * most PDFs), it reads every font installed on the system to build its
     * font list. On Windows, with hundreds of fonts, that takes one to two
     * minutes: the first "extract text" would hang that long. Do it in the
     * background as soon as the service starts. (PDFBox keeps the list in
     * ~/.pdfbox.cache, so later starts are fast.)
     */
    static void warmUpFonts() {
        Thread warm = new Thread(() -> {
            long started = System.nanoTime();
            try {
                org.apache.pdfbox.pdmodel.font.FontMappers.instance().getFontBoxFont("Helvetica", null);
            } catch (RuntimeException exc) {
                // only a warm-up
            }
            System.err.printf("font list ready in %.1f s%n", (System.nanoTime() - started) / 1e9);
        }, "font-warm-up");
        warm.setDaemon(true);
        warm.start();
    }

    public static void main(String[] args) {
        exitWithParent();
        CjkFontMapper.install(CJK_FONT_PATH);
        warmUpFonts();
        Javalin app = Javalin.create(config -> config.showJavalinBanner = false);

        app.get("/health", ctx -> ctx.json(Map.of("status", "ok")));

        app.post("/extract-text", PdfboxServer::extractText);
        app.post("/info", PdfboxServer::info);
        app.post("/annotate", PdfboxServer::annotate);
        app.post("/callout", PdfboxServer::callout);
        app.post("/draw-text", PdfboxServer::drawText);
        app.post("/form-fields", PdfboxServer::formFields);
        app.post("/fill-form", PdfboxServer::fillForm);
        app.post("/flatten", PdfboxServer::flatten);
        app.post("/highlight", PdfboxServer::highlight);
        app.post("/remove-highlight", PdfboxServer::removeHighlight);
        app.post("/replace-text", PdfboxServer::replaceText);
        app.post("/move-text", PdfboxServer::moveText);
        app.post("/erase-region", PdfboxServer::eraseRegion);
        app.post("/read-placements", PdfboxServer::readPlacements);
        app.post("/embed-placements", PdfboxServer::embedPlacements);
        app.post("/sign-image", PdfboxServer::signImage);
        app.post("/stamp-images", Signatures::stampImages);
        app.post("/digital-sign", Signatures::digitalSign);
        app.post("/verify-signatures", Signatures::verify);
        app.post("/cert-info", Signatures::certInfo);
        app.post("/generate-cert", Signatures::generateCert);
        app.post("/render-page", PdfboxServer::renderPage);
        app.post("/page-info", AgentTools::pageInfo);
        app.post("/page-text", AgentTools::pageText);
        app.post("/find-text", AgentTools::findText);
        app.post("/text-layout", AgentTools::textLayout);
        app.post("/redact", Redactor::redact);
        app.post("/verify-redaction", Redactor::verifyEndpoint);
        app.post("/prepare-redaction", Redactor::prepare);
        app.post("/extract-images", ImageTools::extractImages);
        app.post("/images-to-pdf", ImageTools::imagesToPdf);

        app.exception(Exception.class, (exc, ctx) -> {
            exc.printStackTrace();
            ctx.status(422).result("Internal error: " + exc.getMessage());
        });

        // 127.0.0.1 unless told otherwise (BIND_HOST=0.0.0.0 when the gateway runs in another container)
        app.start(envOr("BIND_HOST", "127.0.0.1"), getPort());
    }

    private static int getPort() {
        String port = System.getenv("PORT");
        if (port == null || port.isBlank()) {
            return 8092;
        }
        return Integer.parseInt(port);
    }

    private static byte[] readUpload(Context ctx) throws IOException {
        UploadedFile file = ctx.uploadedFile("file");
        if (file == null) {
            ctx.status(400).result("Missing file field");
            return null;
        }
        return file.content().readAllBytes();
    }

    private static PDDocument openDocument(byte[] bytes, String password) throws IOException {
        if (password != null && !password.isBlank()) {
            return Loader.loadPDF(bytes, password);
        }
        return Loader.loadPDF(bytes);
    }

    private static void extractText(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        String password = ctx.formParam("password");
        try (PDDocument doc = openDocument(bytes, password)) {
            PDFTextStripper stripper = new PDFTextStripper();
            String text = stripper.getText(doc);
            Map<String, Object> payload = new HashMap<>();
            payload.put("pageCount", doc.getNumberOfPages());
            payload.put("text", text);
            ctx.json(payload);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to extract text: " + exc.getMessage());
        }
    }

    private static void info(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        String password = ctx.formParam("password");
        try (PDDocument doc = openDocument(bytes, password)) {
            Map<String, Object> payload = new HashMap<>();
            payload.put("pageCount", doc.getNumberOfPages());
            payload.put("encrypted", doc.isEncrypted());
            if (doc.getDocumentInformation() != null) {
                payload.put("title", doc.getDocumentInformation().getTitle());
                payload.put("author", doc.getDocumentInformation().getAuthor());
                payload.put("subject", doc.getDocumentInformation().getSubject());
            }
            ctx.json(payload);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to read PDF info: " + exc.getMessage());
        }
    }

    private static void annotate(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }

        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        String text = ctx.formParam("text");
        if (text == null || text.isBlank()) {
            ctx.status(400).result("text is required");
            return;
        }
        float x = parseFloat(ctx.formParam("x"), 72f);
        float y = parseFloat(ctx.formParam("y"), 720f);
        String password = ctx.formParam("password");

        try (PDDocument doc = openDocument(bytes, password)) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }

            PDPage page = doc.getPage(pageIndex);
            PageSpace space = new PageSpace(page);

            PDAnnotationText note = new PDAnnotationText();
            note.setContents(text);
            note.setRectangle(space.userRect(x, y, 24, 24));
            page.getAnnotations().add(note);

            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to annotate PDF: " + exc.getMessage());
        }
    }

    private static void callout(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        String text = ctx.formParam("text");
        if (text == null || text.isBlank()) {
            ctx.status(400).result("text is required");
            return;
        }
        float anchorX = parseFloat(ctx.formParam("anchorX"), 72f);
        float anchorY = parseFloat(ctx.formParam("anchorY"), 720f);
        float boxX = parseFloat(ctx.formParam("x"), 72f);
        float boxY = parseFloat(ctx.formParam("y"), 720f);
        float boxWidth = parseFloat(ctx.formParam("width"), 160f);
        float boxHeight = parseFloat(ctx.formParam("height"), 48f);
        float fontSize = parseFloat(ctx.formParam("fontSize"), 0f);
        if (fontSize <= 0f) {
            fontSize = Math.max(8f, boxHeight * 0.28f);
        }
        String lineStyle = ctx.formParam("lineStyle");
        if (lineStyle == null || lineStyle.isBlank()) {
            lineStyle = "arrow";
        }
        String password = ctx.formParam("password");

        try (PDDocument doc = openDocument(bytes, password); FontResources fonts = new FontResources()) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }
            PDPage page = doc.getPage(pageIndex);
            PageSpace space = new PageSpace(page);
            PDRectangle mediaBox = space.visualBox();
            float[] conn = calloutConnectPoint(anchorX, anchorY, boxX, boxY, boxWidth, boxHeight);
            float mediaHeight = mediaBox.getHeight();
            float boxPdfBottom = mediaHeight - boxY - boxHeight;
            float anchorPdfX = anchorX;
            float anchorPdfY = mediaHeight - anchorY;
            float connPdfX = conn[0];
            float connPdfY = mediaHeight - conn[1];
            PDFont font = fonts.pick(doc, text);
            text = sanitizeText(font, text, true);
            try (PDPageContentStream stream = new PDPageContentStream(
                    doc, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
                stream.transform(space.toUser());
                stream.setNonStrokingColor(1f, 0.98f, 0.86f);
                stream.addRect(boxX, boxPdfBottom, boxWidth, boxHeight);
                stream.fill();
                stream.setStrokingColor(0.28f, 0.28f, 0.28f);
                stream.setLineWidth(1f);
                stream.addRect(boxX, boxPdfBottom, boxWidth, boxHeight);
                stream.stroke();
                stream.moveTo(connPdfX, connPdfY);
                stream.lineTo(anchorPdfX, anchorPdfY);
                stream.stroke();
                if ("arrow".equalsIgnoreCase(lineStyle)) {
                    drawArrowHead(stream, anchorPdfX, anchorPdfY, connPdfX, connPdfY);
                }
                writeTextInBox(stream, font, fontSize, boxX, boxY, boxWidth, boxHeight, text, mediaBox);
            }
            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to add callout: " + exc.getMessage());
        }
    }

    private static float[] calloutConnectPoint(
            float anchorX,
            float anchorY,
            float boxX,
            float boxY,
            float boxWidth,
            float boxHeight) {
        float[][] corners = {
            {boxX, boxY},
            {boxX + boxWidth, boxY},
            {boxX, boxY + boxHeight},
            {boxX + boxWidth, boxY + boxHeight}
        };
        float bestX = corners[0][0];
        float bestY = corners[0][1];
        float bestScore = Float.MAX_VALUE;
        for (float[] corner : corners) {
            float dx = corner[0] - anchorX;
            float dy = corner[1] - anchorY;
            float score = dx * dx + dy * dy;
            if (score < bestScore) {
                bestScore = score;
                bestX = corner[0];
                bestY = corner[1];
            }
        }
        return new float[] {bestX, bestY};
    }

    private static void drawArrowHead(
            PDPageContentStream stream,
            float tipX,
            float tipY,
            float fromX,
            float fromY) throws IOException {
        double angle = Math.atan2(tipY - fromY, tipX - fromX);
        float size = 7f;
        float x1 = (float) (tipX - size * Math.cos(angle - Math.PI / 6d));
        float y1 = (float) (tipY - size * Math.sin(angle - Math.PI / 6d));
        float x2 = (float) (tipX - size * Math.cos(angle + Math.PI / 6d));
        float y2 = (float) (tipY - size * Math.sin(angle + Math.PI / 6d));
        stream.setNonStrokingColor(0.28f, 0.28f, 0.28f);
        stream.moveTo(tipX, tipY);
        stream.lineTo(x1, y1);
        stream.lineTo(x2, y2);
        stream.closePath();
        stream.fill();
    }

    private static void writeTextInBox(
            PDPageContentStream stream,
            PDFont font,
            float fontSize,
            float boxX,
            float boxY,
            float boxWidth,
            float boxHeight,
            String text,
            PDRectangle mediaBox) throws IOException {
        float padding = 4f;
        float maxWidth = Math.max(8f, boxWidth - padding * 2f);
        float lineHeight = fontSize * 1.2f;
        List<String> lines = wrapTextLines(font, fontSize, text, maxWidth);
        float cursorTop = boxY + padding;
        int drawnLines = 0;
        for (String line : lines) {
            if (cursorTop + lineHeight > boxY + boxHeight - padding) {
                break;
            }
            float baseline = mediaBox.getHeight() - cursorTop - fontSize;
            writeBlackText(stream, font, fontSize, boxX + padding, baseline, line);
            cursorTop += lineHeight;
            drawnLines += 1;
        }
        if (drawnLines == 0 && !lines.isEmpty()) {
            float baseline = mediaBox.getHeight() - boxY - padding - fontSize;
            writeBlackText(stream, font, fontSize, boxX + padding, baseline, lines.get(0));
        }
    }

    static List<String> wrapTextLines(PDFont font, float fontSize, String text, float maxWidth)
            throws IOException {
        List<String> lines = new ArrayList<>();
        for (String paragraph : text.split("\\R")) {
            if (paragraph.isBlank()) {
                lines.add("");
                continue;
            }
            StringBuilder current = new StringBuilder();
            for (int i = 0; i < paragraph.length(); ) {
                int cp = paragraph.codePointAt(i);
                i += Character.charCount(cp);
                String ch = new String(Character.toChars(cp));
                String candidate = current.toString() + ch;
                float width = font.getStringWidth(candidate) / 1000f * fontSize;
                if (width > maxWidth && current.length() > 0) {
                    lines.add(current.toString());
                    current = new StringBuilder().append(ch);
                } else {
                    current.append(ch);
                }
            }
            if (current.length() > 0) {
                lines.add(current.toString());
            }
        }
        if (lines.isEmpty()) {
            lines.add("");
        }
        return lines;
    }

    private static void drawText(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }

        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        String text = ctx.formParam("text");
        if (text == null || text.isBlank()) {
            ctx.status(400).result("text is required");
            return;
        }
        float x = parseFloat(ctx.formParam("x"), 72f);
        float y = parseFloat(ctx.formParam("y"), 720f);
        float height = parseFloat(ctx.formParam("height"), 18f);
        float fontSize = parseFloat(ctx.formParam("fontSize"), 0f);
        if (fontSize <= 0f) {
            fontSize = Math.max(8f, height * 0.85f);
        }
        String password = ctx.formParam("password");

        try (PDDocument doc = openDocument(bytes, password); FontResources fonts = new FontResources()) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }
            PDPage page = doc.getPage(pageIndex);
            PageSpace space = new PageSpace(page);
            PDRectangle mediaBox = space.visualBox();
            float pdfY = mediaBox.getHeight() - y - fontSize;
            PDFont font = fonts.pick(doc, text);
            text = sanitizeText(font, text, false);
            try (PDPageContentStream stream = new PDPageContentStream(
                    doc, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
                stream.transform(space.toUser());
                writeBlackText(
                        stream,
                        font,
                        fontSize,
                        x + 1f,
                        pdfY,
                        text);
            }
            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to draw text: " + exc.getMessage());
        }
    }

    private static void formFields(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        String password = ctx.formParam("password");
        try (PDDocument doc = openDocument(bytes, password)) {
            PDAcroForm form = doc.getDocumentCatalog().getAcroForm();
            List<Map<String, Object>> fields = new ArrayList<>();
            if (form != null) {
                for (PDField field : form.getFields()) {
                    collectFormField(doc, field, fields);
                }
            }
            ctx.json(Map.of("fields", fields));
        } catch (IOException exc) {
            ctx.status(422).result("Failed to list form fields: " + exc.getMessage());
        }
    }

    private static void collectFormField(PDDocument doc, PDField field, List<Map<String, Object>> fields)
            throws IOException {
        if (field instanceof PDNonTerminalField nonTerminal) {
            for (PDField child : nonTerminal.getChildren()) {
                collectFormField(doc, child, fields);
            }
            return;
        }
        fields.add(fieldToMap(doc, field));
    }

    private static Map<String, Object> fieldToMap(PDDocument doc, PDField field) throws IOException {
        Map<String, Object> item = new HashMap<>();
        String name = field.getFullyQualifiedName();
        item.put("name", name);
        item.put("type", field.getFieldType());
        item.put("value", field.getValueAsString() != null ? field.getValueAsString() : "");
        item.put("readOnly", field.isReadOnly());
        // The tooltip (/TU) usually says what a cryptically named field is for.
        String tooltip = field.getAlternateFieldName();
        if (tooltip != null && !tooltip.isBlank()) {
            item.put("description", tooltip.strip());
        }
        if (field instanceof PDTextField tf && tf.getMaxLen() > 0) {
            item.put("maxLength", tf.getMaxLen());
        }

        if (field instanceof PDCheckBox checkBox) {
            item.put("kind", "checkbox");
            item.put("checked", checkBox.isChecked());
            item.put("onValue", checkBox.getOnValue());
        } else if (field instanceof PDRadioButton radio) {
            item.put("kind", "radio");
            item.put("options", new ArrayList<>(radio.getOnValues()));
        } else if (field instanceof PDComboBox || field instanceof PDListBox) {
            // getValueAsString() gives "[Individual]" (a list printed as text) or
            // "[]" for these; the UI then showed the first option instead of the
            // real one, and an untouched signed form looked edited.
            PDChoice choice = (PDChoice) field;
            List<String> selected = choice.getValue();
            item.put("kind", "choice");
            item.put("options", choice.getOptions());
            List<String> labels = choice.getOptionsDisplayValues();
            if (!labels.equals(choice.getOptions())) {
                item.put("optionLabels", labels);
            }
            item.put("value", selected.isEmpty() ? "" : selected.get(0));
            item.put("values", selected);
            if (choice.isMultiSelect()) {
                item.put("multiSelect", true);
            }
        } else if (field instanceof PDTextField textField) {
            item.put("kind", textField.isMultiline() ? "textarea" : "text");
        } else if (field instanceof PDPushButton) {
            item.put("kind", "button");
            item.put("readOnly", true);
        } else if ("Sig".equals(field.getFieldType())) {
            item.put("kind", "signature");
            item.put("readOnly", true);
            item.put("signed", field.getCOSObject().getDictionaryObject(COSName.V) != null);
        } else if ("Btn".equals(field.getFieldType())) {
            item.put("kind", "button");
            item.put("readOnly", true);
        } else {
            item.put("kind", "text");
        }

        if (!field.getWidgets().isEmpty()) {
            PDAnnotationWidget widget = field.getWidgets().get(0);
            PDRectangle rect = widget.getRectangle();
            int pageIndex = findWidgetPageIndex(doc, widget);
            if (rect != null && pageIndex >= 0) {
                PageSpace space = new PageSpace(doc.getPage(pageIndex));
                float[] visual = space.visualRect(rect);
                item.put("pageIndex", pageIndex);
                item.put("x", visual[0]);
                item.put("y", visual[1]);
                item.put("width", visual[2]);
                item.put("height", visual[3]);
            }
        }
        return item;
    }

    private static int findPageIndex(PDDocument doc, PDPage target) {
        for (int i = 0; i < doc.getNumberOfPages(); i++) {
            if (doc.getPage(i).equals(target)) {
                return i;
            }
        }
        return -1;
    }

    private static int findWidgetPageIndex(PDDocument doc, PDAnnotationWidget widget) throws IOException {
        PDPage widgetPage = widget.getPage();
        if (widgetPage != null) {
            return findPageIndex(doc, widgetPage);
        }
        for (int i = 0; i < doc.getNumberOfPages(); i++) {
            PDPage page = doc.getPage(i);
            for (PDAnnotation annotation : page.getAnnotations()) {
                if (annotation.equals(widget)) {
                    return i;
                }
            }
        }
        return -1;
    }

    private static void fillForm(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        String valuesJson = ctx.formParam("values");
        if (valuesJson == null || valuesJson.isBlank()) {
            ctx.status(400).result("values JSON object is required");
            return;
        }
        String password = ctx.formParam("password");
        Map<String, String> values;
        try {
            values = MAPPER.readValue(valuesJson, new TypeReference<Map<String, String>>() {});
        } catch (IOException exc) {
            ctx.status(400).result("Invalid values JSON: " + exc.getMessage());
            return;
        }

        try (PDDocument doc = openDocument(bytes, password); FontResources fonts = new FontResources()) {
            PDAcroForm form = doc.getDocumentCatalog().getAcroForm();
            if (form == null) {
                ctx.status(400).result("PDF has no AcroForm fields");
                return;
            }
            int filled = 0;
            List<String> warnings = new ArrayList<>();
            for (Map.Entry<String, String> entry : values.entrySet()) {
                String fieldName = entry.getKey();
                String fieldValue = entry.getValue() != null ? entry.getValue() : "";
                try {
                    PDField field = form.getField(fieldName);
                    if (field == null) {
                        warnings.add(fieldName + ": not found");
                        continue;
                    }
                    if (field.isReadOnly() || !isFillableField(field)) {
                        continue;
                    }
                    if (field instanceof PDVariableText textual) {
                        useFontFor(doc, form, textual, fieldValue, fonts);
                    }
                    setFieldValue(field, fieldValue);
                    filled++;
                } catch (Exception exc) {
                    warnings.add(fieldName + ": " + exc.getMessage());
                }
            }
            if (filled == 0) {
                ctx.status(422).result(
                        "No fields were filled"
                                + (warnings.isEmpty() ? "" : ": " + String.join("; ", warnings))
                );
                return;
            }
            form.setNeedAppearances(true);
            try {
                form.refreshAppearances();
            } catch (Exception ignored) {
                // NeedAppearances=true lets viewers render values without standard fonts.
            }
            ctx.header("X-Filled-Count", String.valueOf(filled));
            if (!warnings.isEmpty()) {
                ctx.header("X-Fill-Warnings", String.join("; ", warnings));
            }
            writePdf(ctx, doc);
        } catch (Exception exc) {
            ctx.status(422).result("Failed to fill form: " + exc.getMessage());
        }
    }

    private static final java.util.regex.Pattern DA_FONT =
            java.util.regex.Pattern.compile("/\\S+\\s+([-\\d.]+)\\s+Tf");

    /**
     * Form fields normally use Helvetica, which has no Chinese glyphs. When a
     * value needs other characters, register the CJK font in the form's
     * resources and point the field's default appearance at it.
     */
    private static void useFontFor(
            PDDocument doc, PDAcroForm form, PDVariableText field, String value, FontResources fonts)
            throws IOException {
        if (value == null || value.isEmpty()
                || canEncode(new PDType1Font(Standard14Fonts.FontName.HELVETICA), value)) {
            return;
        }
        PDFont cjk = fonts.cjk(doc);
        PDResources resources = form.getDefaultResources();
        if (resources == null) {
            resources = new PDResources();
            form.setDefaultResources(resources);
        }
        COSName name = resources.add(cjk);
        String da = field.getDefaultAppearance();
        String size = "0";
        if (da != null) {
            java.util.regex.Matcher m = DA_FONT.matcher(da);
            if (m.find()) {
                size = m.group(1);
                field.setDefaultAppearance(m.replaceFirst("/" + name.getName() + " " + size + " Tf"));
                return;
            }
        }
        field.setDefaultAppearance("/" + name.getName() + " " + size + " Tf 0 g");
    }

    private static boolean isFillableField(PDField field) {
        if (field instanceof PDCheckBox || field instanceof PDRadioButton) {
            return true;
        }
        if (field instanceof PDComboBox || field instanceof PDListBox) {
            return true;
        }
        if (field instanceof PDTextField) {
            return true;
        }
        String type = field.getFieldType();
        if ("Sig".equals(type) || "Btn".equals(type)) {
            return false;
        }
        return "Tx".equals(type) || "Ch".equals(type);
    }

    private static void setFieldValue(PDField field, String value) throws IOException {
        if (field instanceof PDCheckBox checkBox) {
            if (isOffValue(value)) {
                checkBox.unCheck();
                return;
            }
            String onValue = checkBox.getOnValue();
            if (onValue != null && !onValue.isBlank()) {
                checkBox.setValue(onValue);
            } else if (isTruthy(value)) {
                checkBox.check();
            } else {
                checkBox.setValue(value);
            }
            return;
        }
        if (field instanceof PDRadioButton radio) {
            if (isOffValue(value)) {
                radio.setValue("");
            } else {
                String onValue = resolveRadioOnValue(radio, value);
                radio.setValue(onValue != null ? onValue : value);
            }
            return;
        }
        if (field instanceof PDComboBox || field instanceof PDListBox) {
            if (value.isBlank()) {
                field.setValue("");
            } else {
                field.setValue(value);
            }
            return;
        }
        field.setValue(value);
    }

    private static boolean isTruthy(String value) {
        if (value == null) {
            return false;
        }
        String normalized = value.trim().toLowerCase();
        return normalized.equals("true")
                || normalized.equals("yes")
                || normalized.equals("1")
                || normalized.equals("on");
    }

    private static boolean isOffValue(String value) {
        if (value == null || value.isBlank()) {
            return true;
        }
        String normalized = value.trim().toLowerCase();
        return normalized.equals("off")
                || normalized.equals("false")
                || normalized.equals("no")
                || normalized.equals("0");
    }

    private static boolean valuesMatchExport(String expected, String actual) {
        if (expected == null || actual == null) {
            return false;
        }
        if (expected.equals(actual)) {
            return true;
        }
        String expectedNorm = expected.startsWith("/") ? expected.substring(1) : expected;
        String actualNorm = actual.startsWith("/") ? actual.substring(1) : actual;
        return expectedNorm.equals(actualNorm);
    }

    private static String resolveRadioOnValue(PDRadioButton radio, String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        for (String option : radio.getOnValues()) {
            if (valuesMatchExport(option, value)) {
                return option;
            }
        }
        return value;
    }

    private static void highlight(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        float x = parseFloat(ctx.formParam("x"), 72f);
        float y = parseFloat(ctx.formParam("y"), 720f);
        float width = parseFloat(ctx.formParam("width"), 120f);
        float height = parseFloat(ctx.formParam("height"), 18f);
        String password = ctx.formParam("password");
        // a highlighter stroke drawn by hand: [[[x, y], ...], ...] in displayed points
        String points = ctx.formParam("points");
        // several boxes highlighted as one (the lines of a text selection): [[x, y, width, height], ...]
        String rectsJson = ctx.formParam("rects");
        List<List<Double>> rects = null;
        if (rectsJson != null && !rectsJson.isBlank()) {
            try {
                rects = MAPPER.readValue(rectsJson, new TypeReference<List<List<Double>>>() {});
            } catch (IOException exc) {
                ctx.status(400).result("rects must be a JSON array of [x, y, width, height]");
                return;
            }
            if (rects.isEmpty() || rects.size() > 500 || rects.stream().anyMatch(r -> r.size() != 4)) {
                ctx.status(400).result("rects must be 1 to 500 boxes of [x, y, width, height]");
                return;
            }
        }
        List<List<List<Double>>> strokes = null;
        if (points != null && !points.isBlank()) {
            try {
                strokes = MAPPER.readValue(points, new TypeReference<List<List<List<Double>>>>() {});
            } catch (IOException exc) {
                ctx.status(400).result("points must be a JSON array of strokes, each an array of [x, y]");
                return;
            }
        }

        try (PDDocument doc = openDocument(bytes, password)) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }
            PDPage page = doc.getPage(pageIndex);
            PageSpace space = new PageSpace(page);
            if (strokes != null) {
                float strokeWidth = Math.max(1f, Math.min(60f, parseFloat(ctx.formParam("strokeWidth"), 12f)));
                PDAnnotation ink = inkHighlight(doc, page, space, strokes, strokeWidth);
                if (ink == null) {
                    ctx.status(400).result("The stroke has no points");
                    return;
                }
                page.getAnnotations().add(ink);
                writePdf(ctx, doc);
                return;
            }
            if (rects == null) {
                rects = List.of(List.of((double) x, (double) y, (double) width, (double) height));
            }
            // One quadrilateral per box. Quad points follow the reading direction
            // as seen on screen: upper-left, upper-right, lower-left, lower-right.
            float[] quads = new float[rects.size() * 8];
            float minX = Float.MAX_VALUE, minY = Float.MAX_VALUE, maxX = -Float.MAX_VALUE, maxY = -Float.MAX_VALUE;
            for (int i = 0; i < rects.size(); i++) {
                List<Double> r = rects.get(i);
                float rx = r.get(0).floatValue(), ry = r.get(1).floatValue();
                float rw = r.get(2).floatValue(), rh = r.get(3).floatValue();
                float[][] corners = {
                    space.userPoint(rx, ry), space.userPoint(rx + rw, ry),
                    space.userPoint(rx, ry + rh), space.userPoint(rx + rw, ry + rh)
                };
                for (int c = 0; c < 4; c++) {
                    quads[i * 8 + c * 2] = corners[c][0];
                    quads[i * 8 + c * 2 + 1] = corners[c][1];
                    minX = Math.min(minX, corners[c][0]);
                    maxX = Math.max(maxX, corners[c][0]);
                    minY = Math.min(minY, corners[c][1]);
                    maxY = Math.max(maxY, corners[c][1]);
                }
            }

            PDAnnotationHighlight highlight = new PDAnnotationHighlight();
            highlight.setRectangle(new PDRectangle(minX, minY, maxX - minX, maxY - minY));
            highlight.setQuadPoints(quads);
            highlight.setColor(new PDColor(new float[]{1f, 0.92f, 0.23f}, PDDeviceRGB.INSTANCE));
            highlight.setConstantOpacity(0.35f);
            highlight.setPage(page);
            highlight.setPrinted(true);
            highlight.constructAppearances(doc);
            page.getAnnotations().add(highlight);
            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to highlight PDF: " + exc.getMessage());
        }
    }

    /** Marks an Ink annotation as a highlighter stroke, so that Erase highlight takes it too. */
    static final COSName HIGHLIGHTER = COSName.getPDFName("OpenPDFHighlighter");

    /**
     * A highlighter stroke drawn by hand: an Ink annotation in the highlight's
     * colour and transparency (multiplied, so text under it stays readable),
     * with round ends; its own appearance, so every reader draws it the same.
     */
    static PDAnnotation inkHighlight(PDDocument doc, PDPage page, PageSpace space,
                                     List<List<List<Double>>> strokes, float width) throws IOException {
        List<float[]> paths = new ArrayList<>();
        float minX = Float.MAX_VALUE, minY = Float.MAX_VALUE, maxX = -Float.MAX_VALUE, maxY = -Float.MAX_VALUE;
        for (List<List<Double>> stroke : strokes) {
            if (stroke == null || stroke.isEmpty() || stroke.size() > 5000) {
                continue;
            }
            float[] path = new float[stroke.size() * 2];
            int k = 0;
            for (List<Double> pt : stroke) {
                if (pt == null || pt.size() < 2) {
                    continue;
                }
                float[] u = space.userPoint(pt.get(0).floatValue(), pt.get(1).floatValue());
                path[k++] = u[0];
                path[k++] = u[1];
                minX = Math.min(minX, u[0]);
                minY = Math.min(minY, u[1]);
                maxX = Math.max(maxX, u[0]);
                maxY = Math.max(maxY, u[1]);
            }
            if (k >= 2) {
                paths.add(java.util.Arrays.copyOf(path, k));
            }
        }
        if (paths.isEmpty()) {
            return null;
        }
        float pad = width / 2f + 1f;
        PDRectangle rect = new PDRectangle(minX - pad, minY - pad, maxX - minX + 2 * pad, maxY - minY + 2 * pad);
        PDAnnotationInk ink = new PDAnnotationInk();
        ink.setRectangle(rect);
        ink.setInkList(paths.toArray(new float[0][]));
        ink.setColor(new PDColor(new float[]{1f, 0.92f, 0.23f}, PDDeviceRGB.INSTANCE));
        ink.setConstantOpacity(0.35f);
        PDBorderStyleDictionary border = new PDBorderStyleDictionary();
        border.setWidth(width);
        ink.setBorderStyle(border);
        ink.setPage(page);
        ink.setPrinted(true);
        ink.getCOSObject().setBoolean(HIGHLIGHTER, true);

        PDAppearanceStream appearance = new PDAppearanceStream(doc);
        appearance.setBBox(rect);
        appearance.setResources(new PDResources());
        PDExtendedGraphicsState gs = new PDExtendedGraphicsState();
        gs.setStrokingAlphaConstant(0.35f);
        gs.setNonStrokingAlphaConstant(0.35f);
        gs.setBlendMode(BlendMode.MULTIPLY);
        try (PDPageContentStream cs = new PDPageContentStream(doc, appearance)) {
            cs.setGraphicsStateParameters(gs);
            cs.setStrokingColor(1f, 0.92f, 0.23f);
            cs.setLineWidth(width);
            cs.setLineCapStyle(1);
            cs.setLineJoinStyle(1);
            for (float[] path : paths) {
                cs.moveTo(path[0], path[1]);
                if (path.length == 2) {
                    cs.lineTo(path[0] + 0.01f, path[1]); // a dot: round ends make it a disc
                }
                for (int i = 2; i + 1 < path.length; i += 2) {
                    cs.lineTo(path[i], path[i + 1]);
                }
                cs.stroke();
            }
        }
        PDAppearanceDictionary ap = new PDAppearanceDictionary();
        ap.setNormalAppearance(appearance);
        ink.setAppearance(ap);
        return ink;
    }

    /** Whether a highlighter stroke passes through a box (user space): any point of it within half its width. */
    private static boolean strokeTouches(PDAnnotation ann, PDRectangle target) {
        COSBase list = ann.getCOSObject().getDictionaryObject(COSName.getPDFName("InkList"));
        if (!(list instanceof COSArray paths)) {
            return intersectsAnnotation(ann, target);
        }
        float half = 0f;
        if (ann instanceof PDAnnotationInk inkAnn && inkAnn.getBorderStyle() != null) {
            half = inkAnn.getBorderStyle().getWidth() / 2f;
        }
        PDRectangle grown = inflate(target, half);
        for (int i = 0; i < paths.size(); i++) {
            if (!(paths.getObject(i) instanceof COSArray path)) {
                continue;
            }
            float[] pts = path.toFloatArray();
            for (int k = 0; k + 1 < pts.length; k += 2) {
                if (grown.contains(pts[k], pts[k + 1])) {
                    return true;
                }
            }
        }
        return false;
    }

    private static void removeHighlight(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        float x = parseFloat(ctx.formParam("x"), 72f);
        float y = parseFloat(ctx.formParam("y"), 720f);
        float width = parseFloat(ctx.formParam("width"), 120f);
        float height = parseFloat(ctx.formParam("height"), 18f);
        String password = ctx.formParam("password");

        try (PDDocument doc = openDocument(bytes, password)) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }
            PDPage page = doc.getPage(pageIndex);
            PDRectangle target = inflate(new PageSpace(page).userRect(x, y, width, height), 3f);
            List<PDAnnotation> kept = new ArrayList<>();
            int removed = 0;
            for (PDAnnotation ann : page.getAnnotations()) {
                boolean stroke = ann.getCOSObject().getBoolean(HIGHLIGHTER, false);
                if ((isHighlight(ann) && intersectsAnnotation(ann, target)) || (stroke && strokeTouches(ann, target))) {
                    removed++;
                } else {
                    kept.add(ann);
                }
            }
            page.setAnnotations(kept);
            ctx.header("X-Removed-Count", String.valueOf(removed));
            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to remove highlight: " + exc.getMessage());
        }
    }

    private static boolean isHighlight(PDAnnotation ann) {
        if (ann instanceof PDAnnotationHighlight || ann instanceof PDAnnotationTextMarkup) {
            String subtype = ann.getSubtype();
            if (subtype == null) {
                return ann instanceof PDAnnotationHighlight;
            }
            return "Highlight".equalsIgnoreCase(subtype);
        }
        String subtype = ann.getSubtype();
        return subtype != null && "Highlight".equalsIgnoreCase(subtype);
    }

    private static PDRectangle inflate(PDRectangle rect, float pad) {
        return new PDRectangle(
                rect.getLowerLeftX() - pad,
                rect.getLowerLeftY() - pad,
                rect.getWidth() + pad * 2f,
                rect.getHeight() + pad * 2f
        );
    }

    private static PDRectangle boundsFromQuadPoints(float[] quads) {
        if (quads == null || quads.length < 8) {
            return null;
        }
        float minX = Float.MAX_VALUE;
        float minY = Float.MAX_VALUE;
        float maxX = -Float.MAX_VALUE;
        float maxY = -Float.MAX_VALUE;
        for (int i = 0; i + 1 < quads.length; i += 2) {
            minX = Math.min(minX, quads[i]);
            maxX = Math.max(maxX, quads[i]);
            minY = Math.min(minY, quads[i + 1]);
            maxY = Math.max(maxY, quads[i + 1]);
        }
        return new PDRectangle(minX, minY, maxX - minX, maxY - minY);
    }

    private static PDRectangle annotationBounds(PDAnnotation ann) {
        PDRectangle rect = ann.getRectangle();
        if (ann instanceof PDAnnotationTextMarkup markup) {
            PDRectangle fromQuads = boundsFromQuadPoints(markup.getQuadPoints());
            if (fromQuads != null && rect != null) {
                float minX = Math.min(rect.getLowerLeftX(), fromQuads.getLowerLeftX());
                float minY = Math.min(rect.getLowerLeftY(), fromQuads.getLowerLeftY());
                float maxX = Math.max(rect.getUpperRightX(), fromQuads.getUpperRightX());
                float maxY = Math.max(rect.getUpperRightY(), fromQuads.getUpperRightY());
                return new PDRectangle(minX, minY, maxX - minX, maxY - minY);
            }
            if (fromQuads != null) {
                return fromQuads;
            }
        }
        return rect;
    }

    private static boolean intersectsAnnotation(PDAnnotation ann, PDRectangle target) {
        PDRectangle bounds = annotationBounds(ann);
        return intersects(bounds, target);
    }

    private static boolean intersects(PDRectangle a, PDRectangle b) {
        if (a == null || b == null) {
            return false;
        }
        return a.getLowerLeftX() < b.getUpperRightX()
                && a.getUpperRightX() > b.getLowerLeftX()
                && a.getLowerLeftY() < b.getUpperRightY()
                && a.getUpperRightY() > b.getLowerLeftY();
    }

    private static void replaceText(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        String text = ctx.formParam("text");
        if (text == null || text.isBlank()) {
            ctx.status(400).result("text is required");
            return;
        }
        float x = parseFloat(ctx.formParam("x"), 72f);
        float y = parseFloat(ctx.formParam("y"), 720f);
        float width = parseFloat(ctx.formParam("width"), 160f);
        float height = parseFloat(ctx.formParam("height"), 18f);
        float fontSize = parseFloat(ctx.formParam("fontSize"), 0f);
        if (fontSize <= 0f) {
            fontSize = Math.max(8f, height * 0.85f);
        }
        String coverMode = ctx.formParam("coverMode");
        if (coverMode == null || coverMode.isBlank()) {
            coverMode = "none";
        }
        float eraseX = parseFloat(ctx.formParam("eraseX"), 0f);
        float eraseY = parseFloat(ctx.formParam("eraseY"), 0f);
        float eraseWidth = parseFloat(ctx.formParam("eraseWidth"), 0f);
        float eraseHeight = parseFloat(ctx.formParam("eraseHeight"), 0f);
        String password = ctx.formParam("password");

        try (PDDocument doc = openDocument(bytes, password); FontResources fonts = new FontResources()) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }
            PDPage page = doc.getPage(pageIndex);
            PageSpace space = new PageSpace(page);
            PDRectangle mediaBox = space.visualBox();
            PDFont font = fonts.pick(doc, text);
            text = sanitizeText(font, text, false);
            float textBaseline = mediaBox.getHeight() - y - fontSize;
            try (PDPageContentStream stream = new PDPageContentStream(
                    doc, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
                stream.transform(space.toUser());
                paintCoverRect(
                        stream,
                        mediaBox,
                        coverMode,
                        x,
                        y,
                        width,
                        height,
                        eraseX,
                        eraseY,
                        eraseWidth,
                        eraseHeight);
                writeBlackText(stream, font, fontSize, x + 1f, textBaseline, text);
            }
            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to replace text: " + exc.getMessage());
        }
    }

    private static void moveText(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        String text = ctx.formParam("text");
        if (text == null || text.isBlank()) {
            ctx.status(400).result("text is required");
            return;
        }
        float newX = parseFloat(ctx.formParam("newX"), 72f);
        float newY = parseFloat(ctx.formParam("newY"), 720f);
        float newWidth = parseFloat(ctx.formParam("newWidth"), 0f);
        float newHeight = parseFloat(ctx.formParam("newHeight"), 0f);
        float eraseX = parseFloat(ctx.formParam("eraseX"), 0f);
        float eraseY = parseFloat(ctx.formParam("eraseY"), 0f);
        float eraseWidth = parseFloat(ctx.formParam("eraseWidth"), 0f);
        float eraseHeight = parseFloat(ctx.formParam("eraseHeight"), 0f);
        float fontSize = parseFloat(ctx.formParam("fontSize"), 0f);
        if (fontSize <= 0f) {
            fontSize = Math.max(8f, eraseHeight * 0.85f);
        }
        if (newWidth <= 0f) {
            newWidth = eraseWidth;
        }
        if (newHeight <= 0f) {
            newHeight = Math.max(eraseHeight, fontSize * 1.25f);
        }
        String password = ctx.formParam("password");

        try (PDDocument doc = openDocument(bytes, password); FontResources fonts = new FontResources()) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }
            PDPage page = doc.getPage(pageIndex);
            PageSpace space = new PageSpace(page);
            PDRectangle mediaBox = space.visualBox();
            PDFont font = fonts.pick(doc, text);
            text = sanitizeText(font, text, false);
            float textBaseline = mediaBox.getHeight() - newY - fontSize;
            try (PDPageContentStream stream = new PDPageContentStream(
                    doc, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
                stream.transform(space.toUser());
                paintCoverRect(
                        stream,
                        mediaBox,
                        "overlay",
                        newX,
                        newY,
                        newWidth,
                        newHeight,
                        eraseX,
                        eraseY,
                        eraseWidth,
                        eraseHeight);
                writeBlackText(stream, font, fontSize, newX + 1f, textBaseline, text);
            }
            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to move text: " + exc.getMessage());
        }
    }

    private static void eraseRegion(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        float x = parseFloat(ctx.formParam("x"), 72f);
        float y = parseFloat(ctx.formParam("y"), 720f);
        float width = parseFloat(ctx.formParam("width"), 160f);
        float height = parseFloat(ctx.formParam("height"), 18f);
        String password = ctx.formParam("password");

        try (PDDocument doc = openDocument(bytes, password)) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }
            PDPage page = doc.getPage(pageIndex);
            PageSpace space = new PageSpace(page);
            PDRectangle mediaBox = space.visualBox();
            try (PDPageContentStream stream = new PDPageContentStream(
                    doc, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
                stream.transform(space.toUser());
                paintCoverRect(stream, mediaBox, "selection", x, y, width, height, 0f, 0f, 0f, 0f);
            }
            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to erase region: " + exc.getMessage());
        }
    }

    private static void writeBlackText(
            PDPageContentStream stream,
            PDFont font,
            float fontSize,
            float x,
            float baseline,
            String text) throws IOException {
        stream.beginText();
        stream.setFont(font, fontSize);
        stream.setNonStrokingColor(0f, 0f, 0f);
        stream.newLineAtOffset(x, baseline);
        stream.showText(text);
        stream.endText();
    }

    private static void paintCoverRect(
            PDPageContentStream stream,
            PDRectangle mediaBox,
            String coverMode,
            float x,
            float y,
            float width,
            float height,
            float eraseX,
            float eraseY,
            float eraseWidth,
            float eraseHeight) throws IOException {
        if ("none".equalsIgnoreCase(coverMode)) {
            return;
        }
        float fillX;
        float fillBottom;
        float fillWidth;
        float fillHeight;
        if ("overlay".equalsIgnoreCase(coverMode)) {
            stream.setNonStrokingColor(1f, 1f, 1f);
            if (eraseWidth > 0f && eraseHeight > 0f) {
                stream.addRect(
                        eraseX - ERASE_PAD,
                        mediaBox.getHeight() - eraseY - eraseHeight - ERASE_PAD,
                        eraseWidth + ERASE_PAD * 2f,
                        eraseHeight + ERASE_PAD * 2f);
                stream.fill();
            }
            stream.addRect(
                    x - 1f,
                    mediaBox.getHeight() - y - height - 1f,
                    width + 2f,
                    height + 2f);
            stream.fill();
            return;
        }
        if ("erase".equalsIgnoreCase(coverMode) && eraseWidth > 0f && eraseHeight > 0f) {
            fillX = eraseX - ERASE_PAD;
            fillBottom = mediaBox.getHeight() - eraseY - eraseHeight - ERASE_PAD;
            fillWidth = eraseWidth + ERASE_PAD * 2f;
            fillHeight = eraseHeight + ERASE_PAD * 2f;
        } else if ("selection".equalsIgnoreCase(coverMode)) {
            fillX = x - ERASE_PAD;
            fillBottom = mediaBox.getHeight() - y - height - ERASE_PAD;
            fillWidth = width + ERASE_PAD * 2f;
            fillHeight = height + ERASE_PAD * 2f;
        } else {
            return;
        }
        stream.setNonStrokingColor(1f, 1f, 1f);
        stream.addRect(fillX, fillBottom, fillWidth, fillHeight);
        stream.fill();
    }

    private static void signImage(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        UploadedFile image = ctx.uploadedFile("image");
        if (image == null) {
            ctx.status(400).result("Missing image field");
            return;
        }
        byte[] imageBytes = image.content().readAllBytes();
        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        float x = parseFloat(ctx.formParam("x"), 72f);
        float y = parseFloat(ctx.formParam("y"), 720f);
        float width = parseFloat(ctx.formParam("width"), 120f);
        float height = parseFloat(ctx.formParam("height"), 48f);
        String password = ctx.formParam("password");

        try (PDDocument doc = openDocument(bytes, password)) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }
            PDPage page = doc.getPage(pageIndex);
            PageSpace space = new PageSpace(page);
            PDRectangle mediaBox = space.visualBox();
            PDImageXObject pdImage = PDImageXObject.createFromByteArray(doc, imageBytes, "signature");
            try (PDPageContentStream stream = new PDPageContentStream(
                    doc, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
                stream.transform(space.toUser());
                stream.drawImage(pdImage, x, mediaBox.getHeight() - y - height, width, height);
            }
            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to sign PDF: " + exc.getMessage());
        }
    }

    private static void renderPage(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        int pageIndex = parseInt(ctx.formParam("pageIndex"), 0);
        float scale = parseFloat(ctx.formParam("scale"), 1.5f);
        if (!(scale > 0f)) {
            scale = 1.5f;
        }
        scale = Math.min(scale, MAX_RENDER_SCALE);
        String password = ctx.formParam("password");

        try (PDDocument doc = openDocument(bytes, password)) {
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                ctx.status(400).result("pageIndex out of range");
                return;
            }
            PageSpace space = new PageSpace(doc.getPage(pageIndex));
            double pixels = (double) space.vw * space.vh * scale * scale;
            if (pixels > MAX_RENDER_PIXELS) {
                scale = (float) Math.sqrt(MAX_RENDER_PIXELS / ((double) space.vw * space.vh));
            }
            PDFRenderer renderer = new PDFRenderer(doc);
            BufferedImage image = renderer.renderImage(pageIndex, scale);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ImageIO.write(image, "png", out);
            ctx.contentType("image/png");
            ctx.result(out.toByteArray());
        } catch (IOException exc) {
            ctx.status(422).result("Failed to render page: " + exc.getMessage());
        }
    }

    private static void flatten(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        String password = ctx.formParam("password");
        try (PDDocument doc = openDocument(bytes, password)) {
            PDAcroForm form = doc.getDocumentCatalog().getAcroForm();
            if (form != null) {
                form.flatten();
            }
            writePdf(ctx, doc);
        } catch (IOException exc) {
            ctx.status(422).result("Failed to flatten PDF: " + exc.getMessage());
        }
    }

    private static void readPlacements(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        String password = ctx.formParam("password");
        try (PDDocument doc = openDocument(bytes, password)) {
            String raw = getPlacementsJson(doc);
            if (raw == null || raw.isBlank()) {
                ctx.json(Map.of("placements", List.of()));
                return;
            }
            List<Map<String, Object>> placements =
                    MAPPER.readValue(raw, new TypeReference<List<Map<String, Object>>>() {});
            ctx.json(Map.of("placements", placements));
        } catch (IOException exc) {
            ctx.status(422).result("Failed to read placements: " + exc.getMessage());
        }
    }

    private static void embedPlacements(Context ctx) throws IOException {
        byte[] bytes = readUpload(ctx);
        if (bytes == null) {
            return;
        }
        String placements = ctx.formParam("placements");
        if (placements == null) {
            ctx.status(400).result("placements is required");
            return;
        }
        List<Map<String, Object>> items;
        try {
            items = MAPPER.readValue(placements, new TypeReference<List<Map<String, Object>>>() {});
        } catch (IOException exc) {
            ctx.status(400).result("placements must be a JSON array of objects");
            return;
        }
        String password = ctx.formParam("password");
        try (PDDocument doc = openDocument(bytes, password); FontResources fonts = new FontResources()) {
            // flatten=1: drawn for good, no editable copy (before redaction)
            boolean permanent = "1".equals(ctx.formParam("flatten"));
            // kept for editing them again in OpenPDF ...
            setPlacementsJson(doc, permanent ? null : placements);
            // ... and drawn into the pages for every other reader (Cover boxes erase what they cover)
            Map<String, Object> report = EditsLayer.apply(doc, items, fonts, permanent);
            ctx.header("X-Edits-Report", MAPPER.writeValueAsString(report));
            writePdf(ctx, doc);
        } catch (IOException | RuntimeException exc) {
            ctx.status(422).result("Failed to embed placements: " + exc.getMessage());
        }
    }

    private static String getPlacementsJson(PDDocument doc) {
        PDDocumentInformation info = doc.getDocumentInformation();
        if (info == null) {
            return null;
        }
        return info.getCustomMetadataValue(PLACEMENTS_META_KEY);
    }

    private static void setPlacementsJson(PDDocument doc, String json) {
        PDDocumentInformation info = doc.getDocumentInformation();
        if (info == null) {
            info = new PDDocumentInformation();
            doc.setDocumentInformation(info);
        }
        info.setCustomMetadataValue(PLACEMENTS_META_KEY, json);
    }

    private static void writePdf(Context ctx, PDDocument doc) throws IOException {
        ctx.contentType("application/pdf");
        ctx.result(saveBytes(doc));
    }

    /**
     * The document as bytes. A digitally signed document is saved as an
     * incremental update: the signed bytes stay as they were and the changes
     * are appended, so the signatures stay valid (readers show "changed after
     * signing") instead of breaking. Anything else is written anew.
     */
    static byte[] saveBytes(PDDocument doc) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (isSigned(doc) && !doc.isAllSecurityToBeRemoved()) {
            try {
                doc.saveIncremental(out);
                return out.toByteArray();
            } catch (IOException | RuntimeException exc) {
                out.reset(); // a full save then, as before
            }
        }
        doc.save(out);
        return out.toByteArray();
    }

    static boolean isSigned(PDDocument doc) {
        try {
            for (org.apache.pdfbox.pdmodel.interactive.digitalsignature.PDSignature sig : doc.getSignatureDictionaries()) {
                if (sig.getCOSObject().getDictionaryObject(COSName.CONTENTS) != null) {
                    return true;
                }
            }
        } catch (RuntimeException exc) {
            return false;
        }
        return false;
    }

    private static int parseInt(String value, int fallback) {
        if (value == null || value.isBlank()) {
            return fallback;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException exc) {
            return fallback;
        }
    }

    private static float parseFloat(String value, float fallback) {
        if (value == null || value.isBlank()) {
            return fallback;
        }
        try {
            float parsed = Float.parseFloat(value.trim());
            return Float.isFinite(parsed) ? parsed : fallback;
        } catch (NumberFormatException exc) {
            return fallback;
        }
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    /**
     * Replace characters the font cannot draw with "?" so one stray emoji does
     * not fail the whole edit. Line breaks are kept only when multi-line text
     * is drawn line by line.
     */
    static String sanitizeText(PDFont font, String text, boolean keepLineBreaks) {
        String source = keepLineBreaks ? text : text.replaceAll("\\R", " ");
        StringBuilder out = new StringBuilder(source.length());
        source.codePoints().forEach(cp -> {
            String ch = new String(Character.toChars(cp));
            if (cp == '\n' || cp == '\r') {
                out.append(ch);
                return;
            }
            try {
                font.encode(ch);
                out.append(ch);
            } catch (IOException | IllegalArgumentException exc) {
                out.append('?');
            }
        });
        return out.toString();
    }

    static boolean canEncode(PDFont font, String text) {
        try {
            font.encode(text.replaceAll("\\R", ""));
            return true;
        } catch (IOException | IllegalArgumentException exc) {
            return false;
        }
    }

    /**
     * Fonts for one request. Plain Latin text uses Helvetica; anything else
     * (Chinese, accented text outside WinAnsi, ...) uses an embedded CJK
     * TrueType font. The collection file stays open until the PDF is saved,
     * because the font subset is written at save time.
     */
    static final class FontResources implements Closeable {
        private final List<Closeable> open = new ArrayList<>();
        private PDFont cjk;

        PDFont pick(PDDocument doc, String text) throws IOException {
            PDFont helvetica = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
            if (canEncode(helvetica, text)) {
                return helvetica;
            }
            return cjk(doc);
        }

        PDFont cjk(PDDocument doc) throws IOException {
            if (cjk != null) {
                return cjk;
            }
            File file = new File(CJK_FONT_PATH);
            if (!file.isFile()) {
                throw new IOException("No CJK font available at " + CJK_FONT_PATH);
            }
            if (CJK_FONT_PATH.toLowerCase().endsWith(".ttc")) {
                TrueTypeCollection collection = new TrueTypeCollection(file);
                open.add(collection);
                TrueTypeFont[] first = new TrueTypeFont[1];
                collection.processAllFonts(ttf -> {
                    if (first[0] == null) {
                        first[0] = ttf;
                    }
                });
                if (first[0] == null) {
                    throw new IOException("CJK font collection is empty: " + CJK_FONT_PATH);
                }
                cjk = PDType0Font.load(doc, first[0], true);
            } else {
                cjk = PDType0Font.load(doc, file);
            }
            return cjk;
        }

        @Override
        public void close() {
            for (Closeable item : open) {
                try {
                    item.close();
                } catch (IOException ignored) {
                    // nothing useful to do
                }
            }
            open.clear();
        }
    }

    /**
     * Maps between the page as the user sees it and PDF user space.
     *
     * The editor sends coordinates in points, measured from the top-left corner
     * of the page as displayed (after /Rotate, inside the CropBox). PDF user
     * space starts at the bottom-left of the unrotated MediaBox. Content drawn
     * after {@code stream.transform(toUser())} can use "visual" coordinates with
     * the origin at the displayed bottom-left and y pointing up, so the same
     * drawing code works on rotated and cropped pages.
     */
    static final class PageSpace {
        final float cx;
        final float cy;
        final float cw;
        final float ch;
        final int rotation;
        final float vw;
        final float vh;

        PageSpace(PDPage page) {
            PDRectangle crop = page.getCropBox();
            cx = crop.getLowerLeftX();
            cy = crop.getLowerLeftY();
            cw = crop.getWidth();
            ch = crop.getHeight();
            int r = page.getRotation() % 360;
            if (r < 0) {
                r += 360;
            }
            rotation = (Math.round(r / 90f) * 90) % 360;
            boolean swap = rotation == 90 || rotation == 270;
            vw = swap ? ch : cw;
            vh = swap ? cw : ch;
        }

        /** Width and height as displayed; drawing helpers only read the height. */
        PDRectangle visualBox() {
            return new PDRectangle(vw, vh);
        }

        /** Visual space (bottom-left origin, y up) to PDF user space. */
        Matrix toUser() {
            switch (rotation) {
                case 90:
                    return new Matrix(0, 1, -1, 0, cx + cw, cy);
                case 180:
                    return new Matrix(-1, 0, 0, -1, cx + cw, cy + ch);
                case 270:
                    return new Matrix(0, -1, 1, 0, cx, cy + ch);
                default:
                    return new Matrix(1, 0, 0, 1, cx, cy);
            }
        }

        /** A point given from the displayed top-left, in PDF user space. */
        float[] userPoint(float x, float yTop) {
            Point2D.Float p = toUser().transformPoint(x, vh - yTop);
            return new float[] {p.x, p.y};
        }

        /** A rectangle given from the displayed top-left, as a user-space rectangle. */
        PDRectangle userRect(float x, float yTop, float width, float height) {
            float[][] corners = {
                userPoint(x, yTop),
                userPoint(x + width, yTop),
                userPoint(x, yTop + height),
                userPoint(x + width, yTop + height)
            };
            float minX = Float.MAX_VALUE;
            float minY = Float.MAX_VALUE;
            float maxX = -Float.MAX_VALUE;
            float maxY = -Float.MAX_VALUE;
            for (float[] c : corners) {
                minX = Math.min(minX, c[0]);
                minY = Math.min(minY, c[1]);
                maxX = Math.max(maxX, c[0]);
                maxY = Math.max(maxY, c[1]);
            }
            return new PDRectangle(minX, minY, maxX - minX, maxY - minY);
        }

        /** A user-space rectangle as {x, yTop, width, height} on the displayed page. */
        float[] visualRect(PDRectangle rect) {
            AffineTransform inverse;
            try {
                inverse = toUser().createAffineTransform().createInverse();
            } catch (NoninvertibleTransformException exc) {
                return new float[] {rect.getLowerLeftX(), vh - rect.getUpperRightY(), rect.getWidth(), rect.getHeight()};
            }
            float[] src = {
                rect.getLowerLeftX(), rect.getLowerLeftY(),
                rect.getUpperRightX(), rect.getLowerLeftY(),
                rect.getLowerLeftX(), rect.getUpperRightY(),
                rect.getUpperRightX(), rect.getUpperRightY()
            };
            float[] dst = new float[8];
            inverse.transform(src, 0, dst, 0, 4);
            float minX = Float.MAX_VALUE;
            float minY = Float.MAX_VALUE;
            float maxX = -Float.MAX_VALUE;
            float maxY = -Float.MAX_VALUE;
            for (int i = 0; i < 8; i += 2) {
                minX = Math.min(minX, dst[i]);
                maxX = Math.max(maxX, dst[i]);
                minY = Math.min(minY, dst[i + 1]);
                maxY = Math.max(maxY, dst[i + 1]);
            }
            return new float[] {minX, vh - maxY, maxX - minX, maxY - minY};
        }
    }
}
