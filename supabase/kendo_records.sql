-- kendo_records: AI 劍道動作分析歷史紀錄
create table if not exists public.kendo_records (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  stance text not null,
  target text not null,
  elbow_angle double precision not null,
  wrist_diff text not null,
  diagnosis text,
  practice_plan text,
  raw_metrics jsonb,
  user_id uuid references auth.users (id) on delete set null
);

create index if not exists kendo_records_created_at_idx
  on public.kendo_records (created_at desc);

create index if not exists kendo_records_user_id_idx
  on public.kendo_records (user_id);

alter table public.kendo_records enable row level security;

-- 匿名前端可 insert（Edge Function 用 service role 更佳；以下供直接 client 寫入時用）
create policy "Allow insert for anon and authenticated"
  on public.kendo_records
  for insert
  to anon, authenticated
  with check (true);

create policy "Allow select own or all authenticated"
  on public.kendo_records
  for select
  to authenticated
  using (true);

create policy "Allow select for anon (optional read)"
  on public.kendo_records
  for select
  to anon
  using (true);
