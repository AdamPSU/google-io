-- generations: one row per generated card.
-- id mirrors the workspace job_id (ULID, stored as text) so DB and on-disk
-- workspaces share a key. brief is the slice-1 contract (nullable until step 4).
-- Rows are immutable: only successful runs are inserted, nothing is updated.

create table public.generations (
    id text primary key,
    url text not null,
    brief jsonb,
    created_at timestamptz not null default now()
);

create index generations_created_at_idx on public.generations (created_at desc);

-- RLS enabled with no policies: backend talks via the service role
-- (which bypasses RLS). End-user policies will be added when auth lands.
alter table public.generations enable row level security;
