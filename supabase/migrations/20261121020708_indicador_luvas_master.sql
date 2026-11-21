create or replace function ssma_epi.glove_summary(technician uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x) order by x.unit),'[]') from (
 select coalesce(r.distribution_unit,r.name) unit, case r.state when 'DF' then 'Centro-Oeste' when 'RJ' then 'Sudeste' else coalesce(r.distribution_unit,r.name) end region, r.state,
 coalesce(sum(m.qty),0) qty, coalesce(sum(m.qty*m.price),0) cost,
 coalesce(sum(case when m.glove_start <= (now() at time zone 'America/Sao_Paulo')::date and m.expiry >= (now() at time zone 'America/Sao_Paulo')::date then m.qty-m.reserved else 0 end),0) available
 from ssma_epi.regions r left join ssma_epi.materials m on m.region_id=r.id and m.insulating_glove
 where (r.distribution_unit is not null or r.individual) and exists(select 1 from public.ssma_profiles viewer where viewer.user_id=auth.uid() and viewer.active and viewer.is_master) and (technician is null or exists(select 1 from public.ssma_profiles t where t.user_id=technician and (t.is_master or (t.stock_unit=r.id or (r.individual and r.id=t.user_id)))))
 group by r.id) x
$$;
