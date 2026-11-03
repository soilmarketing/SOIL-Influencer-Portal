// Server-side Supabase access. Uses the service role key, which only ever
// lives in Vercel's environment variables, never in the browser.
import { createClient } from "@supabase/supabase-js";

export const BUCKET = "portal-uploads";

let admin;
export function getAdmin() {
  if (!admin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing in Vercel's environment variables.");
    }
    admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return admin;
}

// Every API call must come from someone signed in to the portal, so nobody
// outside the team can trigger processing and spend API credit.
export async function requireUser(req, res) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "You're not signed in. Sign in to the portal and try again." });
    return null;
  }
  const { data, error } = await getAdmin().auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "Your session has expired. Sign in again." });
    return null;
  }
  return data.user;
}

export async function getUpload(db, uploadId) {
  if (!uploadId) throw new Error("No upload id was sent.");
  const { data, error } = await db.from("uploads").select("*").eq("id", uploadId).maybeSingle();
  if (error) throw new Error(`Could not read the upload: ${error.message}`);
  if (!data) throw new Error("That upload no longer exists.");
  return data;
}

export async function updateUpload(db, uploadId, fields) {
  const { error } = await db.from("uploads").update(fields).eq("id", uploadId);
  if (error) throw new Error(`Could not update the upload: ${error.message}`);
}

export async function downloadFile(db, storagePath) {
  const { data, error } = await db.storage.from(BUCKET).download(storagePath);
  if (error || !data) throw new Error(`Could not read the file from storage: ${error?.message || "not found"}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function removeFiles(db, paths) {
  const clean = paths.filter(Boolean);
  for (let i = 0; i < clean.length; i += 100) {
    const { error } = await db.storage.from(BUCKET).remove(clean.slice(i, i + 100));
    if (error) console.error("Could not remove some files from storage:", error.message);
  }
}
