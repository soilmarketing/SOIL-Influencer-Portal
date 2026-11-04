// Lets Claude look things up in the portal's data while answering in the
// Ask Claude tab. Claude can only read; it can't change or delete anything.
import { aliasKey } from "./save-rows.js";
import { SOIL_PROGRAMS } from "./synthesis-config.js";

const MAX_RESULT_CHARS = 20000;
const COLUMN_NAME = /^[a-z][a-z0-9_]{0,62}$/;

// Columns of the core tables, so Claude knows what it can ask for.
const CORE_COLUMNS = {
  influencers: "name, relationship_status (prospect, active, paused, ended), handles (list of platform, handle, url, followers), primary_platform, niche, audience_description, audience_location, languages, content_style, agency, contact_person, contact_email, contact_phone, city, notes",
  influencer_budgets: "influencer_id, influencer_name_raw, financial_year, period_label, period_start, period_end, amount, amount_text, currency, deliverables, deliverable_count, campaign, notes",
  influencer_content: "influencer_id, influencer_name_raw, platform, content_format, published_date, title, summary, topics (list), tone, hooks (list), key_phrases (list), notable_quotes (list), call_to_action, mentions_soil, soil_mentions, programs_mentioned (list), performance",
  calendar_events: "title, category, event_date, end_date, date_is_approximate, time_text, program, academic_year, is_previous_year, description",
  knowledge_items: "document_title, document_kind, category, program, academic_year, fact, figures, source_page",
  social_posts: "platform, posted_date, post_format, theme, summary, caption_text, hashtags (list), programs_mentioned (list), people_featured (list), call_to_action, link_url, performance",
  alumni_activity: "alumnus_name, batch, program, job_title, company, activity_type, activity_date, summary, story_angle, source_link",
  deliverables: "influencer_id, title, campaign, program, platform, format, status, due_date, post_date, fee, currency, post_url, views, likes, comments, shares, brief, script, notes, paid_on, updated_at",
};

// ---------------------------------------------------------------------
// System prompt with a live summary of what the portal holds
// ---------------------------------------------------------------------
export async function buildAskContext(db) {
  const [{ data: stats, error: e1 }, { data: types, error: e2 }] = await Promise.all([
    db.rpc("table_stats"),
    db.from("content_types").select("table_name, label, description, columns, is_core"),
  ]);
  if (e1 || e2) throw new Error(`Could not read the portal's tables: ${(e1 || e2).message}`);

  const allowedTables = new Set(stats.map((s) => s.t_table));
  allowedTables.add("deliverables");
  const { count: deliverableCount } = await db.from("deliverables").select("id", { count: "exact", head: true });
  const tableLines = stats.map((s) => {
    const custom = types.find((t) => t.table_name === s.t_table && !t.is_core);
    const cols = custom
      ? (custom.columns || []).map((c) => `${c.name} (${c.type})`).join(", ")
      : CORE_COLUMNS[s.t_table] || "";
    const about = custom?.description ? ` ${custom.description}` : "";
    return `- ${s.t_table} (${s.t_rows} rows; ${s.t_labels}).${about}\n  Columns: id, ${cols}, created_at`;
  }).join("\n") + `\n- deliverables (${deliverableCount ?? 0} rows; the content tracker: every piece of content an influencer makes for SOIL).\n  Columns: id, ${CORE_COLUMNS.deliverables}, created_at`;

  const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full" });

  const system = `You are the assistant inside the internal influencer marketing portal of SOIL Institute of Management, an MBA school in Delhi-NCR. SOIL's programs are ${SOIL_PROGRAMS.join(", ")}. PGPM and PGPM-HR are separate programs.

You help SOIL's marketing team with whatever they ask: answering questions about the data, and creating things such as reel and video scripts, captions, hooks, campaign briefs, influencer briefs, content calendars, post ideas, and email or WhatsApp copy.

Today is ${today} (India time).

The portal's data, which you read with your tools:
${tableLines}

How to work:
1. Before answering, look up what you need with the tools. Use search_portal for keywords across everything, influencer_profile for anything about a specific influencer, and read_table for lists, dates, budgets or full records. Several lookups are fine; check the data rather than assume.
2. Facts about SOIL (fees, placements, rankings, dates, deadlines, alumni, budgets, follower counts) must come from the portal's data. Never invent or estimate them. If something isn't in the data, say so plainly and leave a clear placeholder such as [add latest placement figure] instead of guessing.
3. Budgets: influencer_budgets holds allocations. Spending comes from the deliverables table: the fee of every deliverable that isn't cancelled counts as committed, and deliverables with status "paid" count as paid. Remaining budget = allocation minus committed, for the same financial year (April to March, based on post_date, or due_date if there is no post_date).
4. Content tracker stages, in order: planned, brief_sent, script_review, content_review, approved, posted, invoiced, paid (plus cancelled). A deliverable is overdue when its due_date has passed and it hasn't reached posted yet.
5. When writing for a specific influencer, match their voice using the tone, hooks and key phrases from their past content.
6. Content an influencer posts for SOIL is paid promotion. When you write influencer content, add a short reminder that it needs a clear disclosure label (such as #ad or #collab) under Indian advertising (ASCI) guidelines.
7. Be practical and ready to use. Use headings and lists when they make the output easier to copy. Write in English unless asked otherwise; Hinglish is fine when matching an influencer who uses it.
8. When your answer uses portal data, end with one short line starting "Based on:" naming what you used (for example: Rahul's last 5 reels, the 2026-27 calendar, the PGPM brochure).
9. The person sees only your final answer, not your lookups.`;

  return { system, allowedTables };
}

