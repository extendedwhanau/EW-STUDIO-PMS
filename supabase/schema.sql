-- Run once in Supabase → SQL Editor → New query → Run
-- Shared studio: one JSON blob (last save wins — add auth + RLS later for real security)

create table if not exists public.studio_workspace (
  id text primary key,
  payload jsonb not null default '{"designers":[],"projects":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.studio_workspace (id, payload)
values ('main', '{"designers":[],"projects":[]}'::jsonb)
on conflict (id) do nothing;

alter table public.studio_workspace enable row level security;

-- Open access for anon key (your app in the browser). Tighten when you add login.
-- Drop first so you can re-run this whole file without errors.
drop policy if exists "studio_workspace_select" on public.studio_workspace;
drop policy if exists "studio_workspace_insert" on public.studio_workspace;
drop policy if exists "studio_workspace_update" on public.studio_workspace;

create policy "studio_workspace_select"
  on public.studio_workspace for select
  using (true);

create policy "studio_workspace_insert"
  on public.studio_workspace for insert
  with check (true);

create policy "studio_workspace_update"
  on public.studio_workspace for update
  using (true)
  with check (true);
