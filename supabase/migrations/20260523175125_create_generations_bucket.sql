-- Private bucket for per-job artifacts (slice 1) and generated site bundles
-- (slice 2). Objects are namespaced by job_id, e.g. <job_id>/site/index.html.
-- Private + accessed via service role; no end-user policies yet.

insert into storage.buckets (id, name, public)
values ('generations', 'generations', false)
on conflict (id) do nothing;
