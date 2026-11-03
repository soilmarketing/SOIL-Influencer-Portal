// Content types: the eight core ones (defined in synthesis-config.js) plus
// any custom ones you approve in the portal (stored in the content_types
// table). Also: asking Claude where a new upload belongs.
import {
  CONTENT_TYPES, MODEL, sharedRules, S, N, I, B, D, LIST, ENUM, OBJ, ARRAY_OF, WARNINGS,
  text, list, isoDate, number, integer,
} from "./synthesis-config.js";

export const COLUMN_TYPES = ["text", "long_text", "integer", "number", "date", "boolean", "list"];
const RESERVED_COLUMNS = new Set(["id", "source_upload_id", "created_at", "search"]);

// ---------------------------------------------------------------------
// Getting the definition for any content type
// ---------------------------------------------------------------------
export async function getTypeDef(db, key) {
  if (CONTENT_TYPES[key]) return CONTENT_TYPES[key];
  const { data, error } = await db.from("content_types").select("*").eq("key", key).maybeSingle();
  if (error) throw new Error(`Could not read content types: ${error.message}`);
  if (!data) throw new Error(`Unknown content type: ${key}`);
  return customTypeDef(data);
}

function columnSchema(c) {
  const d = c.description || c.name;
  switch (c.type) {
    case "integer": return I(d);
    case "number": return N(d);
    case "date": return D(`${d}. YYYY-MM-DD, or null if not stated`);
    case "boolean": return B(d);
    case "list": return LIST(d);
    default: return S(d);
  }
}

export function customTypeDef(row) {
  const cols = row.columns || [];
  return {
    label: row.label,
    table: row.table_name,
    instructions: `This document is of the type "${row.label}": ${row.description || ""}\n${row.instructions}\nCreate one item per record in the document. Fill every column you can from the document, and use null for anything not stated.`,
    schema: OBJ({
      items: ARRAY_OF(Object.fromEntries(cols.map((c) => [c.name, columnSchema(c)])), "One entry per record in the document"),
      warnings: WARNINGS,
    }),
    toRows(out, ctx) {
      return (out.items || []).map((item, i) => {
        const row = { source_upload_id: ctx.uploadId };
        let hasValue = false;
        for (const c of cols) {
          const label = `${c.name} (item ${i + 1})`;
          const v = item?.[c.name];
          let clean;
          switch (c.type) {
            case "integer": clean = integer(v, ctx, label); break;
            case "number": clean = number(v, ctx, label); break;
            case "date": clean = isoDate(v, ctx, label); break;
            case "boolean": clean = typeof v === "boolean" ? v : null; break;
            case "list": clean = list(v); break;
            default: clean = text(v);
          }
          row[c.name] = clean;
          if (clean != null && !(Array.isArray(clean) && clean.length === 0)) hasValue = true;
        }
        return hasValue ? row : null;
      }).filter(Boolean);
    },
  };
}

// ---------------------------------------------------------------------
// Checking a proposed new table before it is created. The database
// function checks again, so this is about giving clear messages early.
// ---------------------------------------------------------------------
const snake = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export function validateProposal(p) {
  const errors = [];
  if (!p || typeof p !== "object") return { proposal: null, errors: ["No table was proposed."] };

  let table = snake(p.table_name);
  if (!table.startsWith("custom_")) table = `custom_${table}`;
  table = table.replace(/^custom_(?=[^a-z])/, "custom_t");
  if (table.length > 47) table = table.slice(0, 47).replace(/_+$/, "");
  if (!/^custom_[a-z][a-z0-9_]{0,40}$/.test(table)) errors.push("The table name isn't valid.");

  const label = text(p.label);
  if (!label) errors.push("The table needs a name.");
  const instructions = text(p.instructions);
  if (!instructions) errors.push("The table needs extraction instructions.");

  const seen = new Set();
  const columns = [];
  for (const c of Array.isArray(p.columns) ? p.columns : []) {
    let name = snake(c?.name);
    if (!name) continue;
    if (!/^[a-z]/.test(name)) name = `c_${name}`;
    name = name.slice(0, 41);
    if (RESERVED_COLUMNS.has(name)) name = `${name}_value`;
    if (seen.has(name)) {
      errors.push(`The column "${name}" appears twice.`);
      continue;
    }
    seen.add(name);
    const type = COLUMN_TYPES.includes(c?.type) ? c.type : "text";
    columns.push({ name, type, description: text(c?.description) || "" });
  }
  if (!columns.length) errors.push("The table needs at least one column.");
  if (columns.length > 40) errors.push("A table can have at most 40 columns.");

  const textCols = columns.filter((c) => c.type === "text" || c.type === "long_text").map((c) => c.name);
  const pick = (v, fallback) => (textCols.includes(snake(v)) ? snake(v) : fallback);
  const title_column = pick(p.title_column, textCols[0] || null);
  const snippet_column = pick(p.snippet_column, textCols.find((n) => n !== title_column) || null);

  return {
    proposal: {
      table_name: table,
      label,
      description: text(p.description) || "",
      instructions,
      columns,
      title_column,
      snippet_column,
    },
    errors,
  };
}