// ---------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------
export const ASK_TOOLS = [
  {
    name: "search_portal",
    description: "Keyword search across every table in the portal. Returns up to 30 matches with their table, id, title and a short snippet. Use 2 to 4 distinctive words; all words must match, so use OR between alternatives (for example: placement OR salary PGPM). Follow up with read_table to get full records.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Keywords to search for" } },
      required: ["query"],
    },
  },
  {
    name: "influencer_profile",
    description: "Everything about one influencer: profile, handles and followers, budget allocations, their deliverables in the content tracker, and their past content with summaries, tone, hooks and key phrases. Accepts a name or a social handle.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Influencer name or handle" } },
      required: ["name"],
    },
  },
  {
    name: "read_table",
    description: "Read rows from one portal table, with optional filters, sorting and a limit (default 50, maximum 200). Use it for lists, upcoming dates, budgets, full records found through search, or any table not covered by the other tools.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name, exactly as listed" },
        columns: { type: "array", items: { type: "string" }, description: "Columns to return. Leave out to get all columns." },
        filters: {
          type: "array",
          description: "All filters must match",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: {
                type: "string",
                enum: ["eq", "neq", "contains_text", "gte", "lte", "list_has", "is_empty", "not_empty"],
                description: "contains_text is a case-insensitive text match; list_has checks a list column; gte and lte work for dates and numbers",
              },
              value: { type: ["string", "number", "boolean", "null"] },
            },
            required: ["column", "op"],
          },
        },
        order_by: { type: "string", description: "Column to sort by" },
        ascending: { type: "boolean", description: "Sort direction, default true" },
        limit: { type: "integer", description: "Maximum rows, default 50, at most 200" },
      },
      required: ["table"],
    },
  },
];

// ---------------------------------------------------------------------
// Running a tool
// ---------------------------------------------------------------------
export async function runAskTool(db, allowedTables, name, input) {
  let result;
  try {
    if (name === "search_portal") result = await searchPortal(db, input);
    else if (name === "influencer_profile") result = await influencerProfile(db, input);
    else if (name === "read_table") result = await readTable(db, allowedTables, input);
    else result = { error: `Unknown tool ${name}` };
  } catch (e) {
    result = { error: e.message };
  }
  let out = JSON.stringify(result);
  if (out.length > MAX_RESULT_CHARS) {
    out = `${out.slice(0, MAX_RESULT_CHARS)} ... [cut off because it was too long: ask for fewer rows or fewer columns]`;
  }
  return out;
}

export function describeToolUse(name, input) {
  if (name === "search_portal") return `Searched "${input?.query || ""}"`;
  if (name === "influencer_profile") return `Profile of ${input?.name || "an influencer"}`;
  if (name === "read_table") return `Read ${input?.table || "a table"}`;
  return name;
}

