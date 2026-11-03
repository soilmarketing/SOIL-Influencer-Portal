-- =====================================================================
-- SOIL Influencer Portal: Supabase schema (v2)
-- Run once in Supabase: SQL Editor > New query > paste everything > Run.
-- =====================================================================

create extension if not exists pgcrypto;

-- Helper for the search columns. Generated columns need immutable
-- expressions, and array_to_string on its own is not marked immutable.
create or replace function public.arr_text(arr text[])
returns text
language sql immutable parallel safe
as $$ select coalesce(array_to_string(arr, ' '), '') $$;


-- ---------------------------------------------------------------------
-- 0. content_types: the list of everything the portal knows how to
--    synthesize. The eight core types are added below; new types that
--    you approve in the portal are added by create_custom_table().
-- ---------------------------------------------------------------------
create table public.content_types (
  key                 text primary key,
  label               text not null,
  table_name          text not null,
  is_core             boolean not null default false,
  description         text,     -- what this content is; Claude reads it when sorting new uploads
  instructions        text,     -- extraction instructions (custom types; core types keep theirs in code)
  columns             jsonb,    -- [{name, type, description}] (custom types)
  title_column        text,     -- used in search results (custom types)
  snippet_column      text,
  created_from_upload uuid,
  created_at          timestamptz not null default now()
);

insert into public.content_types (key, label, table_name, is_core, description) values
  ('influencer_details',    'Influencer details',                    'influencers',        true,
   'Profiles of influencers: names, social handles, follower counts, niche, audience and contact details.'),
  ('influencer_budget',     'Influencer budget allocation',          'influencer_budgets', true,
   'Money allocated to each influencer for the year, by period or campaign, with deliverables.'),
  ('influencer_transcript', 'Transcript of past influencer content', 'influencer_content', true,
   'Transcripts of videos, reels, podcasts or posts that influencers have already published.'),
  ('calendar_current',      'Current SOIL calendar',                 'calendar_events',    true,
   'This year''s SOIL calendar: application deadlines, admission rounds, term dates, exams and events.'),
  ('calendar_previous',     'Previous year calendar',                'calendar_events',    true,
   'Last year''s SOIL calendar, kept for comparison with the current one.'),
  ('brochure_report',       'Program brochure or report',            'knowledge_items',    true,
   'SOIL program brochures, placement reports, annual reports and fact sheets.'),
  ('social_post',           'SOIL social media posts',               'social_posts',       true,
   'Posts SOIL has published on its own social media accounts.'),
  ('alumni_activity',       'Alumni activity',                       'alumni_activity',    true,
   'News about SOIL alumni: new roles, promotions, awards, startups, media features and talks.');


-- ---------------------------------------------------------------------
-- 1. uploads: one row per file uploaded through the portal
-- ---------------------------------------------------------------------
create table public.uploads (
  id                    uuid primary key default gen_random_uuid(),
  content_type          text references public.content_types(key) on delete cascade, -- null while Claude decides
  requested_type        text not null,          -- what was picked at upload; 'auto' means let Claude decide
  file_name             text not null,
  storage_path          text not null,          -- path inside the portal-uploads bucket
  mime_type             text,
  file_size             bigint,
  notes                 text,                   -- anything the uploader typed about the file
  influencer_id         uuid,                   -- optional, picked at upload time for transcripts
  status                text not null default 'pending' check (status in (
                          'pending', 'awaiting_approval', 'processing',
                          'done', 'needs_review', 'failed', 'rejected')),
  error                 text,
  warnings              jsonb not null default '[]'::jsonb,
  classification_reason text,                   -- why Claude picked a type or proposed a new one
  proposal              jsonb,                  -- the new table Claude proposed, awaiting approval
  sections_total        int,
  sections_done         int not null default 0,
  section_outputs       jsonb not null default '[]'::jsonb,  -- work in progress for long files
  raw_output            jsonb,                  -- Claude's full structured output, kept for re-runs
  rows_created          int not null default 0,
  prompt_version        text,
  model                 text,
  replaces_upload_id    uuid references public.uploads(id) on delete set null,
  is_current            boolean not null default true,
  uploaded_at           timestamptz not null default now(),
  processed_at          timestamptz
);


