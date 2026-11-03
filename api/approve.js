// POST /api/approve
//   { uploadId, decision: "approve", proposal }   creates the new table, then processing continues
//   { uploadId, decision: "use_existing", contentType }
//   { uploadId, decision: "reject" }              cancels the upload
import { getAdmin, requireUser, getUpload, updateUpload } from "./_lib/supabase.js";
import { validateProposal } from "./_lib/types.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const user = await requireUser(req, res);
  if (!user) return;
  const db = getAdmin();
  const { uploadId, decision, proposal, contentType } = req.body || {};

  try {
    const upload = await getUpload(db, uploadId);
    if (upload.status !== "awaiting_approval") {
      return res.status(409).json({ error: "This upload isn't waiting for approval any more." });
    }

    if (decision === "reject") {
      await updateUpload(db, uploadId, { status: "rejected" });
      return res.status(200).json({ uploadId, status: "rejected" });
    }

    if (decision === "use_existing") {
      const { data: type } = await db.from("content_types").select("key").eq("key", contentType || "").maybeSingle();
      if (!type) return res.status(400).json({ error: "Pick a content type to use." });
      await updateUpload(db, uploadId, { content_type: type.key, status: "processing", proposal: null });
      return res.status(200).json({ uploadId, status: "processing" });
    }

    if (decision === "approve") {
      const { proposal: p, errors } = validateProposal(proposal);
      if (errors.length) return res.status(400).json({ error: errors.join(" ") });

      const { error } = await db.rpc("create_custom_table", {
        p_table: p.table_name,
        p_label: p.label,
        p_description: p.description,
        p_instructions: p.instructions,
        p_columns: p.columns,
        p_title_column: p.title_column,
        p_snippet_column: p.snippet_column,
        p_upload_id: uploadId,
      });
      if (error) return res.status(400).json({ error: error.message });

      await updateUpload(db, uploadId, { content_type: p.table_name, status: "processing", proposal: p });
      return res.status(200).json({ uploadId, status: "processing", table: p.table_name });
    }

    return res.status(400).json({ error: "Unknown decision." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
