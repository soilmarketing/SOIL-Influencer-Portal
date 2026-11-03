// Saves synthesized rows into Supabase: influencer matching, batching,
// and cleanup if anything goes wrong part way.
import { toRowsFor } from "./synthesis-config.js";

const BATCH = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same normalisation as influencers.name_key in the database.
export const aliasKey = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export async function saveResults(db, upload, typeDef, merged, { influencerName } = {}) {
  const { table, rows, warnings } = toRowsFor(typeDef, merged, { uploadId: upload.id, influencerName });
  const warn = (m) => warnings.push(m);

  // Start clean, so re-running a file never duplicates its rows.
  await rpc(db, "clear_upload_rows", { p_upload_id: upload.id });

  let count = 0;
  try {
    if (table === "influencers") {
      count = await saveInfluencers(db, rows);
    } else {
      if (typeDef.resolveInfluencer) {
        if (upload.influencer_id) rows.forEach((r) => { r.influencer_id = upload.influencer_id; });
        await resolveInfluencers(db, rows, warn);
      }
      for (let i = 0; i < rows.length; i += BATCH) {
        await insertWithRetry(db, table, rows.slice(i, i + BATCH));
      }
      count = rows.length;
    }
  } catch (e) {
    await rpc(db, "clear_upload_rows", { p_upload_id: upload.id }).catch(() => {});
    throw e;
  }

  if (!count) warn("Nothing was extracted from this file. Check it was uploaded under the right type.");
  return { count, warnings };
}

async function rpc(db, fn, args) {
  const { error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
}

// A brand new table can take a moment to become visible to the API.
async function insertWithRetry(db, table, rows) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { error } = await db.from(table).insert(rows);
    if (!error) return;
    const cacheMiss = error.code === "PGRST205" || error.code === "42P01" || /schema cache/i.test(error.message);
    if (cacheMiss && attempt < 4) {
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`Saving to ${table} failed: ${error.message}`);
  }
}

async function resolveInfluencers(db, rows, warn) {
  const keys = [...new Set(rows.filter((r) => !r.influencer_id).map((r) => aliasKey(r.influencer_name_raw)).filter(Boolean))];
  const map = new Map();
  if (keys.length) {
    const { data: aliases, error: e1 } = await db.from("influencer_aliases").select("alias_key, influencer_id").in("alias_key", keys);
    if (e1) throw new Error(`Could not read influencer aliases: ${e1.message}`);
    aliases.forEach((a) => map.set(a.alias_key, a.influencer_id));
    const { data: people, error: e2 } = await db.from("influencers").select("id, name_key").in("name_key", keys);
    if (e2) throw new Error(`Could not read influencers: ${e2.message}`);
    people.forEach((p) => { if (!map.has(p.name_key)) map.set(p.name_key, p.id); });
  }
  const missing = new Set();
  for (const r of rows) {
    if (!r.influencer_id) r.influencer_id = map.get(aliasKey(r.influencer_name_raw)) || null;
    if (!r.influencer_id && r.influencer_name_raw) missing.add(r.influencer_name_raw);
  }
  missing.forEach((n) => warn(`"${n}" isn't in the influencer list yet, so it was saved without a link. Upload their details first, or check the spelling.`));
}

async function saveInfluencers(db, rows) {
  // Merge duplicates within the same file.
  const byKey = new Map();
  for (const r of rows) {
    const k = aliasKey(r.name);
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...r }); continue; }
    for (const [f, v] of Object.entries(r)) {
      if (prev[f] == null || (Array.isArray(prev[f]) && !prev[f].length)) prev[f] = v;
    }
    prev._aliases = [...new Set([...(prev._aliases || []), ...(r._aliases || [])])];
  }

  let count = 0;
  for (const r of byKey.values()) {
    const { _aliases, ...fields } = r;
    // Only send values that are present, so a sparse file never wipes
    // details saved earlier for the same influencer.
    const payload = Object.fromEntries(Object.entries(fields).filter(([, v]) =>
      v != null && !(Array.isArray(v) && v.length === 0)));
    const { data, error } = await db.from("influencers").upsert(payload, { onConflict: "name_key" }).select("id").single();
    if (error) throw new Error(`Saving influencer "${r.name}" failed: ${error.message}`);
    count++;

    const aliases = [...new Map((_aliases || []).map((a) => [aliasKey(a), a])).entries()]
      .filter(([k]) => k)
      .map(([alias_key, alias]) => ({ alias_key, alias, influencer_id: data.id }));
    if (aliases.length) {
      const { error: aErr } = await db.from("influencer_aliases").upsert(aliases, { onConflict: "alias_key", ignoreDuplicates: true });
      if (aErr) throw new Error(`Saving aliases for "${r.name}" failed: ${aErr.message}`);
    }
  }
  return count;
}
