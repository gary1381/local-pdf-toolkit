// Digital signatures (the Java service's Signatures): make a personal
// certificate (generate-cert), read one (cert-info), sign (digital-sign, PAdES
// via LibPDF) and verify (verify-signatures, CMS via PKI.js).

import { HttpTimestampAuthority, P12Signer, PdfDict, PdfStream, PdfString } from "@libpdf/core";
import forge from "node-forge";
import * as pkijs from "pkijs";
import * as asn1js from "asn1js";
import { bytes, HttpError, json } from "../http.js";
import { openPdf, pdfError } from "../libs.js";
import { annotsOf, name, numbers, obj, resolve, str } from "../pdfobj.js";
import { loadDocument, mutate } from "../session.js";
import { pageSpace } from "../space.js";
import { Face } from "../textdraw.js";
import { embedImage, readImage } from "./images.js";

const MAX_CERT = 1024 * 1024;

// ---------------------------------------------------------------- certificates

/** "yyyy-MM-dd'T'HH:mm:ssXXX" in this computer's time zone, as the Java service writes dates. */
export function isoLocal(date) {
  const pad = (v) => String(Math.floor(Math.abs(v))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const zone = offset === 0 ? "Z" : `${offset > 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}

function binary(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return s;
}

function attribute(attrs, short) {
  const found = attrs.find((a) => a.shortName === short || a.name === short);
  return found ? String(found.value) : "";
}

/** What the editor shows about a certificate (DER bytes). */
export function certificateInfo(der) {
  const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(binary(der)));
  const subject = cert.subject.attributes;
  const issuer = cert.issuer.attributes;
  const now = new Date();
  return {
    name: attribute(subject, "CN") || cert.subject.attributes.map((a) => `${a.shortName || a.name}=${a.value}`).join(", "),
    email: attribute(subject, "E") || attribute(subject, "emailAddress"),
    organization: attribute(subject, "O"),
    issuer: attribute(issuer, "CN") || issuer.map((a) => `${a.shortName || a.name}=${a.value}`).join(", "),
    selfSigned: cert.subject.hash === cert.issuer.hash,
    notBefore: isoLocal(cert.validity.notBefore),
    notAfter: isoLocal(cert.validity.notAfter),
    currentlyValid: now >= cert.validity.notBefore && now <= cert.validity.notAfter,
  };
}

async function readCertFile(form) {
  const file = form.file("cert");
  if (!file) throw new HttpError(400, "Provide a certificate file");
  if (file.size === 0) throw new HttpError(400, "The certificate file is empty");
  if (file.size > MAX_CERT) throw new HttpError(413, "The certificate file is too large");
  return new Uint8Array(await file.arrayBuffer());
}

/** The signer of a .p12 / .pfx, with the Java service's messages for what can go wrong. */
async function loadSigner(p12, password) {
  try {
    return await P12Signer.create(p12, password ?? "");
  } catch (err) {
    const text = String(err?.message || err).toLowerCase();
    if (/password|mac|decrypt|integrity/.test(text)) throw new HttpError(400, "Wrong certificate password");
    if (/no private key|private key not found|no key/.test(text)) throw new HttpError(400, "The certificate file has no private key, so it cannot sign");
    if (/private key|unsupported key|key type/.test(text)) throw new HttpError(400, `The private key in the certificate cannot be used: ${err.message}`);
    throw new HttpError(400, "Cannot read the certificate; use a .p12 or .pfx file");
  }
}

export async function certInfo(req) {
  const signer = await loadSigner(await readCertFile(req.form), req.form.get("cert_password"));
  return json(certificateInfo(signer.certificate));
}

export async function generateCert(req) {
  const name = req.form.get("name").trim().slice(0, 100);
  if (!name) throw new HttpError(400, "Enter a name");
  const email = req.form.get("email").trim().slice(0, 200);
  const organization = req.form.get("organization").trim().slice(0, 200);
  const password = req.form.get("cert_password", null);
  if (password === null) throw new HttpError(422, "Invalid request parameters: cert_password");
  if (password.length < 4) throw new HttpError(400, "The certificate password needs at least 4 characters");
  const years = Math.min(10, Math.max(1, req.form.int("years", 3)));

  // the key from the browser's own cryptography (fast), the certificate and the .p12 from forge
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privateKey = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(binary(pkcs8))); // PKCS#8 PrivateKeyInfo
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  const serial = new Uint8Array(8);
  crypto.getRandomValues(serial);
  serial[0] &= 0x7f;
  cert.serialNumber = `00${Array.from(serial, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [{ shortName: "CN", value: name }];
  if (organization) attrs.push({ shortName: "O", value: organization });
  if (email) attrs.push({ name: "emailAddress", value: email });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true, critical: true },
  ]);
  cert.sign(privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], password, {
    algorithm: "aes256", friendlyName: "openpdf", generateLocalKeyId: true,
  });
  const der = forge.asn1.toDer(p12).getBytes();
  return bytes(Uint8Array.from(der, (c) => c.charCodeAt(0)), "application/x-pkcs12");
}

