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
  first_name text not null,
  last_name text not null,
  client_type text not null check (client_type in ('buyer', 'seller')),
  company_name text,               -- sellers only
  email text,
  phone text,
  linkedin text,
  city text,
  state text,                      -- one of the 50 US states, or 'Not in the US'
  industry text,                   -- sellers only
  annual_revenue numeric,          -- sellers only
  employee_count integer,          -- sellers only
  founded_year integer,            -- sellers only
  founded_month integer check (founded_month between 1 and 12), -- sellers only
  money_to_spend_min numeric,      -- buyers only
  money_to_spend_max numeric,      -- buyers only
  looking_for text,                -- what they're looking for in a buyer/seller
  other_notes text,
  intern_name text,                -- auto-filled with the creating intern's name
  assigned_to uuid references profiles(id), -- auto-set to the creating intern
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
create policy "clients_delete_all" on clients
  for delete using (auth.uid() is not null);

-- ============================================================================
-- CLIENT EVENTS (the Timeline tab on a client's profile). A "created" event
-- is inserted automatically whenever a client row is inserted.
-- ============================================================================
create table client_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  event_type text not null,        -- 'created', 'intro_call', ...
  event_date timestamptz not null default now(),
  details jsonb,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table client_events enable row level security;
create policy "client_events_select_all" on client_events
  for select using (auth.uid() is not null);
create policy "client_events_insert_all" on client_events
  for insert with check (auth.uid() is not null);
create policy "client_events_delete_lead_only" on client_events
  for delete using (is_team_lead());

create or replace function create_client_created_event()
returns trigger language plpgsql security definer as $$
begin
  insert into client_events (client_id, event_type, event_date, created_by)
  values (new.id, 'created', new.created_at, new.created_by);
  return new;
end;
$$;
create trigger trg_client_created_event
  after insert on clients
  for each row execute function create_client_created_event();

-- ============================================================================
-- DIALS (the "Dials" tab). A dial_list is a named tab, scoped to a
-- buyer/seller category and a current/archived status. Dials are the raw
-- call-list contacts within a given tab — lighter-weight than a full Client.
-- ============================================================================
create table dial_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  dial_type text not null check (dial_type in ('buyer', 'seller')),
  status text not null check (status in ('current', 'archived')) default 'current',
  sort_order integer not null default 0,
  created_by uuid references profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);

alter table dial_lists enable row level security;
create policy "dial_lists_select_all" on dial_lists
  for select using (auth.uid() is not null);
create policy "dial_lists_insert_all" on dial_lists
  for insert with check (auth.uid() is not null);
create policy "dial_lists_update_all" on dial_lists
  for update using (auth.uid() is not null);
create policy "dial_lists_delete_lead_only" on dial_lists
  for delete using (is_team_lead());

create table dials (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references dial_lists(id) on delete cascade,
  first_name text,
  last_name text,
  company_name text,          -- sellers only (their business name)
  email text,
  mobile_phone text,
  company_phone text,
  linkedin text,
  city text,
  state text,
  website text,               -- sellers only (their business website link)
  industry text,
  summary text,
  call_notes text,
  -- Quick-access call outcome, set from the dial popup's status dropdown
  -- (not part of the edit form) — also used to color-code list rows/cards
  -- and to drive the header's "hide dials by status" filter.
  contact_status text not null default 'uncontacted' check (
    contact_status in ('uncontacted', 'unable_to_contact', 'not_interested', 'no_response', 'callback_interested', 'intro_call_scheduled')
  ),
  created_by uuid references profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table dials enable row level security;
create policy "dials_select_all" on dials
  for select using (auth.uid() is not null);
create policy "dials_insert_all" on dials
  for insert with check (auth.uid() is not null);
create policy "dials_update_all" on dials
  for update using (auth.uid() is not null);
create policy "dials_delete_all" on dials
  for delete using (auth.uid() is not null);

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
