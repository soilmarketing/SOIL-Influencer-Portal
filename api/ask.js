// POST /api/ask
//   { messages: [{ role: "user" | "assistant", content: "..." }, ...] }
// Claude looks up whatever it needs in the portal's data, then answers.
// Returns { answer, lookedAt }.
import { getAdmin, requireUser } from "./_lib/supabase.js";
import { callClaude } from "./_lib/claude.js";
import { MODEL } from "./_lib/synthesis-config.js";
import { buildAskContext, ASK_TOOLS, runAskTool, describeToolUse } from "./_lib/ask-tools.js";

const MAX_LOOKUP_ROUNDS = 6;
const TIME_BUDGET_MS = 200000; // stop looking things up well before the server time limit
const MAX_HISTORY = 16;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const history = cleanHistory(req.body?.messages);
    if (!history.length || history[history.length - 1].role !== "user") {
      return res.status(400).json({ error: "Type a question or request first." });
    }

    const db = getAdmin();
    const { system, allowedTables } = await buildAskContext(db);
    const messages = history.map((m) => ({ role: m.role, content: m.content }));
    const lookedAt = [];
    const started = Date.now();

    for (let round = 0; ; round++) {
      const response = await callClaude({ model: MODEL, max_tokens: 8000, system, tools: ASK_TOOLS, messages });

      if (response.stop_reason !== "tool_use") {
        const answer = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        return res.status(200).json({
          answer: answer || "I couldn't put an answer together. Try rephrasing the request.",
          lookedAt: [...new Set(lookedAt)],
          truncated: response.stop_reason === "max_tokens",
        });
      }

      // Claude asked to look something up: run the lookups and hand back the results.
      messages.push({ role: "assistant", content: response.content });
      const results = [];
      for (const block of response.content.filter((b) => b.type === "tool_use")) {
        lookedAt.push(describeToolUse(block.name, block.input));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: await runAskTool(db, allowedTables, block.name, block.input),
        });
      }
      const outOfTime = round + 1 >= MAX_LOOKUP_ROUNDS || Date.now() - started > TIME_BUDGET_MS;
      if (outOfTime) {
        results.push({ type: "text", text: "That's enough looking up. Write your final answer now using what you have found." });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}

function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  let msgs = raw
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }))
    .slice(-MAX_HISTORY);
  while (msgs.length && msgs[0].role !== "user") msgs = msgs.slice(1);
  // Merge any back-to-back messages from the same side.
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}
