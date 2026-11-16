package com.pdfgateway;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.http.Context;
import io.javalin.http.UploadedFile;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationRubberStamp;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceDictionary;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceStream;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.PDSignature;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.SignatureInterface;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.SignatureOptions;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
import org.apache.pdfbox.pdmodel.interactive.form.PDSignatureField;
import org.apache.pdfbox.util.Matrix;
import org.bouncycastle.asn1.ASN1EncodableVector;
import org.bouncycastle.asn1.ASN1Primitive;
import org.bouncycastle.asn1.DERSet;
import org.bouncycastle.asn1.cms.Attribute;
import org.bouncycastle.asn1.cms.AttributeTable;
import org.bouncycastle.asn1.cms.CMSAttributes;
import org.bouncycastle.asn1.ess.ESSCertIDv2;
import org.bouncycastle.asn1.ess.SigningCertificateV2;
import org.bouncycastle.asn1.nist.NISTObjectIdentifiers;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.asn1.x500.RDN;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x500.X500NameBuilder;
import org.bouncycastle.asn1.x500.style.BCStyle;
import org.bouncycastle.asn1.x500.style.IETFUtils;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.JcaCertStore;
import org.bouncycastle.cms.CMSAttributeTableGenerator;
import org.bouncycastle.cms.CMSProcessableByteArray;
import org.bouncycastle.cms.CMSSignedData;
import org.bouncycastle.cms.CMSSignedDataGenerator;
import org.bouncycastle.cms.DefaultSignedAttributeTableGenerator;
import org.bouncycastle.cms.SignerInformation;
import org.bouncycastle.cms.SignerInformationStore;
import org.bouncycastle.cms.jcajce.JcaSignerInfoGeneratorBuilder;
import org.bouncycastle.cms.jcajce.JcaSimpleSignerInfoVerifierBuilder;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.bouncycastle.operator.jcajce.JcaDigestCalculatorProviderBuilder;
import org.bouncycastle.tsp.TSPAlgorithms;
import org.bouncycastle.tsp.TimeStampRequest;
import org.bouncycastle.tsp.TimeStampRequestGenerator;
import org.bouncycastle.tsp.TimeStampResponse;
import org.bouncycastle.tsp.TimeStampToken;

import java.awt.geom.AffineTransform;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.UnrecoverableKeyException;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Collection;
import java.util.Date;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

/**
 * Signatures: picture signatures stamped on pages, and digital (certificate)
 * signatures that are written with an incremental save and can be verified.
 */
final class Signatures {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    /** Room for the CMS blob: certificate chain + optional time stamp token. */
    private static final int SIGNATURE_SIZE = 32 * 1024;

    private Signatures() {
    }

    /** A message meant for the user, passed through the gateway as is. */
    static final class UserError extends IOException {
        UserError(String message) {
            super(message);
        }
    }

    private static void fail(Context ctx, int status, String message) {
        ctx.status(status).json(Map.of("detail", "USER:" + message));
    }

    // ------------------------------------------------------------ picture signatures

