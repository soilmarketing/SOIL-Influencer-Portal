// POST /api/manage
//   { action: "delete_upload", uploadId }
//   { action: "reprocess", uploadId, contentType? }
//   { action: "clear_table", table, confirm }   empties any table
//   { action: "delete_table", table, confirm }  deletes a table the portal created
import { getAdmin, requireUser, getUpload, updateUpload, removeFiles } from "./_lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const user = await requireUser(req, res);
  if (!user) return;
  const db = getAdmin();
  const b = req.body || {};

  try {
    switch (b.action) {
      case "delete_upload": {
        const upload = await getUpload(db, b.uploadId);
        await removeFiles(db, [upload.storage_path]);
        const { error } = await db.from("uploads").delete().eq("id", upload.id); // its rows go with it
        if (error) throw new Error(error.message);
        return res.status(200).json({ ok: true });
      }

      case "reprocess": {
        const upload = await getUpload(db, b.uploadId);
        let contentType = upload.content_type;
        if (b.contentType) {
          const { data: type } = await db.from("content_types").select("key").eq("key", b.contentType).maybeSingle();
          if (!type) return res.status(400).json({ error: "That content type doesn't exist." });
          contentType = type.key;
        }
        if (!contentType) return res.status(400).json({ error: "Pick a content type before reprocessing." });
        const { error } = await db.rpc("clear_upload_rows", { p_upload_id: upload.id });
        if (error) throw new Error(error.message);
        await updateUpload(db, upload.id, {
          content_type: contentType,
          status: "processing",
          sections_done: 0,
          sections_total: null,
          section_outputs: [],
          warnings: [],
          error: null,
          rows_created: 0,
        });
        return res.status(200).json({ uploadId: upload.id, status: "processing" });
      }

      case "clear_table":
      case "delete_table": {
        const { data: types, error } = await db.from("content_types").select("key, table_name, is_core").eq("table_name", b.table || "");
        if (error) throw new Error(error.message);
        if (!types?.length) return res.status(404).json({ error: "That table isn't part of the portal." });
        if (b.confirm !== b.table) return res.status(400).json({ error: "Type the table name exactly to confirm." });

        const keys = types.map((t) => t.key);
        const { data: uploads } = await db.from("uploads").select("storage_path").in("content_type", keys);
        await removeFiles(db, (uploads || []).map((u) => u.storage_path));

        if (b.action === "clear_table") {
          const { error: e } = await db.rpc("clear_table_data", { p_table: b.table });
          if (e) throw new Error(e.message);
        } else {
          if (types.some((t) => t.is_core)) {
            return res.status(400).json({ error: "Core tables can't be deleted. You can clear their data instead." });
          }
          for (const key of keys) {
            const { error: e } = await db.rpc("drop_custom_table", { p_key: key });
            if (e) throw new Error(e.message);
          }
        }
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: "Unknown action." });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
