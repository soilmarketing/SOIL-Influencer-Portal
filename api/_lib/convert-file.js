// Turns an uploaded file into one or more sections that Claude can read.
// Each section is a list of Claude API content blocks. Long files are split
// so each Claude call stays well inside time and output limits.
import { PDFDocument } from "pdf-lib";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

const PAGES_PER_SECTION = 10;
const CHARS_PER_SECTION = 30000;
const ROWS_PER_SECTION = 150;

const ext = (name) => (String(name).split(".").pop() || "").toLowerCase();

export function fileKind(fileName, mime = "") {
  const e = ext(fileName);
  if (e === "pdf" || mime === "application/pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(e)) return "image";
  if (e === "docx") return "docx";
  if (["xlsx", "xls", "csv", "tsv", "ods"].includes(e)) return "sheet";
  if (["txt", "md", "srt", "vtt", "json", "html", "htm"].includes(e) || mime.startsWith("text/")) return "text";
  if (["mp4", "mov", "mp3", "wav", "m4a", "webm", "avi", "mkv", "aac"].includes(e) || /^(audio|video)\//.test(mime)) return "media";
  if (e === "doc") return "doc";
  if (["ppt", "pptx"].includes(e)) return "slides";
  return "unknown";
}

export async function splitIntoSections(buffer, fileName, mime) {
  switch (fileKind(fileName, mime)) {
    case "pdf": return splitPdf(buffer);
    case "image": return [[imageBlock(buffer, fileName)]];
    case "docx": {
      const { value } = await mammoth.extractRawText({ buffer });
      return textSections(value);
    }
    case "sheet": return sheetSections(buffer);
    case "text": return textSections(buffer.toString("utf8"));
    case "media":
      throw new Error("Claude can't read audio or video. Upload a transcript instead (.txt, .docx or .srt).");
    case "doc":
      throw new Error("Old .doc files aren't supported. Save it as .docx in Word and upload again.");
    case "slides":
      throw new Error("PowerPoint files aren't supported. Export the deck as a PDF and upload that.");
    default:
      throw new Error(`.${ext(fileName)} files aren't supported. Upload a PDF, Word (.docx), Excel, CSV, text file or image.`);
  }
}

const pdfBlock = (buf) => ({
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: Buffer.from(buf).toString("base64") },
});

function imageBlock(buf, fileName) {
  const e = ext(fileName);
  const media_type = e === "jpg" || e === "jpeg" ? "image/jpeg" : `image/${e}`;
  return { type: "image", source: { type: "base64", media_type, data: buf.toString("base64") } };
}

async function splitPdf(buffer) {
  let doc;
  try {
    doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch {
    return [[pdfBlock(buffer)]]; // can't open it to split: send it whole
  }
  const total = doc.getPageCount();
  if (total <= PAGES_PER_SECTION) return [[pdfBlock(buffer)]];

  const sections = [];
  try {
    for (let start = 0; start < total; start += PAGES_PER_SECTION) {
      const end = Math.min(start + PAGES_PER_SECTION, total);
      const part = await PDFDocument.create();
      const pages = await part.copyPages(doc, Array.from({ length: end - start }, (_, i) => start + i));
      pages.forEach((p) => part.addPage(p));
      sections.push([
        pdfBlock(await part.save()),
        { type: "text", text: `These are pages ${start + 1} to ${end} of a ${total}-page PDF. Use the original page numbers for any page references.` },
      ]);
    }
  } catch {
    return [[pdfBlock(buffer)]];
  }
  return sections;
}

function textSections(raw) {
  const textContent = String(raw || "").replace(/\r\n/g, "\n").trim();
  if (!textContent) throw new Error("No readable text was found in this file.");
  const chunks = [];
  let current = "";
  for (const para of textContent.split(/\n{2,}/)) {
    if (current && current.length + para.length + 2 > CHARS_PER_SECTION) {
      chunks.push(current);
      current = "";
    }
    if (para.length > CHARS_PER_SECTION) {
      for (let i = 0; i < para.length; i += CHARS_PER_SECTION) chunks.push(para.slice(i, i + CHARS_PER_SECTION));
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => [{ type: "text", text: c }]);
}

function sheetSections(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    const lines = csv.split("\n").filter((l) => l.replace(/,/g, "").trim());
    if (!lines.length) continue;
    const [header, ...body] = lines;
    if (!body.length) {
      parts.push(`Sheet "${name}":\n${header}`);
      continue;
    }
    for (let i = 0; i < body.length; i += ROWS_PER_SECTION) {
      const last = Math.min(i + ROWS_PER_SECTION, body.length);
      parts.push(`Sheet "${name}", data rows ${i + 1} to ${last} of ${body.length} (CSV, first line is the header):\n${header}\n${body.slice(i, last).join("\n")}`);
    }
  }
  if (!parts.length) throw new Error("The spreadsheet looks empty.");

  // Group small parts together so a workbook of small sheets is one call.
  const sections = [];
  let current = "";
  for (const p of parts) {
    if (current && current.length + p.length > CHARS_PER_SECTION) {
      sections.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${p}` : p;
  }
  if (current) sections.push(current);
  return sections.map((s) => [{ type: "text", text: s }]);
}
