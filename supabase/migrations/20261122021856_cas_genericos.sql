alter table ssma_epi.materials add column generic_cas text[] not null default '{}';

create function ssma_epi.generic_cas(p jsonb, previous text[], material uuid) returns text[]
language plpgsql set search_path='' as $$
declare result text[]; principal text:=ltrim(trim(p->>'ca'),'0');
begin
 if coalesce((p->>'no_ca')::boolean,false) then return '{}'; end if;
 select coalesce(array_agg(ltrim(trim(v),'0') order by pos),'{}') into result
 from jsonb_array_elements_text(coalesce(p->'generic_cas',to_jsonb(previous))) with ordinality a(v,pos) where trim(v)<>'';
 if cardinality(result)=0 then return result; end if;
 if principal is null or principal !~ '^[0-9]+$' or cardinality(result)>3 or principal=any(result)
 or exists(select 1 from unnest(result) c group by c having count(*)>1 or c !~ '^[0-9]{1,70}$')
 then raise exception 'Informe até três CAs genéricos numéricos diferentes entre si e do CA principal.'; end if;
 perform pg_advisory_xact_lock(714235199);
 if exists(select 1 from ssma_epi.materials m where m.id<>material and m.archived_at is null and cardinality(m.generic_cas)>0 and
   (ltrim(trim(m.ca),'0')<>principal and m.generic_cas && result))
 then raise exception 'Um dos CAs já pertence a outro agrupamento.'; end if;
 if exists(with recursive ancestors(ca) as (select principal union select ltrim(trim(m.ca),'0') from ancestors a join ssma_epi.materials m on a.ca=any(m.generic_cas) where m.archived_at is null and m.id<>material) select 1 from ancestors where ca=any(result)) then raise exception 'Os CAs formariam um vínculo circular.'; end if;
 return result;
end $$;
revoke all on function ssma_epi.generic_cas(jsonb,text[],uuid) from public,anon,authenticated;

do $migration$
declare f text; old text; replacement text;
begin
 f:=pg_get_functiondef('ssma_epi.manage_owned(text,jsonb)'::regprocedure);
 old:='glove_right_number,ca_sheet_key)'; replacement:='glove_right_number,ca_sheet_key,generic_cas)';
 if strpos(f,old)=0 then raise exception 'Cadastro de material incompatível.'; end if;
 f:=replace(f,old,replacement);
 old:=$part$nullif(p->>'ca_sheet_key',''))$part$;
 if strpos(f,old)=0 then raise exception 'Valores de material incompatíveis.'; end if;
 execute replace(f,old,$part$nullif(p->>'ca_sheet_key',''),ssma_epi.generic_cas(p,'{}',(p->>'id')::uuid))$part$);
 f:=pg_get_functiondef('ssma_epi.maintain_material(text,jsonb)'::regprocedure);
 old:='update ssma_epi.materials set name=trim(';
 if strpos(f,old)=0 then raise exception 'Edição de material incompatível.'; end if;
 execute replace(f,old,'update ssma_epi.materials set generic_cas=ssma_epi.generic_cas(p,m.generic_cas,m.id),name=trim(');
end $migration$;

do $migration$
declare f text:=pg_get_functiondef('public.ssma_epi_logistics(text,jsonb)'::regprocedure);
begin
 if strpos(f,'insulating_glove,glove_start)')=0 then raise exception 'Cadastro de nota incompatível.'; end if;
 f:=replace(f,'insulating_glove,glove_start)','insulating_glove,glove_start,glove_left_number,glove_right_number)');
 f:=replace(f,$a$nullif(item->>'glove_start','')::date) returning$a$,$a$nullif(item->>'glove_start','')::date,nullif(trim(item->>'glove_left_number'),''),nullif(trim(item->>'glove_right_number'),'')) returning$a$);
 execute replace(f,$a$'ca',m1.ca,'size'$a$,$a$'ca',m1.ca,'generic_cas',m1.generic_cas,'size'$a$);
end $migration$;
