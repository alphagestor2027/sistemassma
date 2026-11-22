create or replace function ssma_epi.glove_expiry() returns trigger language plpgsql set search_path='' as $$
begin
 if new.insulating_glove then
   if new.qty>0 and new.glove_start is null then raise exception 'Informe a data do certificado ou do ensaio elétrico antes da entrada de luvas.'; end if;
   new.expiry:=new.glove_start+365;
 end if;
 return new;
end $$;
drop trigger glove_expiry on ssma_epi.materials;
create trigger glove_expiry before insert or update of glove_start,insulating_glove,qty on ssma_epi.materials for each row execute function ssma_epi.glove_expiry();