    /**
     * Several images on several pages in one go. Form fields: file, image0..imageN,
     * placements (JSON list of {page, x, y, width, height, image}) in points from the
     * displayed top-left of the page, and mode: "flatten" (drawn into the page) or
     * "annotation" (a stamp annotation that other editors can still move or delete).
     */
    static void stampImages(Context ctx) throws IOException {
        UploadedFile file = ctx.uploadedFile("file");
        if (file == null) {
            ctx.status(400).result("Missing file field");
            return;
        }
        byte[] bytes = file.content().readAllBytes();
        List<Map<String, Object>> placements;
        try {
            placements = MAPPER.readValue(
                    ctx.formParam("placements"), new TypeReference<List<Map<String, Object>>>() {});
        } catch (Exception exc) {
            ctx.status(400).result("placements must be a JSON list");
            return;
        }
        boolean annotation = "annotation".equalsIgnoreCase(ctx.formParam("mode"));
        String password = ctx.formParam("password");
        try (PDDocument doc = openDocument(bytes, password)) {
            Map<Integer, PDImageXObject> images = new HashMap<>();
            int count = 0;
            for (Map<String, Object> item : placements) {
                int pageIndex = num(item.get("page"), -1).intValue();
                if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                    ctx.status(400).result("page out of range");
                    return;
                }
                int imageIndex = num(item.get("image"), 0).intValue();
                PDImageXObject image = images.get(imageIndex);
                if (image == null) {
                    UploadedFile upload = ctx.uploadedFile("image" + imageIndex);
                    if (upload == null) {
                        ctx.status(400).result("Missing image" + imageIndex);
                        return;
                    }
                    image = PDImageXObject.createFromByteArray(
                            doc, upload.content().readAllBytes(), "signature" + imageIndex);
                    images.put(imageIndex, image);
                }
                float x = num(item.get("x"), 0).floatValue();
                float y = num(item.get("y"), 0).floatValue();
                float w = num(item.get("width"), 120).floatValue();
                float h = num(item.get("height"), 48).floatValue();
                if (!(w > 0) || !(h > 0)) {
                    continue;
                }
                PDPage page = doc.getPage(pageIndex);
                PdfboxServer.PageSpace space = new PdfboxServer.PageSpace(page);
                if (annotation) {
                    addStampAnnotation(doc, page, space, image, x, y, w, h);
                } else {
                    try (PDPageContentStream stream = new PDPageContentStream(
                            doc, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
                        stream.transform(space.toUser());
                        stream.drawImage(image, x, space.vh - y - h, w, h);
                    }
                }
                count++;
            }
            ctx.header("X-Stamped-Count", String.valueOf(count));
            ctx.contentType("application/pdf");
            ctx.result(PdfboxServer.saveBytes(doc)); // incremental on a signed document
        } catch (IOException exc) {
            ctx.status(422).result("Failed to place signature: " + exc.getMessage());
        }
    }

    private static void addStampAnnotation(
            PDDocument doc, PDPage page, PdfboxServer.PageSpace space, PDImageXObject image,
            float x, float y, float w, float h) throws IOException {
        PDAnnotationRubberStamp stamp = new PDAnnotationRubberStamp();
        stamp.setRectangle(space.userRect(x, y, w, h));
        stamp.setContents("Signature");
        stamp.setPrinted(true);
        stamp.getCOSObject().setString(COSName.getPDFName("OpenPDFKind"), "signature");
        PDAppearanceStream appearance = new PDAppearanceStream(doc);
        appearance.setBBox(new PDRectangle(w, h));
        appearance.setMatrix(rotationOnly(space));
        appearance.setResources(new PDResources());
        try (PDPageContentStream cs = new PDPageContentStream(doc, appearance)) {
            cs.drawImage(image, 0, 0, w, h);
        }
        PDAppearanceDictionary dict = new PDAppearanceDictionary();
        dict.setNormalAppearance(appearance);
        stamp.setAppearance(dict);
        page.getAnnotations().add(stamp);
    }

    /** The page rotation part of visual-to-user space, for appearance streams. */
    private static AffineTransform rotationOnly(PdfboxServer.PageSpace space) {
        AffineTransform at = space.toUser().createAffineTransform();
        return new AffineTransform(at.getScaleX(), at.getShearY(), at.getShearX(), at.getScaleY(), 0, 0);
    }

