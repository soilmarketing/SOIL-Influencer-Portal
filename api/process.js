// POST /api/process
//   { action: "start", storagePath, fileName, mimeType, fileSize, contentType, notes, influencerId, replacesUploadId }
//     Registers an upload. With contentType "auto", Claude decides where it
//     belongs and may propose a new table, which then waits for approval.
//   { action: "section", uploadId }
//     Synthesizes the next section of the file. The portal calls this
//     repeatedly until done is true, so long files never hit time limits.
import { getAdmin, requireUser, getUpload, updateUpload, downloadFile } from "./_lib/supabase.js";
import { splitIntoSections } from "./_lib/convert-file.js";
import { callClaude } from "./_lib/claude.js";
import { buildClaudeRequest, readToolOutput, PROMPT_VERSION, MODEL } from "./_lib/synthesis-config.js";
import { getTypeDef, buildClassificationRequest, readClassification, validateProposal } from "./_lib/types.js";
import { saveResults } from "./_lib/save-rows.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const user = await requireUser(req, res);
  if (!user) return;
  const db = getAdmin();
  const body = req.body || {};
  let uploadId = body.uploadId || null;

  try {
    if (body.action === "start") {
      uploadId = await createUpload(db, body);
      return res.status(200).json(await afterCreate(db, uploadId));
    }
    if (body.action === "section") {
      return res.status(200).json(await processNextSection(db, uploadId));
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    console.error(e);
    if (uploadId) await updateUpload(db, uploadId, { status: "failed", error: e.message }).catch(() => {});
    return res.status(500).json({ error: e.message, uploadId });
  }
}

async function createUpload(db, b) {
  if (!b.storagePath || !b.fileName || !b.contentType) {
    throw new Error("The upload is missing its file or content type.");
  }
  const auto = b.contentType === "auto";
  const { data, error } = await db.from("uploads").insert({
    requested_type: b.contentType,
    content_type: auto ? null : b.contentType,
    file_name: b.fileName,
    storage_path: b.storagePath,
    mime_type: b.mimeType || null,
    file_size: b.fileSize || null,
    notes: b.notes || null,
    influencer_id: b.influencerId || null,
    replaces_upload_id: b.replacesUploadId || null,
    status: auto ? "pending" : "processing",
  }).select("id").single();
  if (error) throw new Error(`Could not register the upload: ${error.message}`);
  return data.id;
}

async function afterCreate(db, uploadId) {
  const upload = await getUpload(db, uploadId);
  if (upload.requested_type !== "auto") return { uploadId, status: "processing", done: false };

  // Let Claude decide where it belongs, from the first section of the file.
  const buffer = await downloadFile(db, upload.storage_path);
  const sections = await splitIntoSections(buffer, upload.file_name, upload.mime_type);
  const request = await buildClassificationRequest(db, sections[0], {
    fileName: upload.file_name,
    uploaderNotes: upload.notes,
  });
  const decision = readClassification(await callClaude(request));

  if (decision.decision === "existing") {
    const { data: type } = await db.from("content_types").select("key,label").eq("key", decision.existing_type || "").maybeSingle();
    if (type) {
      await updateUpload(db, uploadId, {
        content_type: type.key,
        status: "processing",
        classification_reason: decision.reason || null,
        sections_total: sections.length,
      });
      return { uploadId, status: "processing", done: false, decidedType: type.key, decidedLabel: type.label, reason: decision.reason };
    }
    // Claude named a type that doesn't exist: ask the person instead.
  }

  const { proposal } = validateProposal(decision.proposal);
  await updateUpload(db, uploadId, {
    status: "awaiting_approval",
    proposal,
    classification_reason: decision.reason || null,
  });
  return { uploadId, status: "awaiting_approval", done: true, proposal, reason: decision.reason };
}

async function processNextSection(db, uploadId) {
  const upload = await getUpload(db, uploadId);
  if (upload.status !== "processing") {
    return { uploadId, status: upload.status, done: true, rowsCreated: upload.rows_created, warnings: upload.warnings };
  }
  if (!upload.content_type) throw new Error("This upload has no content type yet.");

  const typeDef = await getTypeDef(db, upload.content_type);
  const buffer = await downloadFile(db, upload.storage_path);
  const sections = await splitIntoSections(buffer, upload.file_name, upload.mime_type);
  const total = sections.length;
  const index = Math.min(upload.sections_done || 0, total);

  let influencerName = null;
  if (upload.influencer_id) {
    const { data } = await db.from("influencers").select("name").eq("id", upload.influencer_id).maybeSingle();
    influencerName = data?.name || null;
  }

  let outputs = Array.isArray(upload.section_outputs) ? upload.section_outputs : [];
  if (index < total) {
    const request = buildClaudeRequest(typeDef, sections[index], {
      fileName: upload.file_name,
      uploaderNotes: upload.notes,
      influencerName,
      sectionInfo: total > 1 ? `section ${index + 1} of ${total}` : null,
    });
    const output = readToolOutput(await callClaude(request));
    outputs = [...outputs, output];

    if (index + 1 < total) {
      await updateUpload(db, uploadId, { sections_total: total, sections_done: index + 1, section_outputs: outputs });
      return { uploadId, status: "processing", done: false, sectionsDone: index + 1, sectionsTotal: total };
    }
  }

  // Every section is done: combine, check and save.
  const merged = mergeOutputs(outputs);
  const { count, warnings } = await saveResults(db, upload, typeDef, merged, { influencerName });

  if (upload.replaces_upload_id) {
    await db.rpc("clear_upload_rows", { p_upload_id: upload.replaces_upload_id });
    await updateUpload(db, upload.replaces_upload_id, { is_current: false });
  }

  const status = warnings.length ? "needs_review" : "done";
  await updateUpload(db, uploadId, {
    status,
    warnings,
    raw_output: merged,
    rows_created: count,
    sections_total: total,
    sections_done: total,
    section_outputs: [],
    prompt_version: PROMPT_VERSION,
    model: MODEL,
    error: null,
    processed_at: new Date().toISOString(),
  });
  return { uploadId, status, done: true, rowsCreated: count, warnings, sectionsDone: total, sectionsTotal: total };
}

// Lists from every section are joined; single values keep the first one found.
function mergeOutputs(outputs) {
  const merged = {};
  for (const out of outputs) {
    for (const [k, v] of Object.entries(out || {})) {
      if (Array.isArray(v)) merged[k] = [...(merged[k] || []), ...v];
      else if (merged[k] == null) merged[k] = v;
    }
  }
  return merged;
}
