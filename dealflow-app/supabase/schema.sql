-- ============================================================================
-- Deal Flow App — Database Schema
-- Run this in the Supabase SQL Editor (Project > SQL Editor > New query)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PROFILES
-- Every logged-in user (intern or team lead) gets a row here, created
-- automatically when they sign up (see trigger at the bottom).
-- ----------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('intern', 'team_lead')) default 'intern',
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. SELLERS (leads found by interns)
-- ----------------------------------------------------------------------------
create table sellers (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  industry text,
  asking_price numeric,
  notes text,
  status text not null check (status in ('new', 'vetted', 'dead')) default 'new',
  found_by uuid references profiles(id),        -- which intern sourced this lead
  assigned_to uuid references profiles(id),      -- which intern currently owns/updates it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 3. BUYERS (paying clients)
-- ----------------------------------------------------------------------------
create table buyers (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  subscription_status text not null check (subscription_status in ('active', 'paused', 'cancelled')) default 'active',
  monthly_fee numeric not null default 0,
  assigned_to uuid references profiles(id),      -- which intern manages this buyer's profile
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 4. DEALS (a seller lead pitched to a buyer)
-- ----------------------------------------------------------------------------
create table deals (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references sellers(id) on delete cascade,
  buyer_id uuid not null references buyers(id) on delete cascade,
  status text not null check (
    status in ('pitched', 'interested', 'negotiating', 'closed_won', 'closed_lost')
  ) default 'pitched',
  sale_price numeric,          -- filled in once closed_won
  commission_rate numeric,     -- e.g. 0.05 for 5%, filled in once closed_won
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 5. SUBSCRIPTION PAYMENTS (buyer's recurring monthly fee — financial, team leads only)
-- ----------------------------------------------------------------------------
create table subscription_payments (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references buyers(id) on delete cascade,
  period_month date not null,   -- first of the month this payment covers
  amount numeric not null,
  paid boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 6. COMMISSIONS (owed once a deal closes — financial, team leads only)
-- ----------------------------------------------------------------------------
create table commissions (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  amount numeric not null,
  status text not null check (status in ('owed', 'invoiced', 'paid')) default 'owed',
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- ROW LEVEL SECURITY
-- Interns: can read/write only buyers & sellers assigned to them, and deals
--          that involve those records. No access to subscriptions/commissions.
-- Team leads: full access to everything.
-- ============================================================================

alter table profiles enable row level security;
alter table sellers enable row level security;
alter table buyers enable row level security;
alter table deals enable row level security;
alter table subscription_payments enable row level security;
alter table commissions enable row level security;

-- Helper: is the current user a team lead?
create or replace function is_team_lead()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'team_lead'
  );
$$;

-- PROFILES: everyone can read all profiles (needed to show "assigned to" names);
-- only the user themself or a team lead can update.
create policy "profiles_select_all" on profiles
  for select using (true);
create policy "profiles_update_self_or_lead" on profiles
  for update using (auth.uid() = id or is_team_lead());

-- SELLERS
create policy "sellers_select" on sellers
  for select using (is_team_lead() or assigned_to = auth.uid() or found_by = auth.uid());
create policy "sellers_insert" on sellers
  for insert with check (is_team_lead() or found_by = auth.uid());
create policy "sellers_update" on sellers
  for update using (is_team_lead() or assigned_to = auth.uid());
create policy "sellers_delete" on sellers
  for delete using (is_team_lead());

-- BUYERS
create policy "buyers_select" on buyers
  for select using (is_team_lead() or assigned_to = auth.uid());
create policy "buyers_insert" on buyers
  for insert with check (is_team_lead());
create policy "buyers_update" on buyers
  for update using (is_team_lead() or assigned_to = auth.uid());
create policy "buyers_delete" on buyers
  for delete using (is_team_lead());

-- DEALS: visible if you can see either side of the deal
create policy "deals_select" on deals
  for select using (
    is_team_lead()
    or exists (select 1 from sellers s where s.id = seller_id and (s.assigned_to = auth.uid() or s.found_by = auth.uid()))
    or exists (select 1 from buyers b where b.id = buyer_id and b.assigned_to = auth.uid())
  );
create policy "deals_insert" on deals
  for insert with check (
    is_team_lead()
    or exists (select 1 from sellers s where s.id = seller_id and (s.assigned_to = auth.uid() or s.found_by = auth.uid()))
  );
create policy "deals_update" on deals
  for update using (
    is_team_lead()
    or exists (select 1 from sellers s where s.id = seller_id and s.assigned_to = auth.uid())
    or exists (select 1 from buyers b where b.id = buyer_id and b.assigned_to = auth.uid())
  );
create policy "deals_delete" on deals
  for delete using (is_team_lead());

-- SUBSCRIPTION PAYMENTS: team leads only
create policy "subscriptions_all" on subscription_payments
  for all using (is_team_lead()) with check (is_team_lead());

-- COMMISSIONS: team leads only
create policy "commissions_all" on commissions
  for all using (is_team_lead()) with check (is_team_lead());

-- ============================================================================
-- COLUMN-LEVEL PROTECTION
-- RLS above controls which ROWS an intern can touch. These triggers stop
-- interns from editing specific FINANCIAL columns even on rows they own —
-- e.g. an intern can update a buyer's contact info, but not their monthly
-- fee; they can move a deal through the pipeline, but only a team lead can
-- close it and set the sale price / commission.
-- ============================================================================

create or replace function protect_buyer_financials()
returns trigger language plpgsql as $$
begin
  if not is_team_lead() then
    if new.monthly_fee is distinct from old.monthly_fee
       or new.subscription_status is distinct from old.subscription_status then
      raise exception 'Only team leads can edit subscription/financial fields';
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$$;
create trigger buyers_protect_financials
  before update on buyers
  for each row execute function protect_buyer_financials();

create or replace function protect_seller_financials()
returns trigger language plpgsql as $$
begin
  if not is_team_lead() then
    if new.asking_price is distinct from old.asking_price then
      raise exception 'Only team leads can edit asking price';
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$$;
create trigger sellers_protect_financials
  before update on sellers
  for each row execute function protect_seller_financials();

create or replace function protect_deal_closing()
returns trigger language plpgsql as $$
begin
  if not is_team_lead() then
    if new.sale_price is distinct from old.sale_price
       or new.commission_rate is distinct from old.commission_rate
       or new.status in ('closed_won', 'closed_lost') then
      raise exception 'Only team leads can close a deal or set sale price / commission';
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$$;
create trigger deals_protect_closing
  before update on deals
  for each row execute function protect_deal_closing();

-- ============================================================================
-- CLIENTS (unified buyer/seller record — replaces the separate buyers/sellers
-- tables for the new "Clients" tab). The old buyers/sellers/deals tables
-- above are left in place since Finance still reads from them.
-- ============================================================================
create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_type text not null check (client_type in ('buyer', 'seller')),
  company_name text,               -- sellers only
  contact_info text,
  industry text,
  location text,
  annual_revenue numeric,
  employee_count integer,
  founded_year integer,
  founded_month integer check (founded_month between 1 and 12),
  looking_for text,                -- what they're looking for in a buyer/seller
  intern_name text,                -- intern/contractor working this client
  created_by uuid references profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table clients enable row level security;

-- Any signed-in user (intern or team lead) can view, add, and edit clients.
-- Only team leads can delete. Adjust later if interns should be scoped to
-- only the clients assigned to them.
create policy "clients_select_all" on clients
  for select using (auth.uid() is not null);
create policy "clients_insert_all" on clients
  for insert with check (auth.uid() is not null);
create policy "clients_update_all" on clients
  for update using (auth.uid() is not null);
create policy "clients_delete_lead_only" on clients
  for delete using (is_team_lead());

-- ============================================================================
-- TEAMS (shown in the Profile page's "Teams" popup). Empty for now — add
-- rows here whenever you're ready to list your company's teams.
-- ============================================================================
create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

alter table teams enable row level security;
create policy "teams_select_all" on teams
  for select using (auth.uid() is not null);

-- ============================================================================
-- Auto-create a profile row whenever someone signs up.
-- New users default to 'intern' — a team lead must promote them in the
-- profiles table (or via the app, if you add an admin screen for it).
-- ============================================================================
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'intern');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