-- ---------------------------------------------------------------------
-- 2. influencers: master list, one row per influencer
-- ---------------------------------------------------------------------
create table public.influencers (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  name_key             text generated always as
                         (lower(regexp_replace(name, '[^[:alnum:]]+', '', 'g'))) stored,
  handles              jsonb not null default '[]'::jsonb,  -- [{platform, handle, url, followers}]
  primary_platform     text,
  niche                text,
  audience_description text,
  audience_location    text,
  languages            text[] not null default '{}',
  content_style        text,
  agency               text,
  contact_person       text,
  contact_email        text,
  contact_phone        text,
  city                 text,
  notes                text,
  source_upload_id     uuid references public.uploads(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  search               tsvector generated always as (to_tsvector('english',
                         coalesce(name, '') || ' ' || coalesce(niche, '') || ' ' ||
                         coalesce(audience_description, '') || ' ' || coalesce(content_style, '') || ' ' ||
                         coalesce(city, '') || ' ' || coalesce(notes, '') || ' ' ||
                         public.arr_text(languages))) stored,
  constraint influencers_name_key_unique unique (name_key),
  constraint influencers_name_key_not_empty check (name_key <> '')
);

alter table public.uploads
  add constraint uploads_influencer_fk
  foreign key (influencer_id) references public.influencers(id) on delete set null;

-- Every way an influencer gets referred to (name, handles), so
-- "Rahul Sharma" and "@rahulsharma.mba" resolve to the same person.
create table public.influencer_aliases (
  alias_key     text primary key,   -- lowercased, letters and digits only
  alias         text not null,      -- as originally written
  influencer_id uuid not null references public.influencers(id) on delete cascade
);


-- ---------------------------------------------------------------------
-- 3. influencer_budgets
-- ---------------------------------------------------------------------
create table public.influencer_budgets (
  id                  uuid primary key default gen_random_uuid(),
  influencer_id       uuid references public.influencers(id) on delete set null,
  influencer_name_raw text not null,
  financial_year      text,
  period_label        text,
  period_start        date,
  period_end          date,
  amount              numeric(14, 2) check (amount is null or amount >= 0),
  amount_text         text,
  currency            text not null default 'INR',
  deliverables        text,
  deliverable_count   int,
  campaign            text,
  notes               text,
  source_upload_id    uuid not null references public.uploads(id) on delete cascade,
  created_at          timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 4. influencer_content: past content, synthesized from transcripts
-- ---------------------------------------------------------------------
create table public.influencer_content (
  id                  uuid primary key default gen_random_uuid(),
  influencer_id       uuid references public.influencers(id) on delete set null,
  influencer_name_raw text,
  platform            text,
  content_format      text,
  published_date      date,
  title               text,
  summary             text,
  topics              text[] not null default '{}',
  tone                text,
  hooks               text[] not null default '{}',
  key_phrases         text[] not null default '{}',
  notable_quotes      text[] not null default '{}',
  call_to_action      text,
  mentions_soil       boolean,
  soil_mentions       text,
  programs_mentioned  text[] not null default '{}',
  performance         jsonb,
  source_upload_id    uuid not null references public.uploads(id) on delete cascade,
  created_at          timestamptz not null default now(),
  search              tsvector generated always as (to_tsvector('english',
                        coalesce(influencer_name_raw, '') || ' ' || coalesce(title, '') || ' ' ||
                        coalesce(summary, '') || ' ' || coalesce(tone, '') || ' ' ||
                        coalesce(soil_mentions, '') || ' ' || public.arr_text(topics) || ' ' ||
                        public.arr_text(hooks) || ' ' || public.arr_text(key_phrases) || ' ' ||
                        public.arr_text(programs_mentioned))) stored
);


-- ---------------------------------------------------------------------
-- 5. calendar_events: current and previous year calendars together
-- ---------------------------------------------------------------------
create table public.calendar_events (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  category            text not null check (category in (
                        'application_deadline', 'admission_round', 'entrance_exam', 'interview',
                        'result', 'fee_deadline', 'orientation', 'term_start', 'term_end', 'exam',
                        'holiday', 'placement', 'convocation', 'event', 'webinar', 'other')),
  event_date          date not null,
  end_date            date,
  date_is_approximate boolean not null default false,
  time_text           text,
  program             text,
  academic_year       text,
  is_previous_year    boolean not null,
  description         text,
  source_upload_id    uuid not null references public.uploads(id) on delete cascade,
  created_at          timestamptz not null default now(),
  search              tsvector generated always as (to_tsvector('english',
                        coalesce(title, '') || ' ' || coalesce(category, '') || ' ' ||
                        coalesce(program, '') || ' ' || coalesce(description, ''))) stored,
  constraint calendar_end_after_start check (end_date is null or end_date >= event_date)
);


-- ---------------------------------------------------------------------
-- 6. knowledge_items: individual facts from brochures and reports
-- ---------------------------------------------------------------------
create table public.knowledge_items (
  id                  uuid primary key default gen_random_uuid(),
  document_title      text,
  document_kind       text,
  category            text not null check (category in (
                        'fees', 'placements', 'curriculum', 'specialisations', 'faculty',
                        'admissions', 'eligibility', 'selection_process', 'scholarships',
                        'rankings_accreditation', 'infrastructure', 'partnerships',
                        'international', 'student_life', 'outcomes', 'other')),
  program             text,
  academic_year       text,
  fact                text not null,
  figures             jsonb not null default '[]'::jsonb,
  source_page         int,
  source_upload_id    uuid not null references public.uploads(id) on delete cascade,
  created_at          timestamptz not null default now(),
  search              tsvector generated always as (to_tsvector('english',
                        coalesce(fact, '') || ' ' || coalesce(category, '') || ' ' ||
                        coalesce(program, '') || ' ' || coalesce(document_title, ''))) stored
);


-- ---------------------------------------------------------------------
-- 7. social_posts: SOIL's own recent posts
-- ---------------------------------------------------------------------
create table public.social_posts (
  id                  uuid primary key default gen_random_uuid(),
  platform            text,
  posted_date         date,
  post_format         text,
  theme               text,
  summary             text,
  caption_text        text,
  hashtags            text[] not null default '{}',
  programs_mentioned  text[] not null default '{}',
  people_featured     text[] not null default '{}',
  call_to_action      text,
  link_url            text,
  performance         jsonb,
  source_upload_id    uuid not null references public.uploads(id) on delete cascade,
  created_at          timestamptz not null default now(),
  search              tsvector generated always as (to_tsvector('english',
                        coalesce(theme, '') || ' ' || coalesce(summary, '') || ' ' ||
                        coalesce(caption_text, '') || ' ' || public.arr_text(hashtags) || ' ' ||
                        public.arr_text(programs_mentioned) || ' ' ||
                        public.arr_text(people_featured))) stored
);


-- ---------------------------------------------------------------------
-- 8. alumni_activity
-- ---------------------------------------------------------------------
create table public.alumni_activity (
  id                  uuid primary key default gen_random_uuid(),
  alumnus_name        text not null,
  batch               text,
  program             text,
  job_title           text,
  company             text,
  activity_type       text not null check (activity_type in (
                        'new_role', 'promotion', 'award', 'startup', 'media_feature',
                        'speaking', 'campus_visit', 'publication', 'other')),
  activity_date       date,
  summary             text,
  story_angle         text,
  source_link         text,
  source_upload_id    uuid not null references public.uploads(id) on delete cascade,
  created_at          timestamptz not null default now(),
  search              tsvector generated always as (to_tsvector('english',
                        coalesce(alumnus_name, '') || ' ' || coalesce(program, '') || ' ' ||
                        coalesce(job_title, '') || ' ' || coalesce(company, '') || ' ' ||
                        coalesce(summary, '') || ' ' || coalesce(story_angle, ''))) stored
);


-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------
create index on public.uploads (content_type, is_current);
create index on public.uploads (status);
create index on public.uploads (uploaded_at desc);
create index on public.influencer_aliases (influencer_id);
create index on public.influencers using gin (search);
create index on public.influencer_budgets (influencer_id);
create index on public.influencer_budgets (source_upload_id);
create index on public.influencer_content (influencer_id);
create index on public.influencer_content (source_upload_id);
create index on public.influencer_content using gin (search);
create index on public.calendar_events (event_date);
create index on public.calendar_events (source_upload_id);
create index on public.calendar_events using gin (search);
create index on public.knowledge_items (category, program);
create index on public.knowledge_items (source_upload_id);
create index on public.knowledge_items using gin (search);
create index on public.social_posts (posted_date);
create index on public.social_posts (source_upload_id);
create index on public.social_posts using gin (search);
create index on public.alumni_activity (activity_date);
create index on public.alumni_activity (source_upload_id);
create index on public.alumni_activity using gin (search);


-- ---------------------------------------------------------------------
-- Access: anyone signed in to the portal can read everything.
-- All writes happen in the backend using the service role key.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'content_types', 'uploads', 'influencers', 'influencer_aliases', 'influencer_budgets',
    'influencer_content', 'calendar_events', 'knowledge_items',
    'social_posts', 'alumni_activity'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "signed-in team can read" on public.%I for select to authenticated using (true)', t);
  end loop;
end
$$;


-- =====================================================================
-- Functions used by the backend (not callable from the browser)
-- =====================================================================

-- Removes everything one upload produced, in every table (core and
-- custom). Influencer master records are kept, since other uploads may
-- refer to them.
create or replace function public.clear_upload_rows(p_upload_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t text;
begin
  for t in
    select distinct c.table_name from public.content_types c where c.table_name <> 'influencers'
  loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('delete from public.%I where source_upload_id = $1', t) using p_upload_id;
    end if;
  end loop;
  update public.uploads set rows_created = 0 where id = p_upload_id;
end
$$;


-- Creates a new table from a definition Claude proposed and you approved.
-- Claude never writes SQL: this function builds the table itself, and
-- only allows safe names and a fixed set of column types.
create or replace function public.create_custom_table(
  p_table          text,
  p_label          text,
  p_description    text,
  p_instructions   text,
  p_columns        jsonb,
  p_title_column   text default null,
  p_snippet_column text default null,
  p_upload_id      uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  col          jsonb;
  col_name     text;
  col_type     text;
  sql_type     text;
  col_defs     text := '';
  names        text[] := '{}';
  text_names   text[] := '{}';
  search_parts text[] := '{}';
  search_expr  text;
begin
  if p_table is null or p_table !~ '^custom_[a-z][a-z0-9_]{0,40}$' then
    raise exception 'Table name must start with custom_ and use only lowercase letters, digits and underscores (got %)', coalesce(p_table, 'nothing');
  end if;
  if exists (select 1 from public.content_types where key = p_table or table_name = p_table)
     or to_regclass(format('public.%I', p_table)) is not null then
    raise exception 'A table named % already exists', p_table;
  end if;
  if coalesce(trim(p_label), '') = '' then
    raise exception 'The new content type needs a name';
  end if;
  if coalesce(trim(p_instructions), '') = '' then
    raise exception 'The new content type needs extraction instructions';
  end if;
  if p_columns is null or jsonb_typeof(p_columns) <> 'array'
     or jsonb_array_length(p_columns) < 1 or jsonb_array_length(p_columns) > 40 then
    raise exception 'A table needs between 1 and 40 columns';
  end if;

  for col in select value from jsonb_array_elements(p_columns) loop
    col_name := col->>'name';
    col_type := col->>'type';
    if col_name is null or col_name !~ '^[a-z][a-z0-9_]{0,40}$' then
      raise exception 'Invalid column name: %', coalesce(col_name, '(empty)');
    end if;
    if col_name in ('id', 'source_upload_id', 'created_at', 'search') or col_name = any(names) then
      raise exception 'Column name % is reserved or used twice', col_name;
    end if;
    sql_type := case col_type
      when 'text'      then 'text'
      when 'long_text' then 'text'
      when 'integer'   then 'bigint'
      when 'number'    then 'numeric'
      when 'date'      then 'date'
      when 'boolean'   then 'boolean'
      when 'list'      then 'text[]'
      else null end;
    if sql_type is null then
      raise exception 'Column type % is not allowed (column %)', coalesce(col_type, '(empty)'), col_name;
    end if;
    names := names || col_name;
    col_defs := col_defs || format(', %I %s', col_name, sql_type);
    if col_type in ('text', 'long_text') then
      text_names := text_names || col_name;
      search_parts := search_parts || format('coalesce(%I, %L)', col_name, '');
    elsif col_type = 'list' then
      search_parts := search_parts || format('public.arr_text(%I)', col_name);
    end if;
  end loop;

  if p_title_column is not null and not (p_title_column = any(text_names)) then
    raise exception 'The title column must be one of the text columns';
  end if;
  if p_snippet_column is not null and not (p_snippet_column = any(text_names)) then
    raise exception 'The summary column must be one of the text columns';
  end if;
  if p_title_column is null and array_length(text_names, 1) >= 1 then
    p_title_column := text_names[1];
  end if;
  if p_snippet_column is null and array_length(text_names, 1) >= 2 then
    p_snippet_column := text_names[2];
  end if;

  if array_length(search_parts, 1) is null then
    search_expr := $q$to_tsvector('english', '')$q$;
  else
    search_expr := format('to_tsvector(%L, %s)', 'english', array_to_string(search_parts, ' || '' '' || '));
  end if;

  execute format(
    'create table public.%I (id uuid primary key default gen_random_uuid()%s, '
    'source_upload_id uuid not null references public.uploads(id) on delete cascade, '
    'created_at timestamptz not null default now(), '
    'search tsvector generated always as (%s) stored)',
    p_table, col_defs, search_expr);
  execute format('create index on public.%I using gin (search)', p_table);
  execute format('create index on public.%I (source_upload_id)', p_table);
  execute format('alter table public.%I enable row level security', p_table);
  execute format('create policy %I on public.%I for select to authenticated using (true)',
                 'signed-in team can read', p_table);
  execute format('grant select on public.%I to authenticated', p_table);
  execute format('grant all on public.%I to service_role', p_table);

  insert into public.content_types
    (key, label, table_name, is_core, description, instructions, columns,
     title_column, snippet_column, created_from_upload)
  values
    (p_table, trim(p_label), p_table, false, p_description, p_instructions, p_columns,
     p_title_column, p_snippet_column, p_upload_id);

  notify pgrst, 'reload schema';
  return p_table;
end
$$;


-- Deletes a table the portal created, its uploads, and its registration.
-- Core tables are protected.
create or replace function public.drop_custom_table(p_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare ct public.content_types%rowtype;
begin
  select * into ct from public.content_types where key = p_key;
  if not found then
    raise exception 'There is no content type called %', p_key;
  end if;
  if ct.is_core then
    raise exception 'Core tables cannot be deleted. You can clear their data instead.';
  end if;
  execute format('drop table if exists public.%I', ct.table_name);
  delete from public.uploads where content_type = p_key;
  delete from public.content_types where key = p_key;
  notify pgrst, 'reload schema';
end
$$;


-- Empties a table (core or custom) and removes the uploads that fed it.
create or replace function public.clear_table_data(p_table text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.content_types where table_name = p_table) then
    raise exception 'There is no portal table called %', p_table;
  end if;
  delete from public.uploads
   where content_type in (select key from public.content_types where table_name = p_table);
  execute format('delete from public.%I', p_table);
end
$$;

revoke execute on function public.clear_upload_rows(uuid) from public, anon, authenticated;
revoke execute on function public.create_custom_table(text, text, text, text, jsonb, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.drop_custom_table(text) from public, anon, authenticated;
revoke execute on function public.clear_table_data(text) from public, anon, authenticated;
grant execute on function public.clear_upload_rows(uuid) to service_role;
grant execute on function public.create_custom_table(text, text, text, text, jsonb, text, text, uuid) to service_role;
grant execute on function public.drop_custom_table(text) to service_role;
grant execute on function public.clear_table_data(text) to service_role;


-- =====================================================================
-- Functions the portal calls from the browser (read only)
-- =====================================================================

-- Every portal table with its row count, for the Manage tables screen.
create or replace function public.table_stats()
returns table (t_table text, t_labels text, t_keys text[], t_is_core boolean, t_rows bigint)
language plpgsql
stable
as $$
declare r record; n bigint;
begin
  for r in
    select c.table_name as tn,
           string_agg(c.label, ', ' order by c.label) as lbl,
           array_agg(c.key order by c.key) as keys,
           bool_or(c.is_core) as core
      from public.content_types c
     group by c.table_name
     order by core desc, tn
  loop
    if to_regclass(format('public.%I', r.tn)) is null then continue; end if;
    execute format('select count(*) from public.%I', r.tn) into n;
    t_table := r.tn; t_labels := r.lbl; t_keys := r.keys; t_is_core := r.core; t_rows := n;
    return next;
  end loop;
end
$$;


-- One keyword search across every table, core and custom.
-- Example: select * from search_portal('PGPM placements 2026');
create or replace function public.search_portal_raw(q text)
returns table (r_type text, r_table text, r_id uuid, r_title text,
               r_snippet text, r_date date, r_rank real)
language plpgsql
stable
as $$
declare
  tsq tsquery := websearch_to_tsquery('english', q);
  c   record;
begin
  return query
    select 'Brochures and reports'::text, 'knowledge_items'::text, k.id,
           coalesce(k.document_title, k.category), k.fact, null::date, ts_rank(k.search, tsq)
      from public.knowledge_items k where k.search @@ tsq;
  return query
    select 'Influencer content'::text, 'influencer_content'::text, x.id,
           coalesce(x.title, x.influencer_name_raw), x.summary, x.published_date, ts_rank(x.search, tsq)
      from public.influencer_content x where x.search @@ tsq;
  return query
    select 'Calendar'::text, 'calendar_events'::text, e.id,
           e.title, e.description, e.event_date, ts_rank(e.search, tsq)
      from public.calendar_events e where e.search @@ tsq;
  return query
    select 'SOIL social posts'::text, 'social_posts'::text, p.id,
           p.theme, p.summary, p.posted_date, ts_rank(p.search, tsq)
      from public.social_posts p where p.search @@ tsq;
  return query
    select 'Alumni'::text, 'alumni_activity'::text, a.id,
           a.alumnus_name, a.summary, a.activity_date, ts_rank(a.search, tsq)
      from public.alumni_activity a where a.search @@ tsq;
  return query
    select 'Influencers'::text, 'influencers'::text, i.id,
           i.name, i.niche, null::date, ts_rank(i.search, tsq)
      from public.influencers i where i.search @@ tsq;

  for c in select * from public.content_types where not is_core loop
    if to_regclass(format('public.%I', c.table_name)) is null then continue; end if;
    return query execute format(
      'select %L::text, %L::text, t.id, %s, %s, null::date, ts_rank(t.search, $1) '
      'from public.%I t where t.search @@ $1',
      c.label, c.table_name,
      case when c.title_column is null then quote_literal(c.label) || '::text'
           else format('t.%I::text', c.title_column) end,
      case when c.snippet_column is null then 'null::text'
           else format('t.%I::text', c.snippet_column) end,
      c.table_name)
    using tsq;
  end loop;
end
$$;

create or replace function public.search_portal(q text, max_results int default 30)
returns table (result_type text, result_table text, result_id uuid, result_title text,
               snippet text, result_date date, rank real)
language sql
stable
as $$
  select r_type, r_table, r_id, r_title, r_snippet, r_date, r_rank
    from public.search_portal_raw(q)
   order by r_rank desc
   limit max_results;
$$;


-- ---------------------------------------------------------------------
-- Storage bucket for the original files (private)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('portal-uploads', 'portal-uploads', false)
on conflict (id) do nothing;

create policy "signed-in team can upload files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'portal-uploads');

create policy "signed-in team can read files"
  on storage.objects for select to authenticated
  using (bucket_id = 'portal-uploads');