function clean(row) {
  if (!row) return row;
  const { search, source_upload_id, created_at, updated_at, name_key, ...rest } = row;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) =>
    v != null && v !== "" && !(Array.isArray(v) && v.length === 0)));
}

async function searchPortal(db, { query }) {
  const q = String(query || "").trim();
  if (!q) return { error: "Empty query" };
  const { data, error } = await db.rpc("search_portal", { q, max_results: 30 });
  if (error) return { error: error.message };
  return {
    matches: data.map((r) => ({
      table: r.result_table, id: r.result_id, type: r.result_type,
      title: r.result_title, snippet: r.snippet, date: r.result_date,
    })),
  };
}

async function influencerProfile(db, { name }) {
  const key = aliasKey(name);
  let id = null;
  if (key) {
    const { data: alias } = await db.from("influencer_aliases").select("influencer_id").eq("alias_key", key).maybeSingle();
    id = alias?.influencer_id || null;
    if (!id) {
      const { data } = await db.from("influencers").select("id").eq("name_key", key).maybeSingle();
      id = data?.id || null;
    }
  }
  if (!id && name) {
    const { data } = await db.from("influencers").select("id")
      .ilike("name", `%${String(name).replace(/[%_]/g, "")}%`).limit(1);
    id = data?.[0]?.id || null;
  }
  if (!id) {
    const { data: all } = await db.from("influencers").select("name").order("name").limit(300);
    return { error: `No influencer matches "${name}".`, known_influencers: (all || []).map((a) => a.name) };
  }

  const [profile, budgets, content, aliases, deliverables] = await Promise.all([
    db.from("influencers").select("*").eq("id", id).single(),
    db.from("influencer_budgets").select("*").eq("influencer_id", id).order("period_start", { ascending: true }),
    db.from("influencer_content").select("*").eq("influencer_id", id)
      .order("published_date", { ascending: false, nullsFirst: false }).limit(30),
    db.from("influencer_aliases").select("alias").eq("influencer_id", id),
    db.from("deliverables").select("*").eq("influencer_id", id).order("due_date", { ascending: true, nullsFirst: false }),
  ]);
  return {
    profile: clean(profile.data),
    also_known_as: (aliases.data || []).map((a) => a.alias),
    budget_allocations: (budgets.data || []).map(clean),
    past_content: (content.data || []).map(clean),
    content_tracker: (deliverables.data || []).map(clean),
  };
}

async function readTable(db, allowedTables, input) {
  const table = String(input?.table || "");
  if (!allowedTables.has(table)) {
    return { error: `Unknown table "${table}". Available: ${[...allowedTables].join(", ")}` };
  }
  const cols = Array.isArray(input.columns) ? input.columns.filter((c) => COLUMN_NAME.test(c)) : [];
  let q = db.from(table).select(cols.length ? [...new Set(["id", ...cols])].join(",") : "*");

  for (const f of Array.isArray(input.filters) ? input.filters : []) {
    if (!COLUMN_NAME.test(f?.column || "")) return { error: `Invalid column "${f?.column}"` };
    const v = f.value;
    switch (f.op) {
      case "eq": q = q.eq(f.column, v); break;
      case "neq": q = q.neq(f.column, v); break;
      case "contains_text": q = q.ilike(f.column, `%${String(v ?? "").replace(/[%_]/g, "")}%`); break;
      case "gte": q = q.gte(f.column, v); break;
      case "lte": q = q.lte(f.column, v); break;
      case "list_has": q = q.contains(f.column, [v]); break;
      case "is_empty": q = q.is(f.column, null); break;
      case "not_empty": q = q.not(f.column, "is", null); break;
      default: return { error: `Unknown filter "${f.op}"` };
    }
  }
  if (input.order_by && COLUMN_NAME.test(input.order_by)) {
    q = q.order(input.order_by, { ascending: input.ascending !== false, nullsFirst: false });
  }
  const limit = Math.min(Math.max(parseInt(input.limit, 10) || 50, 1), 200);
  const { data, error } = await q.limit(limit);
  if (error) return { error: error.message };
  return { table, rows_returned: data.length, rows: data.map(clean) };
}
