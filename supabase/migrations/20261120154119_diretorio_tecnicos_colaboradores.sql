create function ssma_epi.employee_technicians()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.user_id, 'name', p.display_name)
                            order by p.display_name, p.user_id), '[]'::jsonb)
  from public.ssma_profiles p
  where auth.uid() is not null and ssma_epi.allowed('colaboradores')
    and p.active and not p.is_master and p.removed_at is null
$$;

create function public.ssma_employee_technicians()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select ssma_epi.employee_technicians()
$$;

revoke all on function ssma_epi.employee_technicians(), public.ssma_employee_technicians() from public, anon;
grant execute on function ssma_epi.employee_technicians(), public.ssma_employee_technicians() to authenticated;
