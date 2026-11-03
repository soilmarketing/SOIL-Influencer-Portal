// =====================================================================
// SOIL Influencer Portal: synthesis configuration (v1)
//
// For each of the eight upload types this file defines:
//   1. the instructions Claude follows
//   2. the exact JSON shape Claude must return (enforced through tool use)
//   3. how that JSON becomes rows in the tables from schema.sql
//
// These are the eight core types. New types that Claude proposes (and you
// approve in the portal) are stored in the content_types table in Supabase
// and handled by types.js, using the same helpers exported from here.
// =====================================================================

export const PROMPT_VERSION = "v1-2026-11-03";

// Confirm the current model name at docs.claude.com before deploying.
export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
export const MAX_OUTPUT_TOKENS = 16000;

// List every SOIL program exactly as you want it stored, so Claude maps
// variations ("PGP in Management", "Post Graduate Program...") to one name.
export const SOIL_PROGRAMS = ["PGPM", "PGPM-HR", "PGDM"];


// ---------------------------------------------------------------------
// Rules that apply to every upload type
// ---------------------------------------------------------------------
export function sharedRules() {
  return `You are the data-extraction step of an internal portal used by the marketing team at SOIL Institute of Management, an MBA school in Delhi-NCR. Your output is saved directly into a database and later used to write marketing content, so accuracy matters more than completeness.

Rules that always apply:
1. Extract only what the document actually says. Never invent, estimate, assume or "fill in" a value. If something is not stated, use null (or an empty list).
2. Copy names, titles, quotes and figures exactly as written. Do not round numbers.
3. In number fields, convert Indian number words to plain numbers: "2.5 lakh" = 250000, "1.2 crore" = 12000000, "12k" = 12000. Where a field ends in _text, also keep the original wording.
4. Write every date as YYYY-MM-DD. Read numeric dates as day/month/year (Indian format), so 05/03/2027 is 5 March 2027. If the year is missing and cannot be worked out with certainty from the document, set the date to null and add a warning.
5. When a program clearly matches one of these SOIL programs, use that exact name: ${SOIL_PROGRAMS.join(", ")}. Otherwise write the program name as it appears in the document. PGPM and PGPM-HR are separate programs: use PGPM-HR only when the document refers to the HR program, and never merge the two.
6. The document may be in English, Hindi or Hinglish. Write summaries and descriptions in English. Keep quotes, hooks and key phrases in their original language.
7. Use the warnings list for anything a person should check: unreadable sections, conflicting figures, unclear dates, names you were unsure about, or totals that do not add up. Do not add warnings just because information is missing.
8. The document may be one section of a longer file. Extract what is in this section only.
9. Always call the save_extraction tool with your result.`;
}


// ---------------------------------------------------------------------
// JSON Schema helpers (every field is required but may be null, so the
// shape Claude returns is always identical)
// ---------------------------------------------------------------------
export const S = (description) => ({ type: ["string", "null"], description });
export const N = (description) => ({ type: ["number", "null"], description });
export const I = (description) => ({ type: ["integer", "null"], description });
export const B = (description) => ({ type: ["boolean", "null"], description });
export const D = (description = "YYYY-MM-DD, or null if not stated") => ({ type: ["string", "null"], description });
export const LIST = (description) => ({ type: "array", items: { type: "string" }, description });
export const ENUM = (values, description) => ({ type: "string", enum: values, description });
export const ENUM_OR_NULL = (values, description) => ({ type: ["string", "null"], enum: [...values, null], description });
export const OBJ = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const ARRAY_OF = (properties, description) => ({ type: "array", items: OBJ(properties), description });
export const WARNINGS = LIST("Things a person should check. Empty list if there are none.");

const PERFORMANCE = OBJ({
  views: I("View count, if stated"),
  likes: I("Like count, if stated"),
  comments: I("Comment count, if stated"),
  shares: I("Share count, if stated"),
});

const PLATFORMS = ["instagram", "youtube", "linkedin", "x", "facebook", "telegram", "whatsapp", "podcast", "blog", "other"];


// ---------------------------------------------------------------------
// Cleaning helpers: the last safety net before anything is saved.
// Anything that fails a check becomes null plus a warning, never bad data.
// ---------------------------------------------------------------------
export const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
export const list = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);

export function isoDate(v, ctx, label) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d) || d.toISOString().slice(0, 10) !== s) {
    ctx.warn(`Invalid date "${s}" for ${label}; saved as empty.`);
    return null;
  }
  return s;
}