// ---------------------------------------------------------------- signing

function fmtDate(date) {
  const pad = (v) => String(Math.floor(Math.abs(v))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset >= 0 ? "+" : "-"}${pad(offset / 60)}${pad(offset % 60)}`;
}

/** The visible signature (Signatures.visualTemplate): picture on the left, the signer's lines on the right. */
async function appearance(pdf, { w, h, matrix, signerName, date, reason, location, image }) {
  const pad = Math.min(4, Math.min(w, h) * 0.06);
  const lines = [`Digitally signed by ${signerName}`, `Date: ${fmtDate(date)}`];
  if (reason) lines.push(`Reason: ${reason}`);
  if (location) lines.push(`Location: ${location}`);
  // Helvetica when it can show the lines (a CJK font embedded by the signing save would be whole)
  const { face } = await Face.for(pdf, lines.join(" "), "");
  let content = "";
  const resources = { Font: { F0: face.ref } };
  let textLeft = pad;
  if (image) {
    const areaW = 0.45 * w - 1.5 * pad;
    const areaH = h - 2 * pad;
    if (areaW > 0 && areaH > 0) {
      const scale = Math.min(areaW / image.width, areaH / image.height);
      const iw = image.width * scale;
      const ih = image.height * scale;
      content += `q ${iw} 0 0 ${ih} ${pad + (areaW - iw) / 2} ${pad + (areaH - ih) / 2} cm /Img Do Q\n`;
      resources.XObject = { Img: image.ref };
    }
    textLeft = 0.45 * w + pad / 2;
  }
  let size = Math.min(10, (h - 2 * pad) / (lines.length * 1.3));
  const room = w - textLeft - pad;
  const widest = Math.max(...lines.map((l) => face.measure(l, size)));
  if (widest > room && widest > 0) size *= room / widest;
  size = Math.max(3, size);
  const lead = size * 1.3;
  let baseline = h - Math.max(pad, (h - lines.length * lead) / 2) - size;
  content += "BT 0.1 0.15 0.3 rg\n";
  for (const line of lines) {
    content += `/F0 ${size.toFixed(3)} Tf 1 0 0 1 ${textLeft.toFixed(3)} ${baseline.toFixed(3)} Tm ${face.show(line)} Tj\n`;
    baseline -= lead;
  }
  content += "ET\n";
  return pdf.register(new PdfStream(obj({
    Type: "/XObject", Subtype: "/Form", BBox: [0, 0, w, h], Matrix: matrix, Resources: resources,
  }), new TextEncoder().encode(content)));
}

function freeFieldName(form) {
  const names = new Set(form ? form.getFieldNames() : []);
  for (let i = 1; ; i += 1) if (!names.has(`Signature${i}`)) return `Signature${i}`;
}

export function digitalSign(req) {
  const tsa = req.form.get("tsa_url").trim();
  if (tsa && !/^https?:\/\/\S+$/.test(tsa)) throw new HttpError(400, "The timestamp server URL must start with http:// or https://");
  const visible = req.form.bool("visible", true);
  const fieldName = req.form.get("field_name");
  const box = { index: req.form.int("page_index", 0), x: req.form.float("x", 72), y: req.form.float("y", 72), width: req.form.float("width", 200), height: req.form.float("height", 60) };
  if (visible && !fieldName && (box.width < 20 || box.height < 10)) throw new HttpError(400, "The signature box is too small");
  const reason = req.form.get("reason").trim().slice(0, 200);
  const location = req.form.get("location").trim().slice(0, 200);
  const contact = req.form.get("contact").trim().slice(0, 200);
  return mutate(req.form, async (data) => {
    const signer = await loadSigner(await readCertFile(req.form), req.form.get("cert_password"));
    const info = certificateInfo(signer.certificate);
    const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(binary(signer.certificate)));
    const now = new Date();
    if (now > cert.validity.notAfter) throw new HttpError(400, `The certificate has expired (valid until ${cert.validity.notAfter.toISOString().slice(0, 10)})`);
    if (now < cert.validity.notBefore) throw new HttpError(400, "The certificate is not valid yet");
    const imageFile = req.form.file("image");
    const imageBytes = imageFile && imageFile.name ? await readImage(imageFile) : null;

    const pdf = await openPdf(data, req.form.get("password"));
    let name;
    let place = null; // where the visible signature goes: {field, pageRef, rect (user space), ap}
    try {
      const form = pdf.getOrCreateForm();
      const image = imageBytes ? embedImage(pdf, imageBytes) : null;
      if (fieldName) {
        const field = form.getSignatureField(fieldName);
        if (!field || field.isSigned() || !field.getWidgets().length) {
          throw new HttpError(400, `Signature field '${fieldName}' does not exist or is already signed`);
        }
        name = fieldName;
        const widget = field.getWidgets()[0];
        const pageRef = widget.pageRef;
        const page = pdf.getPages().find((p) => pageRef && p.ref.objectNumber === pageRef.objectNumber);
        if (!page) throw new HttpError(400, "Cannot find the page of the signature field");
        const space = pageSpace(page);
        const [x1, y1, x2, y2] = widget.rect;
        let [w, h] = [Math.abs(x2 - x1), Math.abs(y2 - y1)];
        if (space.rotation % 180) [w, h] = [h, w];
        const [a, b, c, d] = space.matrix;
        const ap = await appearance(pdf, { w, h, matrix: [a, b, c, d, 0, 0], signerName: info.name, date: now, reason, location, image });
        place = { field, page, rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)], ap };
      } else {
        name = freeFieldName(form);
        const field = form.createSignatureField(name);
        if (visible) {
          const page = box.index >= 0 ? pdf.getPage(box.index) : null;
          if (!page) throw new HttpError(400, "Page number is outside the document");
          const space = pageSpace(page);
          const r = space.userRect(box.x, box.y, box.width, box.height);
          const [a, b, c, d] = space.matrix;
          const ap = await appearance(pdf, { w: box.width, h: box.height, matrix: [a, b, c, d, 0, 0], signerName: info.name, date: now, reason, location, image });
          place = { field, page, rect: [r.x, r.y, r.x + r.width, r.y + r.height], ap };
        }
      }
    } catch (err) {
      throw pdfError(err);
    }
    if (place) {
      // LibPDF signs invisibly: it turns the field into a zero-size widget on the first page and
      // saves. Just before that save, put the widget where it belongs, with its appearance.
      const save = pdf.save.bind(pdf);
      let done = false;
      pdf.save = async (options) => {
        if (!done && options?.incremental) {
          done = true;
          const dict = place.field.getDict();
          dict.set("Rect", obj(place.rect));
          dict.set("P", place.page.ref);
          dict.set("F", obj(4));
          dict.set("AP", obj({ N: place.ap }));
          const fieldRef = place.field.getRef();
          const annots = annotsOf(pdf, place.page);
          const has = Array.from({ length: annots.length }, (_, i) => annots.at(i))
            .some((r) => r && fieldRef && r.objectNumber === fieldRef.objectNumber);
          if (fieldRef && !has) annots.push(fieldRef);
        }
        return save({ subsetFonts: true, ...options });
      };
    }
    try {
      const result = await pdf.sign({
        signer, fieldName: name, reason: reason || undefined, location: location || undefined, contactInfo: contact || undefined,
        signingTime: now, subFilter: "ETSI.CAdES.detached", level: tsa ? "B-T" : "B-B",
        ...(tsa ? { timestampAuthority: new HttpTimestampAuthority(tsa, { timeout: 20000 }) } : {}),
      });
      return result.bytes;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const text = String(err?.message || err);
      if (tsa && /timestamp|tsa|fetch|network|cors|http/i.test(text)) {
        throw new HttpError(400, `Cannot reach the timestamp server: ${text}. In the browser version, the server must allow requests from web pages (CORS).`);
      }
      throw new HttpError(422, `Digital signing failed: ${text}`);
    }
  });
}

// ---------------------------------------------------------------- verifying

const OID_TSTOKEN = "1.2.840.113549.1.9.16.2.14";

function pdfDate(s) {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(s || "");
  if (!m) return null;
  const [, Y, M = "01", D = "01", h = "00", mi = "00", sec = "00", z, oh = "00", om = "00"] = m;
  let t = Date.UTC(+Y, +M - 1, +D, +h, +mi, +sec);
  if (z === "+" || z === "-") t -= (z === "+" ? 1 : -1) * (+oh * 60 + +om) * 60000;
  return new Date(t);
}

function timestampTime(signerInfo) {
  const attrs = signerInfo.unsignedAttrs?.attributes || [];
  const token = attrs.find((a) => a.type === OID_TSTOKEN);
  if (!token) return null;
  try {
    const info = new pkijs.ContentInfo({ schema: token.values[0] });
    const sd = new pkijs.SignedData({ schema: info.content });
    const tst = new pkijs.TSTInfo({ schema: asn1js.fromBER(sd.encapContentInfo.eContent.valueBlock.valueHexView).result });
    return tst.genTime;
  } catch (_) {
    return null;
  }
}

async function verifyOne(fileBytes, sig) {
  const out = {
    field: sig.field, page: sig.page, name: sig.name, reason: sig.reason, location: sig.location, contact: sig.contact,
    signDate: sig.date ? isoLocal(sig.date) : null, subFilter: sig.subFilter,
  };
  const [a, b, c, d] = sig.byteRange;
  const signedLength = Number.isFinite(c + d) ? c + d : null;
  out.coversWholeFile = signedLength === fileBytes.length;
  out.signedLength = signedLength;
  if (!["adbe.pkcs7.detached", "ETSI.CAdES.detached"].includes(sig.subFilter)) {
    return { ...out, status: "unsupported", message: `This signature format cannot be verified (${sig.subFilter})` };
  }
  try {
    const signed = new Uint8Array(b + d);
    signed.set(fileBytes.subarray(a, a + b), 0);
    signed.set(fileBytes.subarray(c, c + d), b);
    // /Contents is padded with zeros after the DER: take exactly its length from the header
    let contents = sig.contents;
    // (BER with an indefinite length, 0x30 0x80, as BouncyCastle writes it, ends with its own marker)
    if (contents[0] === 0x30 && contents.length > 2 && contents[1] !== 0x80) {
      let len = contents[1];
      let head = 2;
      if (len & 0x80) {
        const count = len & 0x7f;
        len = 0;
        for (let i = 0; i < count; i += 1) len = len * 256 + contents[2 + i];
        head = 2 + count;
      }
      contents = contents.subarray(0, Math.min(contents.length, head + len));
    }
    const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(contents).result });
    const sd = new pkijs.SignedData({ schema: info.content });
    const result = await sd.verify({ signer: 0, data: signed.buffer.slice(signed.byteOffset, signed.byteOffset + signed.byteLength), extendedMode: true, checkChain: false }).catch((e) => e);
    const certificate = result?.signerCertificate;
    if (!certificate) return { ...out, status: "invalid", message: "The signature does not contain the signer's certificate" };
    const der = new Uint8Array(certificate.toSchema(true).toBER(false));
    const certInfo = certificateInfo(der);
    if (!out.name) out.name = certInfo.name;
    out.certificate = certInfo;
    const tsTime = timestampTime(sd.signerInfos[0]);
    if (tsTime) {
      out.timeStamped = true;
      out.timeStampDate = isoLocal(tsTime);
    }
    const when = tsTime || sig.date;
    const notBefore = certificate.notBefore.value;
    const notAfter = certificate.notAfter.value;
    out.certValidAtSigning = when ? when >= notBefore && when <= notAfter : true;
    if (!result.signatureVerified) {
      return { ...out, status: "invalid", message: "Invalid: the document was changed after signing, or the signature is damaged" };
    }
    if (!out.certValidAtSigning) return { ...out, status: "warning", message: "Intact, but the certificate was not valid at signing time" };
    if (certInfo.selfSigned) {
      return { ...out, status: "untrusted", message: "Intact and unchanged; the certificate is self-signed, so the signer's identity is not confirmed" };
    }
    return { ...out, status: "valid", message: `Intact and unchanged (certificate issued by ${certInfo.issuer}; revocation not checked online)` };
  } catch (err) {
    return { ...out, status: "invalid", message: `Cannot verify the signature: ${err?.message || err}` };
  }
}

export async function verifySignatures(req) {
  const { data } = await loadDocument(req.form);
  const pdf = await openPdf(data, req.form.get("password"));
  const sigs = [];
  try {
    const form = pdf.getForm();
    const pages = pdf.getPages();
    for (const field of form ? form.getSignatureFields() : []) {
      const v = field.getSignatureDict();
      if (!(v instanceof PdfDict)) continue;
      const contents = resolve(pdf, v.get("Contents"));
      const pageRef = field.getWidgets()[0]?.pageRef;
      const pageIndex = pageRef ? pages.findIndex((p) => p.ref.objectNumber === pageRef.objectNumber) : -1;
      sigs.push({
        field: field.name,
        page: pageIndex >= 0 ? pageIndex : null,
        name: str(pdf, v.get("Name")),
        reason: str(pdf, v.get("Reason")),
        location: str(pdf, v.get("Location")),
        contact: str(pdf, v.get("ContactInfo")),
        date: pdfDate(str(pdf, v.get("M"))),
        subFilter: name(pdf, v.get("SubFilter")) || "",
        byteRange: numbers(pdf, v.get("ByteRange")),
        contents: contents instanceof PdfString ? contents.bytes : new Uint8Array(),
      });
    }
  } catch (err) {
    throw pdfError(err);
  }
  const signatures = [];
  for (const sig of sigs) signatures.push(await verifyOne(data, sig));
  return json({ signatures, fileLength: data.length });
}
