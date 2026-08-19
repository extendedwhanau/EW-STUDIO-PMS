-- Run in Supabase → SQL Editor after enabling Google Auth.
-- Locks studio_workspace to signed-in @extendedwhanau.com users
-- and stores personal notification events (Chat bot / email later).

create or replace function public.is_studio_user()
returns boolean
language sql
stable
as $$
  select
    auth.role() = 'authenticated'
    and coalesce(auth.jwt() ->> 'email', '') <> ''
    and lower(split_part(auth.jwt() ->> 'email', '@', 2)) in (
      'extendedwhanau.com'
    );
$$;

alter table public.studio_workspace enable row level security;

drop policy if exists "studio_workspace_select" on public.studio_workspace;
drop policy if exists "studio_workspace_insert" on public.studio_workspace;
drop policy if exists "studio_workspace_update" on public.studio_workspace;

create policy "studio_workspace_select"
  on public.studio_workspace for select
  using (public.is_studio_user());

create policy "studio_workspace_insert"
  on public.studio_workspace for insert
  with check (public.is_studio_user());

create policy "studio_workspace_update"
  on public.studio_workspace for update
  using (public.is_studio_user())
  with check (public.is_studio_user());

create table if not exists public.studio_notify_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null,
  project_id text,
  project_label text,
  summary text not null,
  recipients jsonb not null default '[]'::jsonb,
  actor_email text,
  payload jsonb not null default '{}'::jsonb,
  delivered_at timestamptz
);

alter table public.studio_notify_events enable row level security;

drop policy if exists "studio_notify_insert" on public.studio_notify_events;
drop policy if exists "studio_notify_select" on public.studio_notify_events;

create policy "studio_notify_insert"
  on public.studio_notify_events for insert
  with check (public.is_studio_user());

create policy "studio_notify_select"
  on public.studio_notify_events for select
  using (public.is_studio_user());
