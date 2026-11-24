-- 不良のたまり場：全ゲーム共通の財布
-- 残高は wallets に1人1行。書き換えは下の関数経由だけ（直接の insert/update は許可しない）

create table if not exists public.wallets (
  uid uuid primary key,
  credit bigint not null default 100000 check (credit >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.wallet_log (
  id bigserial primary key,
  uid uuid not null,
  delta bigint not null,
  game text,
  credit_after bigint not null,
  by_uid uuid,
  at timestamptz not null default now()
);
alter table public.wallets enable row level security;
alter table public.wallet_log enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wallets' and policyname='wallet read') then
    create policy "wallet read" on public.wallets for select to authenticated using (uid = auth.uid() or public.is_slot_owner());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wallet_log' and policyname='wallet log read') then
    create policy "wallet log read" on public.wallet_log for select to authenticated using (uid = auth.uid() or public.is_slot_owner());
  end if;
end $$;

-- 自分の残高（初めてなら 100,000P で作る）
create or replace function public.wallet_get() returns bigint
language plpgsql security definer set search_path = public as $$
declare c bigint;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into wallets(uid) values (auth.uid()) on conflict (uid) do nothing;
  select credit into c from wallets where uid = auth.uid();
  return c;
end $$;

-- ゲームの増減（足りなければ失敗する）
create or replace function public.wallet_add(delta bigint, game text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare c bigint;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into wallets(uid) values (auth.uid()) on conflict (uid) do nothing;
  update wallets set credit = credit + delta, updated_at = now()
    where uid = auth.uid() and credit + delta >= 0
    returning credit into c;
  if c is null then raise exception 'insufficient' using errcode = 'P0001'; end if;
  insert into wallet_log(uid, delta, game, credit_after, by_uid) values (auth.uid(), delta, left(game, 40), c, auth.uid());
  return c;
end $$;

-- 管理者（オーナー）による調整。0未満にはならない
create or replace function public.wallet_grant(target uuid, delta bigint, note text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare c bigint;
begin
  if not public.is_slot_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  insert into wallets(uid) values (target) on conflict (uid) do nothing;
  update wallets set credit = greatest(0, credit + delta), updated_at = now() where uid = target returning credit into c;
  insert into wallet_log(uid, delta, game, credit_after, by_uid) values (target, delta, 'admin' || coalesce(':' || left(note, 40), ''), c, auth.uid());
  return c;
end $$;

select 'ok' as result, (select count(*) from public.wallets) as wallets;