// ---------------------------------------------------------------------
// Asking Claude where an upload belongs
// ---------------------------------------------------------------------
export async function buildClassificationRequest(db, documentBlocks, extra = {}) {
  const { data: types, error } = await db
    .from("content_types")
    .select("key,label,description,columns,is_core")
    .order("is_core", { ascending: false });
  if (error) throw new Error(`Could not read content types: ${error.message}`);

  const typeList = types.map((t) => {
    const cols = t.columns ? ` Columns: ${t.columns.map((c) => c.name).join(", ")}.` : "";
    return `- ${t.key}: ${t.label}. ${t.description || ""}${cols}`;
  }).join("\n");

  const system = `${sharedRules()}

Your job right now is different: decide where an uploaded document belongs in the portal. You are seeing the start of the document.

Existing content types:
${typeList}

Rules:
1. Strongly prefer an existing type. Choose "existing" whenever the document's information fits one of them, even if not perfectly.
2. Choose "new" only when the document holds a genuinely different kind of information that none of the existing tables can hold well.
3. When choosing "existing", put its key in existing_type and leave the proposal fields empty.
4. When choosing "new", propose a table:
   - table_name: "custom_" plus a short plural snake_case name, for example custom_faculty_profiles. Lowercase letters, digits and underscores only.
   - label: a short name people will see, for example "Faculty profiles".
   - description: one sentence on what this kind of content is, so future uploads of the same kind are recognised.
   - columns: 3 to 20 columns covering the useful information in documents of this kind in general, not just this one file. snake_case names. Types: text (short text), long_text (paragraphs), integer, number (decimals and money), date, boolean, list (several short text values). Do not include id, source_upload_id, created_at or search; those are added automatically.
   - instructions: clear extraction instructions for future documents of this kind: what one row represents and how to fill each column.
   - title_column and snippet_column: the text or long_text columns that best name and summarise each row.
5. reason: one or two plain sentences explaining your choice, for the marketing team.
6. Always call the classify_upload tool.`;

  const proposal = OBJ({
    table_name: S("custom_ table name"),
    label: S("Name people will see"),
    description: S("One sentence on what this content is"),
    instructions: S("Extraction instructions for this kind of document"),
    title_column: S("Column that names each row"),
    snippet_column: S("Column that summarises each row"),
    columns: ARRAY_OF({
      name: { type: "string", description: "snake_case column name" },
      type: ENUM(COLUMN_TYPES, "Column type"),
      description: { type: "string", description: "What goes in this column" },
    }, "Columns for the new table; empty if decision is existing"),
  });

  const context = [
    extra.fileName && `File name: ${extra.fileName}.`,
    extra.uploaderNotes && `Notes from the person who uploaded it: ${extra.uploaderNotes}`,
  ].filter(Boolean).join("\n");

  return {
    model: MODEL,
    max_tokens: 4000,
    system,
    tools: [{
      name: "classify_upload",
      description: "Record where this upload belongs.",
      input_schema: OBJ({
        decision: ENUM(["existing", "new"], "Use an existing type, or propose a new table"),
        existing_type: S("Key of the existing type, when decision is existing"),
        reason: { type: "string", description: "One or two sentences explaining the choice" },
        proposal,
      }),
    }],
    tool_choice: { type: "tool", name: "classify_upload" },
    messages: [{
      role: "user",
      content: [...documentBlocks, { type: "text", text: `${context}\n\nDecide where this document belongs and call classify_upload.` }],
    }],
  };
}

export function readClassification(apiResponse) {
  const block = apiResponse?.content?.find((b) => b.type === "tool_use" && b.name === "classify_upload");
  if (!block) throw new Error("Claude did not return a decision about where this file belongs.");
  return block.input;
}
