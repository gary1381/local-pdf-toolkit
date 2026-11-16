// Fillable forms: list the fields (form-fields) and fill them (fill-form).

import { PdfBool } from "@libpdf/core";
import { HttpError, json } from "../http.js";
import { cjkFont, winAnsi } from "../fonts.js";
import { openPdf, pdfError, saveEdit } from "../libs.js";
import { loadDocument, mutate } from "../session.js";
import { pageSpace } from "../space.js";

const FT = { text: "Tx", checkbox: "Btn", radio: "Btn", button: "Btn", dropdown: "Ch", listbox: "Ch", signature: "Sig" };
const OFF = new Set(["", "off", "false", "no", "0"]);

function pageIndexByRef(pdf) {
  const map = new Map();
  pdf.getPages().forEach((page, i) => map.set(`${page.ref.objectNumber} ${page.ref.generation}`, { page, index: i }));
  return map;
}

function describe(field, pages) {
  const kind = field.type;
  const out = {
    name: field.name,
    type: FT[kind] ?? null,
    value: "",
    readOnly: field.isReadOnly() || kind === "button" || kind === "signature",
  };
  if (field.alternateName && field.alternateName.trim()) out.description = field.alternateName.trim();
  if (kind === "text") {
    out.value = field.getValue() || "";
    if (field.maxLength > 0) out.maxLength = field.maxLength;
    out.kind = field.isMultiline ? "textarea" : "text";
  } else if (kind === "checkbox") {
    out.kind = "checkbox";
    out.value = field.getValue() || "Off";
    out.checked = field.isChecked();
    out.onValue = field.getOnValue() || "Yes";
  } else if (kind === "radio") {
    out.kind = "radio";
    out.value = field.getValue() || "Off";
    out.options = field.getExportValues?.() || field.getOptions();
  } else if (kind === "dropdown" || kind === "listbox") {
    out.kind = "choice";
    const options = field.getOptions();
    out.options = options.map((o) => o.value);
    const labels = options.map((o) => o.display ?? o.value);
    if (labels.some((label, i) => label !== out.options[i])) out.optionLabels = labels;
    const values = kind === "listbox" ? field.getValue() : [field.getValue()].filter(Boolean);
    out.values = values;
    out.value = values[0] || "";
    if (kind === "listbox" && field.isMultiSelect) out.multiSelect = true;
  } else if (kind === "button") {
    out.kind = "button";
  } else if (kind === "signature") {
    out.kind = "signature";
    out.signed = field.isSigned();
  } else {
    out.kind = "text";
  }
  for (const widget of field.getWidgets()) {
    const ref = widget.pageRef;
    const found = ref && pages.get(`${ref.objectNumber} ${ref.generation}`);
    if (!found) continue;
    const [x1, y1, x2, y2] = widget.rect;
    const r = pageSpace(found.page).viewRect(x1, y1, x2, y2);
    Object.assign(out, { pageIndex: found.index, x: r.x, y: r.y, width: r.width, height: r.height });
    break;
  }
  return out;
}

export async function formFields(req) {
  const { data } = await loadDocument(req.form);
  const pdf = await openPdf(data, req.form.get("password"));
  const form = pdf.getForm();
  if (!form) return json({ fields: [] });
  try {
    const pages = pageIndexByRef(pdf);
    return json({ fields: form.getFields().map((field) => describe(field, pages)) });
  } catch (err) {
    throw pdfError(err);
  }
}

function setField(field, value) {
  const kind = field.type;
  const text = String(value ?? "");
  if (kind === "checkbox") {
    if (OFF.has(text.trim().toLowerCase())) field.uncheck();
    else field.check();
  } else if (kind === "radio") {
    if (OFF.has(text.trim().toLowerCase())) {
      field.setValue(null);
      return;
    }
    const wanted = text.replace(/^\//, "");
    const options = field.getExportValues?.() || field.getOptions();
    field.setValue(options.includes(wanted) ? wanted : text);
  } else if (kind === "listbox") {
    field.setValue(text.trim() ? [text] : []);
  } else {
    field.setValue(text);
  }
}

export function fillForm(req) {
  let values;
  try {
    values = JSON.parse(req.form.require("values"));
  } catch (_) {
    throw new HttpError(400, "Invalid form data: values must be a JSON object");
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new HttpError(400, "Invalid form data: values must be a JSON object");
  }
  return mutate(
    req.form,
    async (data) => {
      const pdf = await openPdf(data, req.form.get("password"));
      const form = pdf.getForm();
      if (!form || form.isEmpty) throw new HttpError(400, "This PDF has no fillable form fields");
      let filled = 0;
      try {
        for (const [name, value] of Object.entries(values)) {
          const field = form.getField(name);
          if (!field || field.isReadOnly() || ["signature", "button"].includes(field.type)) continue;
          const text = typeof value === "boolean" ? (value ? "True" : "False") : String(value ?? "");
          // Values Helvetica cannot show are drawn with the CJK font (the field's /DA changes to it).
          if (["text", "dropdown", "listbox"].includes(field.type) && !winAnsi(text)) field.setFont(await cjkFont(pdf));
          setField(field, text);
          filled += 1;
        }
        if (!filled) throw new HttpError(422, "No field was updated: the fields may not exist or are read-only");
        form.acroForm().getDict().set("NeedAppearances", PdfBool.TRUE);
      } catch (err) {
        throw pdfError(err);
      }
      try {
        form.updateAppearances();
      } catch (err) {
        console.warn("[openpdf services] form appearances not regenerated", err);
      }
      return [await saveEdit(pdf, data), { filled_count: filled }];
    },
    { responseHeaders: (info) => ({ "X-Filled-Count": String(info.filled_count ?? 0) }) }
  );
}