export function number(v, ctx, label) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s₹]/g, ""));
  if (!Number.isFinite(n)) {
    ctx.warn(`Invalid number "${v}" for ${label}; saved as empty.`);
    return null;
  }
  return n;
}

export function integer(v, ctx, label) {
  const n = number(v, ctx, label);
  if (n == null) return null;
  if (!Number.isInteger(n)) {
    ctx.warn(`Expected a whole number for ${label}, got ${n}; saved as empty.`);
    return null;
  }
  return n;
}

function performance(p, ctx, label) {
  if (!p) return null;
  const out = {
    views: integer(p.views, ctx, `${label} views`),
    likes: integer(p.likes, ctx, `${label} likes`),
    comments: integer(p.comments, ctx, `${label} comments`),
    shares: integer(p.shares, ctx, `${label} shares`),
  };
  return Object.values(out).some((x) => x != null) ? out : null;
}

function requireText(v, ctx, label) {
  const t = text(v);
  if (!t) ctx.warn(`Skipped an item with no ${label}.`);
  return t;
}


// ---------------------------------------------------------------------
// The eight upload types
// ---------------------------------------------------------------------
export const CONTENT_TYPES = {

  // 1. Influencer details ---------------------------------------------
  influencer_details: {
    label: "Influencer details",
    table: "influencers",
    upsertOn: "name_key", // same influencer uploaded again updates their row
    instructions: `This document contains details about one or more influencers SOIL works with or is considering (for example a spreadsheet export, a media kit or a profile sheet). Create one entry per influencer.
- name: the person's or channel's name as most commonly written in the document.
- handles: every social account listed, one entry per account, with the follower count as a plain number if stated.
- niche: what they create content about, in a few words (for example "MBA admissions and CAT prep").
- audience_description, audience_location, content_style: only if the document describes them.
- Do not merge two different people into one entry. If the same person appears twice, combine them into one entry and add a warning.`,
    schema: OBJ({
      influencers: ARRAY_OF({
        name: { type: "string", description: "Influencer or channel name" },
        handles: ARRAY_OF({
          platform: ENUM(PLATFORMS, "Platform"),
          handle: S("Handle or channel name, as written"),
          url: S("Profile URL, if given"),
          followers: I("Follower or subscriber count, if stated"),
        }, "Every social account listed for this influencer"),
        primary_platform: ENUM_OR_NULL(PLATFORMS, "Their main platform, if clear"),
        niche: S("What they create content about"),
        audience_description: S("Who their audience is, if stated"),
        audience_location: S("Where their audience is, if stated"),
        languages: LIST("Languages they create content in"),
        content_style: S("How they create content, if described"),
        agency: S("Agency or manager company, if any"),
        contact_person: S("Contact person, if different from the influencer"),
        contact_email: S("Contact email"),
        contact_phone: S("Contact phone"),
        city: S("City they are based in"),
        notes: S("Any other useful detail from the document"),
      }, "One entry per influencer"),
      warnings: WARNINGS,
    }),
    toRows(out, ctx) {
      return (out.influencers || []).map((inf) => {
        const name = requireText(inf.name, ctx, "influencer name");
        if (!name) return null;
        const handles = (inf.handles || []).map((h) => ({
          platform: text(h.platform),
          handle: text(h.handle),
          url: text(h.url),
          followers: integer(h.followers, ctx, `${name} followers`),
        }));
        return {
          name,
          handles,
          primary_platform: text(inf.primary_platform),
          niche: text(inf.niche),
          audience_description: text(inf.audience_description),
          audience_location: text(inf.audience_location),
          languages: list(inf.languages),
          content_style: text(inf.content_style),
          agency: text(inf.agency),
          contact_person: text(inf.contact_person),
          contact_email: text(inf.contact_email),
          contact_phone: text(inf.contact_phone),
          city: text(inf.city),
          notes: text(inf.notes),
          source_upload_id: ctx.uploadId,
          updated_at: new Date().toISOString(),
          // Not a column: the saving step writes these to influencer_aliases.
          _aliases: [name, ...handles.map((h) => h.handle).filter(Boolean)],
        };
      }).filter(Boolean);
    },
  },

  // 2. Influencer budget allocation ------------------------------------
  influencer_budget: {
    label: "Influencer budget allocation",
    table: "influencer_budgets",
    resolveInfluencer: true,
    instructions: `This document shows how SOIL's influencer marketing budget is allocated for the year. Create one allocation per influencer per period or campaign.
- If one influencer has separate amounts for different quarters, months or campaigns, create a separate allocation for each.
- amount: the money allocated in that row only, as a plain number in rupees. amount_text: the amount exactly as written.
- Never split, average or distribute a lump sum yourself. If one amount covers several influencers together, create no allocation for it and add a warning.
- total_stated: an overall total only if the document itself states one. Do not calculate it yourself.
- financial_year: for example "2026-27", as written or as shown in the document's heading.`,
    schema: OBJ({
      financial_year: S("Financial year the budget covers, e.g. 2026-27"),
      currency: S("Currency, normally INR"),
      allocations: ARRAY_OF({
        influencer_name: { type: "string", description: "Influencer name exactly as written" },
        period_label: S("Annual, Q1, January 2027, campaign name..."),
        period_start: D(),
        period_end: D(),
        amount: N("Amount as a plain number"),
        amount_text: S("Amount exactly as written"),
        deliverables: S("What is expected for this amount, as written"),
        deliverable_count: I("Number of deliverables, if stated"),
        campaign: S("Campaign name, if any"),
        notes: S("Any other detail in that row"),
      }, "One entry per influencer per period"),
      total_stated: N("Overall total if the document states one, otherwise null"),
      warnings: WARNINGS,
    }),
    toRows(out, ctx) {
      const rows = (out.allocations || []).map((a, i) => {
        const name = requireText(a.influencer_name, ctx, "influencer name");
        if (!name) return null;
        return {
          influencer_name_raw: name,
          financial_year: text(out.financial_year),
          period_label: text(a.period_label),
          period_start: isoDate(a.period_start, ctx, `${name} period start`),
          period_end: isoDate(a.period_end, ctx, `${name} period end`),
          amount: number(a.amount, ctx, `${name} amount (row ${i + 1})`),
          amount_text: text(a.amount_text),
          currency: text(out.currency) || "INR",
          deliverables: text(a.deliverables),
          deliverable_count: integer(a.deliverable_count, ctx, `${name} deliverable count`),
          campaign: text(a.campaign),
          notes: text(a.notes),
          source_upload_id: ctx.uploadId,
        };
      }).filter(Boolean);

      // Cross-check: allocations must add up to the total the file states.
      const stated = number(out.total_stated, ctx, "stated total");
      if (stated != null) {
        const sum = rows.reduce((acc, r) => acc + (r.amount || 0), 0);
        if (Math.abs(sum - stated) > 1) {
          ctx.warn(`Allocations add up to ${sum}, but the file states a total of ${stated}.`);
        }
      }
      rows.forEach((r) => {
        if (r.amount == null) ctx.warn(`No amount saved for ${r.influencer_name_raw} (${r.period_label || "no period"}).`);
      });
      return rows;
    },
  },

  // 3. Transcripts of past influencer content ---------------------------
  influencer_transcript: {
    label: "Transcript of past influencer content",
    table: "influencer_content",
    resolveInfluencer: true,
    instructions: `This document is a transcript, or several transcripts, of content an influencer has already published. SOIL uses this to understand each influencer's voice, so future content suits them. Create one item per piece of content.
- summary: 2 to 4 sentences on what the content says.
- topics: the main subjects covered.
- tone: the voice in a short phrase (for example "casual Hinglish, big-brother advice, fast-paced").
- hooks: the opening lines or attention-grabbing moments, quoted exactly.
- key_phrases: catchphrases or expressions that are characteristic of this person.
- notable_quotes: up to 5 lines worth keeping as reference, quoted exactly.
- call_to_action: what they ask viewers to do, if anything.
- mentions_soil and soil_mentions: whether SOIL is mentioned, and exactly what is said about it.
- performance: only if view, like, comment or share counts appear in the document.`,
    schema: OBJ({
      items: ARRAY_OF({
        influencer_name: S("Influencer name, if shown in the document"),
        platform: ENUM_OR_NULL(PLATFORMS, "Where it was published"),
        content_format: S("reel, YouTube video, short, post, live, podcast episode..."),
        published_date: D(),
        title: S("Title or caption headline, if any"),
        summary: { type: "string", description: "2 to 4 sentences on what it says" },
        topics: LIST("Main subjects"),
        tone: S("Voice and style in a short phrase"),
        hooks: LIST("Opening lines and attention-grabbing moments, quoted exactly"),
        key_phrases: LIST("Characteristic expressions"),
        notable_quotes: LIST("Up to 5 lines worth keeping, quoted exactly"),
        call_to_action: S("What viewers are asked to do"),
        mentions_soil: B("Whether SOIL is mentioned"),
        soil_mentions: S("Exactly what is said about SOIL"),
        programs_mentioned: LIST("SOIL programs named"),
        performance: PERFORMANCE,
      }, "One item per piece of content"),
      warnings: WARNINGS,
    }),
    toRows(out, ctx) {
      return (out.items || []).map((it, i) => {
        const name = text(it.influencer_name) || ctx.influencerName || null;
        if (!name) ctx.warn(`Content item ${i + 1} has no influencer name.`);
        return {
          influencer_name_raw: name,
          platform: text(it.platform),
          content_format: text(it.content_format),
          published_date: isoDate(it.published_date, ctx, `item ${i + 1} date`),
          title: text(it.title),
          summary: text(it.summary),
          topics: list(it.topics),
          tone: text(it.tone),
          hooks: list(it.hooks),
          key_phrases: list(it.key_phrases),
          notable_quotes: list(it.notable_quotes).slice(0, 5),
          call_to_action: text(it.call_to_action),
          mentions_soil: typeof it.mentions_soil === "boolean" ? it.mentions_soil : null,
          soil_mentions: text(it.soil_mentions),
          programs_mentioned: list(it.programs_mentioned),
          performance: performance(it.performance, ctx, `item ${i + 1}`),
          source_upload_id: ctx.uploadId,
        };
      });
    },
  },

  // 4 and 5. Calendars ---------------------------------------------------
  calendar_current: calendarType(false),
  calendar_previous: calendarType(true),

  // 6. Brochures and reports ---------------------------------------------
  brochure_report: {
    label: "Program brochure or report",
    table: "knowledge_items",
    instructions: `This document is a SOIL program brochure or report (for example a placement report). Break it into individual facts the marketing team can search and quote.
- Each fact is one self-contained sentence that makes sense on its own, naming the program and year wherever the document gives them. Write "The PGPM 2025-27 batch has N students", not "The batch has N students".
- One claim per fact.
- figures: every number in that fact, with a label and unit (for example label "average CTC", value 1200000, unit "INR per year").
- Rankings, accreditations and awards: state exactly as written, including who gave them and the year.
- Placement figures: keep the batch, the measure (average, median, highest) and any stated conditions exactly as given.
- source_page: the page number, if visible.
- Skip slogans with no information, decorative text and repeated content.`,
    schema: OBJ({
      document_title: S("Title of the brochure or report"),
      document_kind: S("brochure, placement report, annual report, fact sheet, other"),
      program: S("Main program the document is about, if one"),
      academic_year: S("Year or batch the document covers"),
      facts: ARRAY_OF({
        category: ENUM([
          "fees", "placements", "curriculum", "specialisations", "faculty",
          "admissions", "eligibility", "selection_process", "scholarships",
          "rankings_accreditation", "infrastructure", "partnerships",
          "international", "student_life", "outcomes", "other",
        ], "Closest category"),
        fact: { type: "string", description: "One self-contained sentence" },
        program: S("Program this fact is about, if specific"),
        figures: ARRAY_OF({
          label: { type: "string", description: "What the number measures" },
          value: { type: "number", description: "The number" },
          unit: S("INR, INR per year, %, students, companies..."),
        }, "Every number in this fact"),
        source_page: I("Page number, if visible"),
      }, "One entry per fact"),
      warnings: WARNINGS,
    }),
    toRows(out, ctx) {
      return (out.facts || []).map((f) => {
        const fact = requireText(f.fact, ctx, "fact text");
        if (!fact) return null;
        return {
          document_title: text(out.document_title),
          document_kind: text(out.document_kind),
          category: text(f.category) || "other",
          program: text(f.program) || text(out.program),
          academic_year: text(out.academic_year),
          fact,
          figures: (f.figures || [])
            .map((g) => ({ label: text(g.label), value: number(g.value, ctx, g.label || "figure"), unit: text(g.unit) }))
            .filter((g) => g.label && g.value != null),
          source_page: integer(f.source_page, ctx, "source page"),
          source_upload_id: ctx.uploadId,
        };
      }).filter(Boolean);
    },
  },

  // 7. SOIL's own social posts ---------------------------------------------
  social_post: {
    label: "SOIL social media posts",
    table: "social_posts",
    instructions: `This document contains posts SOIL has published on its own social media (exports, screenshots or copied captions). Create one entry per post.
- theme: what the post is about, in a few words.
- summary: one or two sentences.
- caption_text: the full caption exactly as written, if visible.
- post_format: reel, carousel, image, video, text, story, article, poll or similar.
- people_featured: names of anyone shown or tagged.`,
    schema: OBJ({
      posts: ARRAY_OF({
        platform: ENUM_OR_NULL(PLATFORMS, "Platform"),
        posted_date: D(),
        post_format: S("reel, carousel, image, video, text, story, article, poll..."),
        theme: S("What the post is about"),
        summary: S("One or two sentences"),
        caption_text: S("Full caption exactly as written"),
        hashtags: LIST("Hashtags used, without the # sign"),
        programs_mentioned: LIST("SOIL programs named"),
        people_featured: LIST("People shown or tagged"),
        call_to_action: S("What the post asks people to do"),
        link_url: S("Link in the post, if any"),
        performance: PERFORMANCE,
      }, "One entry per post"),
      warnings: WARNINGS,
    }),
    toRows(out, ctx) {
      return (out.posts || []).map((p, i) => ({
        platform: text(p.platform),
        posted_date: isoDate(p.posted_date, ctx, `post ${i + 1} date`),
        post_format: text(p.post_format),
        theme: text(p.theme),
        summary: text(p.summary),
        caption_text: text(p.caption_text),
        hashtags: list(p.hashtags).map((h) => h.replace(/^#/, "")),
        programs_mentioned: list(p.programs_mentioned),
        people_featured: list(p.people_featured),
        call_to_action: text(p.call_to_action),
        link_url: text(p.link_url),
        performance: performance(p.performance, ctx, `post ${i + 1}`),
        source_upload_id: ctx.uploadId,
      }));
    },
  },

  // 8. Alumni activity ---------------------------------------------------
  alumni_activity: {
    label: "Alumni activity",
    table: "alumni_activity",
    instructions: `This document describes recent activity by SOIL alumni (for example new jobs, promotions, awards, startups, media features, talks or campus visits). Create one entry per activity.
- summary: one or two sentences on what happened, using only facts in the document.
- story_angle: one line on how the marketing team could use this, staying strictly within the facts. Do not exaggerate titles, company size or impact.
- batch: as written, for example "2019-21".`,
    schema: OBJ({
      activities: ARRAY_OF({
        alumnus_name: { type: "string", description: "Name as written" },
        batch: S("Batch, e.g. 2019-21"),
        program: S("SOIL program they completed"),
        job_title: S("Current job title"),
        company: S("Current organisation"),
        activity_type: ENUM(
          ["new_role", "promotion", "award", "startup", "media_feature", "speaking", "campus_visit", "publication", "other"],
          "Closest activity type"),
        activity_date: D(),
        summary: S("What happened"),
        story_angle: S("How this could be used, within the facts"),
        source_link: S("Link to the source, if given"),
      }, "One entry per activity"),
      warnings: WARNINGS,
    }),
    toRows(out, ctx) {
      return (out.activities || []).map((a, i) => {
        const name = requireText(a.alumnus_name, ctx, "alumnus name");
        if (!name) return null;
        return {
          alumnus_name: name,
          batch: text(a.batch),
          program: text(a.program),
          job_title: text(a.job_title),
          company: text(a.company),
          activity_type: text(a.activity_type) || "other",
          activity_date: isoDate(a.activity_date, ctx, `${name} activity date`),
          summary: text(a.summary),
          story_angle: text(a.story_angle),
          source_link: text(a.source_link),
          source_upload_id: ctx.uploadId,
        };
      }).filter(Boolean);
    },
  },
};


// Calendars share one definition; only the year flag differs.
function calendarType(isPrevious) {
  const which = isPrevious ? "previous year's" : "current";
  return {
    label: isPrevious ? "Previous year calendar" : "Current SOIL calendar",
    table: "calendar_events",
    instructions: `This document is SOIL's ${which} calendar. Create one event for every dated item: application deadlines, admission rounds, entrance exams, interviews, results, fee deadlines, orientation, term dates, exams, holidays, placement activity, convocation, events and webinars.
- title: short and specific, for example "PGPM Round 2 application deadline".
- event_date is the start date. Use end_date only for date ranges.
- If only the month is given, use the first day of that month and set date_is_approximate to true.
- program: only if the event applies to a specific program; null if it applies to all.
- Include every event, even ones that seem minor.`,
    schema: OBJ({
      academic_year: S("Year the calendar covers, e.g. 2026-27"),
      events: ARRAY_OF({
        title: { type: "string", description: "Short, specific title" },
        category: ENUM([
          "application_deadline", "admission_round", "entrance_exam", "interview",
          "result", "fee_deadline", "orientation", "term_start", "term_end", "exam",
          "holiday", "placement", "convocation", "event", "webinar", "other",
        ], "Closest category"),
        event_date: { type: "string", description: "Start date, YYYY-MM-DD" },
        end_date: D("End date for ranges, YYYY-MM-DD, otherwise null"),
        date_is_approximate: { type: "boolean", description: "True if only the month was given" },
        time_text: S("Time, as written"),
        program: S("Program, or null if it applies to all"),
        description: S("Any further detail"),
      }, "One entry per dated item"),
      warnings: WARNINGS,
    }),
    toRows(out, ctx) {
      return (out.events || []).map((e) => {
        const title = requireText(e.title, ctx, "event title");
        if (!title) return null;
        const event_date = isoDate(e.event_date, ctx, `"${title}" date`);
        if (!event_date) {
          ctx.warn(`Skipped "${title}" because it has no valid date.`);
          return null;
        }
        let end_date = isoDate(e.end_date, ctx, `"${title}" end date`);
        if (end_date && end_date < event_date) {
          ctx.warn(`"${title}" ends before it starts; end date removed.`);
          end_date = null;
        }
        return {
          title,
          category: text(e.category) || "other",
          event_date,
          end_date,
          date_is_approximate: e.date_is_approximate === true,
          time_text: text(e.time_text),
          program: text(e.program),
          academic_year: text(out.academic_year),
          is_previous_year: isPrevious,
          description: text(e.description),
          source_upload_id: ctx.uploadId,
        };
      }).filter(Boolean);
    },
  };
}


// ---------------------------------------------------------------------
// Building the Claude request and reading the result
// ---------------------------------------------------------------------

// documentBlocks: the file as Claude API content blocks, prepared by the
// processing function (a document block for PDFs, image blocks for
// screenshots, a text block for transcripts and converted spreadsheets).
// typeDef: an entry from CONTENT_TYPES, or a custom type built by types.js.
export function buildClaudeRequest(t, documentBlocks, extra = {}) {

  const context = [
    `Upload type: ${t.label}.`,
    extra.fileName && `File name: ${extra.fileName}.`,
    extra.influencerName && `This file is about the influencer: ${extra.influencerName}.`,
    extra.uploaderNotes && `Notes from the person who uploaded it: ${extra.uploaderNotes}`,
    extra.sectionInfo && `This is ${extra.sectionInfo} of the document.`,
  ].filter(Boolean).join("\n");

  return {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: `${sharedRules()}\n\n${t.instructions}`,
    tools: [{
      name: "save_extraction",
      description: `Save the extracted ${t.label.toLowerCase()} data to the SOIL portal database.`,
      input_schema: t.schema,
    }],
    tool_choice: { type: "tool", name: "save_extraction" },
    messages: [{
      role: "user",
      content: [
        ...documentBlocks,
        { type: "text", text: `${context}\n\nExtract the data from this document and call save_extraction.` },
      ],
    }],
  };
}

// Pulls the structured result out of the API response.
export function readToolOutput(apiResponse) {
  if (apiResponse?.stop_reason === "max_tokens") {
    throw new Error("Claude's output was cut off because the section was too long. Split it into smaller sections and retry.");
  }
  const block = apiResponse?.content?.find((b) => b.type === "tool_use" && b.name === "save_extraction");
  if (!block) throw new Error("Claude did not return structured output.");
  return block.input;
}

// Converts Claude's output into rows for the target table, collecting
// Claude's own warnings plus any raised by the checks above.
export function toRowsFor(t, output, { uploadId, influencerName } = {}) {
  const warnings = list(output?.warnings);
  const ctx = { uploadId, influencerName, warn: (m) => warnings.push(m) };
  const rows = t.toRows(output || {}, ctx);
  return {
    table: t.table,
    upsertOn: t.upsertOn || null,
    resolveInfluencer: Boolean(t.resolveInfluencer),
    rows,
    warnings,
  };
}