    private static Number num(Object value, Number fallback) {
        if (value instanceof Number n) {
            return n;
        }
        if (value instanceof String s && !s.isBlank()) {
            try {
                return Double.parseDouble(s);
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    private static PDDocument openDocument(byte[] bytes, String password) throws IOException {
        if (password != null && !password.isBlank()) {
            return Loader.loadPDF(bytes, password);
        }
        return Loader.loadPDF(bytes);
    }

    // ------------------------------------------------------------ digital signatures

    private record Credentials(PrivateKey key, Certificate[] chain, X509Certificate cert) {
    }

    private static Credentials loadCredentials(byte[] p12, String password) throws IOException {
        char[] pw = password == null ? new char[0] : password.toCharArray();
        KeyStore store;
        try {
            store = KeyStore.getInstance("PKCS12");
            store.load(new ByteArrayInputStream(p12), pw);
        } catch (IOException exc) {
            if (exc.getCause() instanceof UnrecoverableKeyException
                    || String.valueOf(exc.getMessage()).toLowerCase().contains("password")) {
                throw new UserError("Wrong certificate password");
            }
            throw new UserError("Cannot read the certificate; use a .p12 or .pfx file");
        } catch (GeneralSecurityException exc) {
            throw new UserError("Cannot read the certificate; use a .p12 or .pfx file");
        }
        try {
            Enumeration<String> aliases = store.aliases();
            while (aliases.hasMoreElements()) {
                String alias = aliases.nextElement();
                if (!store.isKeyEntry(alias)) {
                    continue;
                }
                PrivateKey key = (PrivateKey) store.getKey(alias, pw);
                Certificate[] chain = store.getCertificateChain(alias);
                if (key != null && chain != null && chain.length > 0 && chain[0] instanceof X509Certificate cert) {
                    return new Credentials(key, chain, cert);
                }
            }
        } catch (UnrecoverableKeyException exc) {
            throw new UserError("Wrong certificate password");
        } catch (GeneralSecurityException exc) {
            throw new UserError("The private key in the certificate cannot be used: " + exc.getMessage());
        }
        throw new UserError("The certificate file has no private key, so it cannot sign");
    }

    private static String commonName(X500Name name) {
        RDN[] cn = name.getRDNs(BCStyle.CN);
        if (cn.length > 0) {
            return IETFUtils.valueToString(cn[0].getFirst().getValue());
        }
        return name.toString();
    }

    private static String commonName(X509Certificate cert) {
        return commonName(X500Name.getInstance(cert.getSubjectX500Principal().getEncoded()));
    }

    private static String field(X509Certificate cert, org.bouncycastle.asn1.ASN1ObjectIdentifier oid) {
        RDN[] rdns = X500Name.getInstance(cert.getSubjectX500Principal().getEncoded()).getRDNs(oid);
        return rdns.length > 0 ? IETFUtils.valueToString(rdns[0].getFirst().getValue()) : "";
    }

    /** Information about a certificate file, so the user can check it is the right one. */
    static void certInfo(Context ctx) throws IOException {
        UploadedFile certFile = ctx.uploadedFile("cert");
        if (certFile == null) {
            fail(ctx, 400, "Provide a certificate file");
            return;
        }
        try {
            Credentials creds = loadCredentials(certFile.content().readAllBytes(), ctx.formParam("certPassword"));
            ctx.json(describeCert(creds.cert()));
        } catch (UserError exc) {
            fail(ctx, 400, exc.getMessage());
        }
    }

    private static Map<String, Object> describeCert(X509Certificate cert) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("name", commonName(cert));
        info.put("email", field(cert, BCStyle.EmailAddress));
        info.put("organization", field(cert, BCStyle.O));
        info.put("issuer", commonName(X500Name.getInstance(cert.getIssuerX500Principal().getEncoded())));
        info.put("selfSigned", cert.getSubjectX500Principal().equals(cert.getIssuerX500Principal()));
        info.put("notBefore", iso(cert.getNotBefore()));
        info.put("notAfter", iso(cert.getNotAfter()));
        Date now = new Date();
        info.put("currentlyValid", !now.before(cert.getNotBefore()) && !now.after(cert.getNotAfter()));
        return info;
    }

    private static String iso(Date date) {
        if (date == null) {
            return null;
        }
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX");
        return fmt.format(date);
    }

    /**
     * Sign with a PKCS#12 certificate (PAdES, ETSI.CAdES.detached). The result is
     * the original file plus an incremental update, so earlier signatures stay valid.
     * Form fields: file, cert, certPassword, reason, location, contact, fieldName,
     * visible, pageIndex, x, y, width, height (visual points), image, tsaUrl.
     */
    static void digitalSign(Context ctx) throws IOException {
        UploadedFile file = ctx.uploadedFile("file");
        UploadedFile certFile = ctx.uploadedFile("cert");
        if (file == null) {
            ctx.status(400).result("Missing file field");
            return;
        }
        if (certFile == null) {
            fail(ctx, 400, "Provide a certificate file");
            return;
        }
        byte[] bytes = file.content().readAllBytes();
        try {
            Credentials creds = loadCredentials(certFile.content().readAllBytes(), ctx.formParam("certPassword"));
            Date now = new Date();
            if (now.after(creds.cert().getNotAfter())) {
                throw new UserError("The certificate has expired (valid until " + new SimpleDateFormat("yyyy-MM-dd").format(creds.cert().getNotAfter()) + ")");
            }
            if (now.before(creds.cert().getNotBefore())) {
                throw new UserError("The certificate is not valid yet");
            }
            String tsaUrl = blankToNull(ctx.formParam("tsaUrl"));
            byte[] signed = sign(bytes, ctx.formParam("password"), creds, new SignRequest(
                    blankToNull(ctx.formParam("reason")),
                    blankToNull(ctx.formParam("location")),
                    blankToNull(ctx.formParam("contact")),
                    blankToNull(ctx.formParam("fieldName")),
                    "1".equals(ctx.formParam("visible")) || "true".equalsIgnoreCase(ctx.formParam("visible")),
                    intParam(ctx.formParam("pageIndex"), 0),
                    floatParam(ctx.formParam("x"), 72f),
                    floatParam(ctx.formParam("y"), 72f),
                    floatParam(ctx.formParam("width"), 200f),
                    floatParam(ctx.formParam("height"), 60f),
                    ctx.uploadedFile("image") == null ? null : ctx.uploadedFile("image").content().readAllBytes(),
                    tsaUrl));
            ctx.contentType("application/pdf");
            ctx.result(signed);
        } catch (UserError exc) {
            fail(ctx, 400, exc.getMessage());
        } catch (IOException exc) {
            ctx.status(422).result("Failed to sign PDF: " + exc.getMessage());
        }
    }

    private record SignRequest(
            String reason, String location, String contact, String fieldName, boolean visible,
            int pageIndex, float x, float y, float width, float height, byte[] image, String tsaUrl) {
    }

    private static int intParam(String value, int fallback) {
        return num(value, fallback).intValue();
    }

    private static float floatParam(String value, float fallback) {
        float v = num(value, fallback).floatValue();
        return Float.isFinite(v) ? v : fallback;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static byte[] sign(byte[] bytes, String password, Credentials creds, SignRequest req) throws IOException {
        try (PDDocument doc = openDocument(bytes, password)) {
            PDSignature signature = new PDSignature();
            signature.setFilter(PDSignature.FILTER_ADOBE_PPKLITE);
            signature.setSubFilter(COSName.getPDFName("ETSI.CAdES.detached"));
            signature.setName(commonName(creds.cert()));
            if (req.reason() != null) {
                signature.setReason(req.reason());
            }
            if (req.location() != null) {
                signature.setLocation(req.location());
            }
            if (req.contact() != null) {
                signature.setContactInfo(req.contact());
            }
            Calendar signDate = Calendar.getInstance();
            signature.setSignDate(signDate);

            int pageIndex = req.pageIndex();
            PDRectangle userRect = null;
            PdfboxServer.PageSpace space = null;
            float vw = req.width();
            float vh = req.height();
            PDSignatureField existing = req.fieldName() == null ? null : findEmptySignatureField(doc, req.fieldName());
            if (req.fieldName() != null && existing == null) {
                throw new UserError("Signature field '" + req.fieldName() + "' does not exist or is already signed");
            }
            if (existing != null) {
                PDAnnotationWidget widget = existing.getWidgets().get(0);
                PDPage page = widget.getPage();
                pageIndex = page != null ? doc.getPages().indexOf(page) : findWidgetPage(doc, widget);
                if (pageIndex < 0) {
                    throw new UserError("Cannot find the page of the signature field");
                }
                space = new PdfboxServer.PageSpace(doc.getPage(pageIndex));
                userRect = widget.getRectangle();
                boolean swap = space.rotation == 90 || space.rotation == 270;
                vw = swap ? userRect.getHeight() : userRect.getWidth();
                vh = swap ? userRect.getWidth() : userRect.getHeight();
                existing.getCOSObject().setItem(COSName.V, signature);
            } else if (req.visible()) {
                if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                    throw new UserError("Page number is outside the document");
                }
                space = new PdfboxServer.PageSpace(doc.getPage(pageIndex));
                userRect = space.userRect(req.x(), req.y(), req.width(), req.height());
            }

            SignatureOptions options = new SignatureOptions();
            // contents are hex in the file: twice this size; a time stamp token needs more room
            options.setPreferredSignatureSize(req.tsaUrl() == null ? SIGNATURE_SIZE / 2 : SIGNATURE_SIZE);
            try {
                if (userRect != null) {
                    List<String> lines = new ArrayList<>();
                    lines.add("Digitally signed by " + commonName(creds.cert()));
                    SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z");
                    lines.add("Date: " + fmt.format(signDate.getTime()));
                    if (req.reason() != null) {
                        lines.add("Reason: " + req.reason());
                    }
                    if (req.location() != null) {
                        lines.add("Location: " + req.location());
                    }
                    options.setVisualSignature(visualTemplate(
                            doc, pageIndex, userRect, vw, vh, rotationOnly(space), req.image(), lines));
                    options.setPage(pageIndex);
                }
                doc.addSignature(signature, content -> cmsSign(content, creds, req.tsaUrl()), options);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                doc.saveIncremental(out);
                return out.toByteArray();
            } finally {
                options.close();
            }
        }
    }

    private static PDSignatureField findEmptySignatureField(PDDocument doc, String name) {
        PDAcroForm form = doc.getDocumentCatalog().getAcroForm(null);
        if (form == null) {
            return null;
        }
        PDField field = form.getField(name);
        if (field instanceof PDSignatureField sig && sig.getSignature() == null && !sig.getWidgets().isEmpty()) {
            return sig;
        }
        return null;
    }

    private static int findWidgetPage(PDDocument doc, PDAnnotationWidget widget) throws IOException {
        for (int i = 0; i < doc.getNumberOfPages(); i++) {
            for (PDAnnotation ann : doc.getPage(i).getAnnotations()) {
                if (ann.getCOSObject() == widget.getCOSObject()) {
                    return i;
                }
            }
        }
        return -1;
    }

    /**
     * A one-page document holding just the signature widget and its look: the
     * signature picture (if any) on the left, name and date on the right. PDFBox
     * copies the widget appearance from it into the signed file.
     */
    private static InputStream visualTemplate(
            PDDocument src, int pageIndex, PDRectangle userRect, float w, float h, AffineTransform rot,
            byte[] imageBytes, List<String> lines) throws IOException {
        try (PDDocument doc = new PDDocument();
             PdfboxServer.FontResources fonts = new PdfboxServer.FontResources()) {
            PDPage srcPage = src.getPage(pageIndex);
            PDPage page = new PDPage(srcPage.getMediaBox());
            page.setRotation(srcPage.getRotation());
            doc.addPage(page);
            PDAcroForm acroForm = new PDAcroForm(doc);
            doc.getDocumentCatalog().setAcroForm(acroForm);
            PDSignatureField field = new PDSignatureField(acroForm);
            PDAnnotationWidget widget = field.getWidgets().get(0);
            acroForm.setSignaturesExist(true);
            acroForm.setAppendOnly(true);
            acroForm.getCOSObject().setDirect(true);
            acroForm.getFields().add(field);
            widget.setRectangle(userRect);

            PDStream stream = new PDStream(doc);
            PDFormXObject form = new PDFormXObject(stream);
            form.setResources(new PDResources());
            form.setFormType(1);
            form.setBBox(new PDRectangle(w, h));
            form.setMatrix(rot);
            PDAppearanceDictionary appearance = new PDAppearanceDictionary();
            appearance.getCOSObject().setDirect(true);
            PDAppearanceStream appearanceStream = new PDAppearanceStream(form.getCOSObject());
            appearance.setNormalAppearance(appearanceStream);
            widget.setAppearance(appearance);

            try (PDPageContentStream cs = new PDPageContentStream(doc, appearanceStream)) {
                float pad = Math.min(4f, Math.min(w, h) * 0.06f);
                float textLeft = pad;
                if (imageBytes != null && imageBytes.length > 0) {
                    PDImageXObject image = PDImageXObject.createFromByteArray(doc, imageBytes, "signature");
                    float areaW = w * 0.45f - pad * 1.5f;
                    float areaH = h - pad * 2;
                    float ratio = Math.min(areaW / image.getWidth(), areaH / image.getHeight());
                    float iw = image.getWidth() * ratio;
                    float ih = image.getHeight() * ratio;
                    cs.drawImage(image, pad + (areaW - iw) / 2, pad + (areaH - ih) / 2, iw, ih);
                    textLeft = w * 0.45f + pad / 2;
                }
                PDFont font = fonts.cjk(doc);
                float textW = w - textLeft - pad;
                float size = Math.min(10f, (h - pad * 2) / (lines.size() * 1.3f));
                for (String line : lines) {
                    float lineW = font.getStringWidth(line) / 1000f * size;
                    if (lineW > textW && lineW > 0) {
                        size = Math.min(size, size * textW / lineW);
                    }
                }
                size = Math.max(size, 3f);
                float lead = size * 1.3f;
                float blockH = lead * lines.size();
                float yTop = h - Math.max(pad, (h - blockH) / 2) - size;
                cs.setNonStrokingColor(0.1f, 0.15f, 0.3f);
                for (int i = 0; i < lines.size(); i++) {
                    cs.beginText();
                    cs.setFont(font, size);
                    cs.newLineAtOffset(textLeft, yTop - i * lead);
                    cs.showText(lines.get(i));
                    cs.endText();
                }
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            doc.save(out);
            return new ByteArrayInputStream(out.toByteArray());
        }
    }

    /** Detached CMS (CAdES) signature over the byte ranges PDFBox hands over. */
    private static byte[] cmsSign(InputStream content, Credentials creds, String tsaUrl) throws IOException {
        try {
            X509Certificate cert = creds.cert();
            String keyAlg = creds.key().getAlgorithm();
            String sigAlg = "EC".equalsIgnoreCase(keyAlg) || "ECDSA".equalsIgnoreCase(keyAlg)
                    ? "SHA256withECDSA" : "SHA256withRSA";
            ContentSigner signer = new JcaContentSignerBuilder(sigAlg).build(creds.key());

            // signing-certificate-v2: required by PAdES so the certificate can't be swapped
            byte[] certHash = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            ESSCertIDv2 certId = new ESSCertIDv2(new AlgorithmIdentifier(NISTObjectIdentifiers.id_sha256), certHash);
            ASN1EncodableVector signedAttrs = new ASN1EncodableVector();
            signedAttrs.add(new Attribute(PKCSObjectIdentifiers.id_aa_signingCertificateV2,
                    new DERSet(new SigningCertificateV2(new ESSCertIDv2[] {certId}))));
            CMSAttributeTableGenerator attrGen = new DefaultSignedAttributeTableGenerator(new AttributeTable(signedAttrs)) {
                @Override
                public AttributeTable getAttributes(@SuppressWarnings("rawtypes") Map params) {
                    // PAdES keeps the time in the signature dictionary (/M), not here
                    return super.getAttributes(params).remove(CMSAttributes.signingTime);
                }
            };

            CMSSignedDataGenerator gen = new CMSSignedDataGenerator();
            gen.addSignerInfoGenerator(new JcaSignerInfoGeneratorBuilder(new JcaDigestCalculatorProviderBuilder().build())
                    .setSignedAttributeGenerator(attrGen)
                    .build(signer, cert));
            gen.addCertificates(new JcaCertStore(Arrays.asList(creds.chain())));
            CMSSignedData signed = gen.generate(new CMSProcessableByteArray(content.readAllBytes()), false);
            if (tsaUrl != null) {
                signed = addTimeStamp(signed, tsaUrl);
            }
            return signed.getEncoded();
        } catch (UserError exc) {
            throw exc;
        } catch (Exception exc) {
            throw new IOException("signing failed: " + exc.getMessage(), exc);
        }
    }

    private static CMSSignedData addTimeStamp(CMSSignedData signed, String tsaUrl) throws Exception {
        SignerInformation signerInfo = signed.getSignerInfos().getSigners().iterator().next();
        byte[] imprint = MessageDigest.getInstance("SHA-256").digest(signerInfo.getSignature());
        TimeStampRequestGenerator reqGen = new TimeStampRequestGenerator();
        reqGen.setCertReq(true);
        TimeStampRequest request = reqGen.generate(TSPAlgorithms.SHA256, imprint, new BigInteger(64, new SecureRandom()));
        byte[] body = request.getEncoded();
        byte[] answer;
        try {
            HttpURLConnection conn = (HttpURLConnection) URI.create(tsaUrl).toURL().openConnection();
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(20_000);
            conn.setDoOutput(true);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/timestamp-query");
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body);
            }
            if (conn.getResponseCode() != 200) {
                throw new UserError("The timestamp server returned an error (HTTP " + conn.getResponseCode() + ")");
            }
            try (InputStream in = conn.getInputStream()) {
                answer = in.readAllBytes();
            }
        } catch (UserError exc) {
            throw exc;
        } catch (IOException | IllegalArgumentException exc) {
            throw new UserError("Cannot reach the timestamp server: " + exc.getMessage());
        }
        TimeStampResponse response = new TimeStampResponse(answer);
        response.validate(request);
        TimeStampToken token = response.getTimeStampToken();
        if (token == null) {
            throw new UserError("The timestamp server refused the request: " + response.getStatusString());
        }
        ASN1EncodableVector unsigned = new ASN1EncodableVector();
        AttributeTable existing = signerInfo.getUnsignedAttributes();
        if (existing != null) {
            unsigned = existing.toASN1EncodableVector();
        }
        unsigned.add(new Attribute(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken,
                new DERSet(ASN1Primitive.fromByteArray(token.getEncoded()))));
        SignerInformation stamped = SignerInformation.replaceUnsignedAttributes(signerInfo, new AttributeTable(unsigned));
        return CMSSignedData.replaceSigners(signed, new SignerInformationStore(stamped));
    }

    // ------------------------------------------------------------ verification

    /** Every signature in the file: who, when, and whether the signed bytes are intact. */
    static void verify(Context ctx) throws IOException {
        UploadedFile file = ctx.uploadedFile("file");
        if (file == null) {
            ctx.status(400).result("Missing file field");
            return;
        }
        byte[] bytes = file.content().readAllBytes();
        List<Map<String, Object>> result = new ArrayList<>();
        try (PDDocument doc = openDocument(bytes, ctx.formParam("password"))) {
            List<PDSignature> sigs = doc.getSignatureDictionaries();
            Map<PDSignature, String> fieldNames = new HashMap<>();
            Map<PDSignature, Integer> pages = new HashMap<>();
            PDAcroForm form = doc.getDocumentCatalog().getAcroForm(null);
            if (form != null) {
                for (PDField f : form.getFieldTree()) {
                    if (f instanceof PDSignatureField sf && sf.getSignature() != null) {
                        for (PDSignature s : sigs) {
                            if (s.getCOSObject() == sf.getSignature().getCOSObject()) {
                                fieldNames.put(s, sf.getFullyQualifiedName());
                                if (!sf.getWidgets().isEmpty()) {
                                    PDAnnotationWidget w = sf.getWidgets().get(0);
                                    int idx = w.getPage() != null ? doc.getPages().indexOf(w.getPage()) : findWidgetPage(doc, w);
                                    if (idx >= 0) {
                                        pages.put(s, idx);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            for (PDSignature sig : sigs) {
                result.add(describeSignature(sig, bytes, fieldNames.get(sig), pages.get(sig)));
            }
        } catch (IOException exc) {
            ctx.status(422).result("Failed to read signatures: " + exc.getMessage());
            return;
        }
        ctx.json(Map.of("signatures", result, "fileLength", bytes.length));
    }

    private static Map<String, Object> describeSignature(
            PDSignature sig, byte[] pdf, String fieldName, Integer page) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("field", fieldName);
        item.put("page", page);
        item.put("name", sig.getName());
        item.put("reason", sig.getReason());
        item.put("location", sig.getLocation());
        item.put("contact", sig.getContactInfo());
        item.put("signDate", sig.getSignDate() == null ? null : iso(sig.getSignDate().getTime()));
        item.put("subFilter", sig.getSubFilter());
        int[] range = sig.getByteRange();
        boolean wholeFile = range != null && range.length == 4 && (long) range[2] + range[3] == pdf.length;
        item.put("coversWholeFile", wholeFile);
        item.put("signedLength", range != null && range.length == 4 ? (long) range[2] + range[3] : null);
        String sub = sig.getSubFilter();
        if (sub == null || !(sub.equals("adbe.pkcs7.detached") || sub.equals("ETSI.CAdES.detached"))) {
            item.put("status", "unsupported");
            item.put("message", "This signature format cannot be verified (" + sub + ")");
            return item;
        }
        try {
            byte[] contents = sig.getContents();
            byte[] signedContent = sig.getSignedContent(pdf);
            CMSSignedData cms = new CMSSignedData(new CMSProcessableByteArray(signedContent), contents);
            SignerInformation signer = cms.getSignerInfos().getSigners().iterator().next();
            @SuppressWarnings("unchecked")
            Collection<X509CertificateHolder> matches = cms.getCertificates().getMatches(signer.getSID());
            if (matches.isEmpty()) {
                item.put("status", "invalid");
                item.put("message", "The signature does not contain the signer's certificate");
                return item;
            }
            X509CertificateHolder holder = matches.iterator().next();
            X509Certificate cert = new JcaX509CertificateConverter().getCertificate(holder);
            boolean ok = signer.verify(new JcaSimpleSignerInfoVerifierBuilder().build(holder));
            item.put("certificate", describeCert(cert));
            if (item.get("name") == null) {
                item.put("name", commonName(cert));
            }
            Date when = sig.getSignDate() == null ? null : sig.getSignDate().getTime();
            AttributeTable unsigned = signer.getUnsignedAttributes();
            if (unsigned != null) {
                Attribute ts = unsigned.get(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken);
                if (ts != null) {
                    TimeStampToken token = new TimeStampToken(
                            new org.bouncycastle.cms.CMSSignedData(ts.getAttrValues().getObjectAt(0).toASN1Primitive().getEncoded()));
                    when = token.getTimeStampInfo().getGenTime();
                    item.put("timeStamped", true);
                    item.put("timeStampDate", iso(when));
                }
            }
            boolean certValidThen = when == null
                    || (!when.before(cert.getNotBefore()) && !when.after(cert.getNotAfter()));
            item.put("certValidAtSigning", certValidThen);
            boolean selfSigned = cert.getSubjectX500Principal().equals(cert.getIssuerX500Principal());
            if (!ok) {
                item.put("status", "invalid");
                item.put("message", "Invalid: the document was changed after signing, or the signature is damaged");
            } else if (!certValidThen) {
                item.put("status", "warning");
                item.put("message", "Intact, but the certificate was not valid at signing time");
            } else if (selfSigned) {
                item.put("status", "untrusted");
                item.put("message", "Intact and unchanged; the certificate is self-signed, so the signer's identity is not confirmed");
            } else {
                item.put("status", "valid");
                item.put("message", "Intact and unchanged (certificate issued by "
                        + ((Map<?, ?>) item.get("certificate")).get("issuer") + "; revocation not checked online)");
            }
        } catch (Exception exc) {
            item.put("status", "invalid");
            item.put("message", "Cannot verify the signature: " + exc.getMessage());
        }
        return item;
    }

    // ------------------------------------------------------------ certificates

    /** A self-signed certificate for personal use, returned as a password-protected .p12. */
    static void generateCert(Context ctx) throws IOException {
        String name = blankToNull(ctx.formParam("name"));
        String password = ctx.formParam("certPassword");
        if (name == null) {
            fail(ctx, 400, "Enter a name");
            return;
        }
        if (password == null || password.length() < 4) {
            fail(ctx, 400, "The certificate password needs at least 4 characters");
            return;
        }
        int years = Math.max(1, Math.min(10, intParam(ctx.formParam("years"), 3)));
        try {
            KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
            kpg.initialize(2048, new SecureRandom());
            KeyPair pair = kpg.generateKeyPair();
            X500NameBuilder nb = new X500NameBuilder(BCStyle.INSTANCE);
            nb.addRDN(BCStyle.CN, name);
            String org = blankToNull(ctx.formParam("organization"));
            if (org != null) {
                nb.addRDN(BCStyle.O, org);
            }
            String email = blankToNull(ctx.formParam("email"));
            if (email != null) {
                nb.addRDN(BCStyle.EmailAddress, email);
            }
            X500Name subject = nb.build();
            Calendar from = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
            from.add(Calendar.MINUTE, -5);
            Calendar to = (Calendar) from.clone();
            to.add(Calendar.YEAR, years);
            JcaX509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                    subject, new BigInteger(64, new SecureRandom()).abs().add(BigInteger.ONE),
                    from.getTime(), to.getTime(), subject, pair.getPublic());
            builder.addExtension(Extension.basicConstraints, true, new BasicConstraints(false));
            builder.addExtension(Extension.keyUsage, true,
                    new KeyUsage(KeyUsage.digitalSignature | KeyUsage.nonRepudiation));
            X509Certificate cert = new JcaX509CertificateConverter().getCertificate(
                    builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(pair.getPrivate())));
            KeyStore store = KeyStore.getInstance("PKCS12");
            store.load(null, null);
            store.setKeyEntry("openpdf", pair.getPrivate(), password.toCharArray(), new Certificate[] {cert});
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            store.store(out, password.toCharArray());
            ctx.contentType("application/x-pkcs12");
            ctx.result(out.toByteArray());
        } catch (Exception exc) {
            ctx.status(500).result("Failed to create certificate: " + exc.getMessage());
        }
    }
}
