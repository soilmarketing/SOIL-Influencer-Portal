// Calls the Claude API. The key comes from Vercel's environment variables.
const API_URL = "https://api.anthropic.com/v1/messages";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callClaude(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is missing in Vercel's environment variables.");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();

    const detail = (await res.text()).slice(0, 500);
    if (RETRY_STATUSES.has(res.status) && attempt < 3) {
      await sleep(4000 * attempt); // busy or rate limited: wait and try again
      continue;
    }
    if (res.status === 401) throw new Error("The Claude API key was rejected. Check ANTHROPIC_API_KEY in Vercel.");
    if (res.status === 400 && /credit|billing/i.test(detail)) {
      throw new Error("The Claude API account has no credit left. Add credit in the Claude Console.");
    }
    throw new Error(`Claude API error ${res.status}: ${detail}`);
  }
}
