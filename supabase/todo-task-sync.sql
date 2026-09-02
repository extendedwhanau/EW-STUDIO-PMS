-- Google Tasks → PMS: mark matching to-dos done without replacing the whole workspace.
-- Run once in Supabase → SQL Editor. Safe to re-run.

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
  set
    payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{todos}', v_after, true),
    updated_at = timezone('utc', now())
  where id = 'main';

  return jsonb_build_object('ok', true, 'changed', v_changed);
end;
$$;

revoke all on function public.mark_studio_todos_done(text[]) from public;
grant execute on function public.mark_studio_todos_done(text[]) to service_role;
