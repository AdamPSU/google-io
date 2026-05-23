-- `brief` was a slice-1 placeholder for a synthesized summary column.
-- The actual slice-1 output (places, raw HTML, distilled JSON) now lives
-- in the `generations` storage bucket under `<job_id>/context/`.
-- Nothing populates this column; drop it.

alter table public.generations drop column if exists brief;
