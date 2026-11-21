create extension if not exists pg_cron;
select cron.schedule('ssma-remover-fichas-vencidas','* * * * *',
  $$delete from ssma_epi.sheets where expires_at <= now()$$);
