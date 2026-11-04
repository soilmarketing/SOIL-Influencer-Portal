# SOIL Influencer Portal

An internal portal where the SOIL marketing team uploads content (influencer details and transcripts, budgets, calendars, brochures, social posts, alumni news). Claude synthesizes each file into structured data and saves it in Supabase. If a file doesn't fit any existing table, Claude proposes a new one, which is created only after someone approves it in the portal.

## What's in this repo

| Path | What it is | Where it runs |
|---|---|---|
| `index.html` | The portal: sign in, Ask Claude, upload, uploads list, search, browse, manage tables | Your team's browser |
| `api/ask.js` | The Ask Claude tab: Claude looks up portal data, then answers or creates content | Vercel (server) |
| `api/process.js` | Registers uploads, asks Claude where new files belong, synthesizes each section | Vercel (server) |
| `api/approve.js` | Creates a new table once you approve Claude's proposal | Vercel (server) |
| `api/manage.js` | Reprocess or delete uploads, clear or delete tables | Vercel (server) |
| `api/_lib/synthesis-config.js` | Instructions and output shapes for the eight core content types | Vercel (server) |
| `api/_lib/types.js` | Custom content types, and the "where does this belong" step | Vercel (server) |
| `api/_lib/convert-file.js` | Turns PDFs, Word, Excel, text and images into sections Claude can read | Vercel (server) |
| `api/_lib/save-rows.js` | Checks, matches influencer names, saves rows | Vercel (server) |
| `api/_lib/ask-tools.js` | The read-only lookups Claude can use in the Ask Claude tab | Vercel (server) |
| `api/_lib/claude.js`, `api/_lib/supabase.js` | Claude API calls and Supabase access | Vercel (server) |
| `supabase/schema.sql` | Database setup. Run it once in Supabase; it is not deployed | Supabase |
| `package.json`, `vercel.json` | Libraries and function settings | Vercel |

Files in `api/_lib/` are not public web addresses; Vercel only uses them inside the functions.

## Going live

### 1. Supabase
1. Create a new project (region: Mumbai).
2. SQL Editor > New query > paste all of `supabase/schema.sql` > Run.
3. Authentication: turn off "Allow new users to sign up", then add each team member under Users > Add user > Create new user, with Auto Confirm ticked.
4. Project Settings > API: note the Project URL, the anon (publishable) key and the service_role (secret) key.

### 2. Two edits before pushing
1. In `index.html`, near the bottom, fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY`. These two are safe to be public.
2. In `api/_lib/synthesis-config.js`, list every SOIL program in `SOIL_PROGRAMS`, and confirm the `MODEL` name at docs.claude.com.

Never put the service_role key or the Claude API key in any file.

### 3. GitHub
Create an empty repo (for example `soilmarketing/influencer-portal`), clone it, copy these files in, commit and push.

### 4. Vercel
1. Add New > Project > import the repo. No build settings needed.
2. Settings > Environment Variables, add:
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Deploy. If Vercel rejects `maxDuration` in `vercel.json` because of your plan's limit, lower 300 to the maximum it allows and redeploy.

### 5. Test
Sign in and upload one small file of each kind, starting with influencer details (so later budgets and transcripts can match names). Then try "Something else, let Claude decide" with a file that fits none of the types, to see the approval flow.

## How a file is processed
1. The browser uploads the file straight to Supabase Storage (bucket `portal-uploads`).
2. `api/process` registers it. With "let Claude decide", Claude either matches it to an existing type or proposes a new table, which waits for your approval.
3. The browser calls `api/process` once per section of the file (10 PDF pages or about 30,000 characters each), so long files never hit server time limits. If the browser is closed part way, open Uploads and click Continue processing.
4. When the last section is done, the results are combined, checked, and saved. Anything that needs a person's attention appears as a warning on the upload.

## Supported files
PDF, Word (.docx), Excel (.xlsx, .xls), CSV, TSV, text, Markdown, transcripts (.srt, .vtt), JSON and images. Audio and video need a transcript first. PowerPoint should be exported as PDF. Google Docs and Sheets should be downloaded as .docx or .xlsx.
