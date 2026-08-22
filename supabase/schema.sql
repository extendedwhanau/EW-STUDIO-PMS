-- Run once in Supabase → SQL Editor → New query → Run
-- Shared studio: one JSON blob (last save wins).
-- After Google login is enabled, also run supabase/auth-rls.sql to lock the table.

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

-- Always stamp updated_at on the server (keeps sync timestamps consistent across devices)
create or replace function public.set_studio_workspace_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists studio_workspace_set_updated_at on public.studio_workspace;
create trigger studio_workspace_set_updated_at
  before insert or update on public.studio_workspace
  for each row execute function public.set_studio_workspace_updated_at();

-- Realtime: push row updates to every open app tab (safe to re-run)
do $$
begin
  alter publication supabase_realtime add table public.studio_workspace;
exception
  when duplicate_object then null;
end $$;

-- Google Tasks → PMS completions (also in supabase/todo-task-sync.sql)
create or replace function public.mark_studio_todos_done(p_todo_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids text[] := coalesce(p_todo_ids, array[]::text[]);
  v_before jsonb;
  v_after jsonb;
  v_now text := to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_changed int := 0;
begin
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return jsonb_build_object('ok', true, 'changed', 0);
  end if;

  select payload->'todos' into v_before
  from public.studio_workspace
  where id = 'main'
  for update;

  if v_before is null then
    return jsonb_build_object('ok', false, 'error', 'no workspace');
  end if;

  select
    coalesce(jsonb_agg(updated.elem order by updated.ord), '[]'::jsonb),
    coalesce(sum(updated.changed), 0)
  into v_after, v_changed
  from (
    select
      ord,
      case
        when (elem->>'id') = any(v_ids)
          and coalesce(elem->>'done', '') not in ('true', 't', '1')
        then jsonb_set(
          jsonb_set(elem, '{done}', 'true'::jsonb, true),
          '{doneAt}',
          to_jsonb(v_now),
          true
        )
        else elem
      end as elem,
      case
        when (elem->>'id') = any(v_ids)
          and coalesce(elem->>'done', '') not in ('true', 't', '1')
        then 1
        else 0
      end as changed
    from jsonb_array_elements(coalesce(v_before, '[]'::jsonb)) with ordinality as t(elem, ord)
  ) updated;

  if v_changed = 0 then
    return jsonb_build_object('ok', true, 'changed', 0);
  end if;

  update public.studio_workspace
  set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{todos}', v_after, true)
  where id = 'main';

  return jsonb_build_object('ok', true, 'changed', v_changed);
end;
$$;

revoke all on function public.mark_studio_todos_done(text[]) from public;
grant execute on function public.mark_studio_todos_done(text[]) to service_role;
