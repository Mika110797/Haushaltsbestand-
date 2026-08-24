-- Haushaltsbestand v1 – deployed Supabase schema
-- Stand: 24.08.2026

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 60),
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id),
  unique (user_id)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 40),
  icon text not null default '📦' check (char_length(icon) between 1 and 8),
  created_at timestamptz not null default now(),
  unique (id, household_id)
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  category_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 80),
  quantity integer not null default 0 check (quantity >= 0),
  min_quantity integer not null default 0 check (min_quantity >= 0),
  unit text not null default 'Stk.' check (char_length(unit) between 1 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint items_category_same_household_fk
    foreign key (category_id, household_id)
    references public.categories(id, household_id)
    on delete restrict
);

create index household_members_user_id_idx on public.household_members(user_id);
create index categories_household_id_idx on public.categories(household_id);
create index items_household_id_idx on public.items(household_id);
create index items_category_household_idx on public.items(category_id, household_id);

create or replace function private.is_household_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = (select auth.uid())
  );
$$;

create or replace function private.create_household_impl(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_household_id uuid;
  v_name text := trim(p_name);
begin
  if (select auth.uid()) is null then raise exception 'Nicht angemeldet'; end if;
  if char_length(v_name) not between 1 and 60 then raise exception 'Ungültiger Haushaltsname'; end if;
  if exists (select 1 from public.household_members where user_id = (select auth.uid())) then
    raise exception 'Du bist bereits einem Haushalt zugeordnet';
  end if;
  insert into public.households(name) values (v_name) returning id into v_household_id;
  insert into public.household_members(household_id, user_id, role)
  values (v_household_id, (select auth.uid()), 'owner');
  return v_household_id;
end;
$$;

create or replace function private.join_household_impl(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_household_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Nicht angemeldet'; end if;
  if exists (select 1 from public.household_members where user_id = (select auth.uid())) then
    raise exception 'Du bist bereits einem Haushalt zugeordnet';
  end if;
  select h.id into v_household_id from public.households h
  where h.invite_code = upper(trim(p_invite_code));
  if v_household_id is null then raise exception 'Einladungscode nicht gefunden'; end if;
  insert into public.household_members(household_id, user_id, role)
  values (v_household_id, (select auth.uid()), 'member');
  return v_household_id;
end;
$$;

create or replace function public.create_household(p_name text)
returns uuid language sql security invoker
set search_path = public, private, pg_temp
as $$ select private.create_household_impl(p_name); $$;

create or replace function public.join_household(p_invite_code text)
returns uuid language sql security invoker
set search_path = public, private, pg_temp
as $$ select private.join_household_impl(p_invite_code); $$;

create or replace function public.change_item_quantity(p_item_id uuid, p_delta integer)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_quantity integer;
begin
  if p_delta = 0 then
    select quantity into v_quantity from public.items where id = p_item_id;
    return v_quantity;
  end if;
  update public.items
  set quantity = greatest(0, quantity + p_delta), updated_at = now()
  where id = p_item_id
  returning quantity into v_quantity;
  if v_quantity is null then raise exception 'Artikel nicht gefunden oder kein Zugriff'; end if;
  return v_quantity;
end;
$$;

revoke all on function private.is_household_member(uuid) from public, anon;
revoke all on function private.create_household_impl(text) from public, anon;
revoke all on function private.join_household_impl(text) from public, anon;
grant execute on function private.is_household_member(uuid) to authenticated;
grant execute on function private.create_household_impl(text) to authenticated;
grant execute on function private.join_household_impl(text) to authenticated;

revoke all on function public.create_household(text) from public, anon;
revoke all on function public.join_household(text) from public, anon;
revoke all on function public.change_item_quantity(uuid, integer) from public, anon;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;
grant execute on function public.change_item_quantity(uuid, integer) to authenticated;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.categories enable row level security;
alter table public.items enable row level security;

revoke all on table public.households, public.household_members, public.categories, public.items from anon, authenticated;
grant select on table public.households, public.household_members to authenticated;
grant select, insert, update, delete on table public.categories, public.items to authenticated;

create policy household_select on public.households for select to authenticated
using ((select private.is_household_member(id)));
create policy member_select on public.household_members for select to authenticated
using ((select private.is_household_member(household_id)));
create policy category_select on public.categories for select to authenticated
using ((select private.is_household_member(household_id)));
create policy category_insert on public.categories for insert to authenticated
with check ((select private.is_household_member(household_id)));
create policy category_update on public.categories for update to authenticated
using ((select private.is_household_member(household_id)))
with check ((select private.is_household_member(household_id)));
create policy category_delete on public.categories for delete to authenticated
using ((select private.is_household_member(household_id)));
create policy item_select on public.items for select to authenticated
using ((select private.is_household_member(household_id)));
create policy item_insert on public.items for insert to authenticated
with check ((select private.is_household_member(household_id)));
create policy item_update on public.items for update to authenticated
using ((select private.is_household_member(household_id)))
with check ((select private.is_household_member(household_id)));
create policy item_delete on public.items for delete to authenticated
using ((select private.is_household_member(household_id)));

alter publication supabase_realtime add table public.items;
alter publication supabase_realtime add table public.categories;
