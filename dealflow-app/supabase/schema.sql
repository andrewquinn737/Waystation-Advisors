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
  -- 'admin' was added later (see the ADMIN ROLE / TEAMS section near the
  -- bottom of this file) — every account starts as 'intern' and an existing
  -- admin promotes people from the Teams popup.
  role text not null check (role in ('intern', 'team_lead', 'admin')) default 'intern',
  phone text,                      -- required at signup (see login.html)
  email text,                      -- copied from auth.users at signup so the
                                    -- Teams popup can show it without needing
                                    -- access to the auth schema
  -- Which Teams-popup group this person shows up under. Superseded by the
  -- nullable `team_id` (references teams(id)) added in the ADMIN ROLE / TEAMS
  -- section below — admins can now create/rename/delete teams instead of
  -- picking from 3 fixed names. Left here (commented) only as a historical
  -- note of the original column; the live migration actually DROPS this
  -- column and ADDS team_id.
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
-- TEAM LEADS ARE TEMPORARILY DISABLED — every intern account is treated as
-- full-access for now (per product decision to keep the roster flat while
-- the org is small). This is the one place to flip that back on later: swap
-- the body back to the real role check below (kept here, commented out) once
-- team leads are reintroduced, no other code needs to change.
--   select exists (
--     select 1 from profiles
--     where id = auth.uid() and role = 'team_lead'
--   );
create or replace function is_team_lead()
returns boolean
language sql
security definer
stable
as $$
  select true;
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

-- Each intern only sees/edits/deletes the clients THEY created — not each
-- other's. created_by defaults to auth.uid() at insert time (see the column
-- default above), so this needs no extra app-side wiring: whoever is signed
-- in when a client is created automatically becomes the only one who can see
-- it afterward.
create policy "clients_select_own" on clients
  for select using (created_by = auth.uid());
create policy "clients_insert_own" on clients
  for insert with check (created_by = auth.uid());
create policy "clients_update_own" on clients
  for update using (created_by = auth.uid());
create policy "clients_delete_own" on clients
  for delete using (created_by = auth.uid());

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
-- Scoped through the parent client's ownership, same as clients itself —
-- you can only see/log events for a client you created.
create policy "client_events_select_own" on client_events
  for select using (
    exists (select 1 from clients c where c.id = client_events.client_id and c.created_by = auth.uid())
  );
create policy "client_events_insert_own" on client_events
  for insert with check (
    exists (select 1 from clients c where c.id = client_events.client_id and c.created_by = auth.uid())
  );
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
-- Each intern only sees/edits/deletes their own tabs — not each other's.
-- created_by defaults to auth.uid() at insert time (see column default
-- above).
create policy "dial_lists_select_own" on dial_lists
  for select using (created_by = auth.uid());
create policy "dial_lists_insert_own" on dial_lists
  for insert with check (created_by = auth.uid());
create policy "dial_lists_update_own" on dial_lists
  for update using (created_by = auth.uid());
create policy "dial_lists_delete_own" on dial_lists
  for delete using (created_by = auth.uid());

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
  -- "Did call today" toggle on the dial popup — set to today's date when
  -- checked, cleared when unchecked. Rendering just compares this to the
  -- current local date, so the button visually "resets" at the start of a
  -- new day with no cron job needed; it never touches historical
  -- call_status_changes rows, only the ones it itself inserts/deletes.
  called_today_date date,
  created_by uuid references profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table dials enable row level security;
-- Same per-user scoping as dial_lists — each intern only sees/edits/deletes
-- their own dials.
create policy "dials_select_own" on dials
  for select using (created_by = auth.uid());
create policy "dials_insert_own" on dials
  for insert with check (created_by = auth.uid());
create policy "dials_update_own" on dials
  for update using (created_by = auth.uid());
create policy "dials_delete_own" on dials
  for delete using (created_by = auth.uid());

-- ============================================================================
-- TEAMS (shown in the Profile page's "Teams" popup). Admin-creatable — see
-- the ADMIN ROLE / TEAMS section further down for sort_order + RLS.
-- ============================================================================
create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

alter table teams enable row level security;

-- ============================================================================
-- CALL STATUS CHANGES (feeds the Profile page's "X people called this week"
-- stat + 6-week chart). One row is inserted whenever a dial moves off its
-- default "Uncontacted" status for the first time (see updateDialStatus() in
-- js/dials.js) — i.e. this counts *dials contacted*, not every status edit.
-- ============================================================================
create table call_status_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  dial_id uuid references dials(id) on delete set null,
  changed_at timestamptz not null default now()
);

alter table call_status_changes enable row level security;
create policy "call_status_changes_select_all" on call_status_changes
  for select using (auth.uid() is not null);
create policy "call_status_changes_insert_all" on call_status_changes
  for insert with check (auth.uid() is not null);
-- Needed for the "Did call today" toggle's un-select action (js/dials.js
-- toggleDidCallToday()), which deletes its own just-inserted row under the
-- calling user's own JWT — without this, the delete silently no-ops (RLS
-- defaults to deny) and unselecting never actually removes the row.
create policy "call_status_changes_delete_own" on call_status_changes
  for delete using (user_id = auth.uid());

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
  insert into public.profiles (id, full_name, role, phone, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'intern',
    new.raw_user_meta_data->>'phone',
    new.email
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================================
-- ADMIN ROLE / TEAMS
-- Adds a real 'admin' role and admin-manageable teams (replacing the old 3
-- fixed team names). Run this whole block once against a database that
-- already has the schema above (it ALTERs profiles/teams rather than
-- re-creating them).
--
--   * Admins box + Unassigned interns box are virtual — not rows in `teams`
--     — derived purely from role='admin' / team_id is null. Only the custom
--     team rows an admin creates actually live in the `teams` table.
--   * profiles.team_id replaces the old fixed-enum `team` text column.
--     ON DELETE SET NULL means deleting a team automatically drops its
--     members back into Unassigned interns — no extra trigger needed.
--   * Only admins may change someone's role or team_id (see
--     protect_profile_admin_fields below) — otherwise any intern could
--     promote themselves via a direct API call even though the UI only
--     exposes this to admins.
--   * Creating/removing accounts themselves (not just role/team) needs the
--     Supabase service-role key, which must never reach the browser — see
--     supabase/functions/admin-create-account and admin-delete-account.
-- ============================================================================

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('intern', 'team_lead', 'admin'));

alter table profiles add column if not exists team_id uuid references teams(id) on delete set null;
alter table profiles drop constraint if exists profiles_team_check;
alter table profiles drop column if exists team;

alter table teams add column if not exists sort_order integer not null default 0;

create or replace function is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- One-time: promote the first admin BEFORE the protect_profile_admin_fields
-- trigger below exists — that trigger requires is_admin() to already be true
-- for anyone changing a role, which is a chicken-and-egg problem for the very
-- first admin (nobody is one yet). Running this seed update here, before the
-- trigger is created, sidesteps that entirely. Re-run (with a different
-- email/condition, and only after temporarily dropping the trigger — see its
-- comment below) whenever someone else needs to be seeded as an admin
-- directly in the database outside the app's own Teams UI.
update profiles set role = 'admin' where email = 'andrewquinn737@gmail.com';

drop policy if exists "profiles_update_self_or_lead" on profiles;
drop policy if exists "profiles_update_self_or_admin" on profiles;
create policy "profiles_update_self_or_admin" on profiles
  for update using (auth.uid() = id or is_admin())
  with check (auth.uid() = id or is_admin());

-- Column-level protection: even though the policy above lets someone update
-- their OWN row, only an admin may change the role/team_id columns on ANY
-- row (including their own) — stops privilege escalation via a direct API
-- call to the clients-side anon key. Must be created AFTER the one-time seed
-- update above, or that seed update would itself get blocked (is_admin() is
-- false for everyone until it runs).
create or replace function protect_profile_admin_fields()
returns trigger language plpgsql as $$
begin
  if not is_admin() then
    if new.role is distinct from old.role or new.team_id is distinct from old.team_id then
      raise exception 'Only admins can change role or team assignment';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_protect_admin_fields on profiles;
create trigger profiles_protect_admin_fields
  before update on profiles
  for each row execute function protect_profile_admin_fields();

-- TEAMS: everyone can read (needed to show team names in the Teams popup);
-- only admins can create/rename/delete a team.
drop policy if exists "teams_select_all" on teams;
create policy "teams_select_all" on teams
  for select using (auth.uid() is not null);
drop policy if exists "teams_insert_admin" on teams;
create policy "teams_insert_admin" on teams
  for insert with check (is_admin());
drop policy if exists "teams_update_admin" on teams;
create policy "teams_update_admin" on teams
  for update using (is_admin());
drop policy if exists "teams_delete_admin" on teams;
create policy "teams_delete_admin" on teams
  for delete using (is_admin());

-- ============================================================================
-- ADMIN-ONLY TEMP PASSWORD LOOKUP
-- Real login passwords are one-way hashed by Supabase Auth and can never be
-- retrieved once an account exists — there is no way to "show the real
-- password" for an existing login. Instead, this stores the INITIAL temp
-- password an admin sets at account-creation time (see
-- supabase/functions/admin-create-account, which has the plaintext value in
-- scope at signup and writes it here using the service-role client,
-- bypassing RLS on insert). Admins can then look it up later from the key
-- icon on a member's Teams card (see js/profile.js). If someone changes their
-- own password later, this stored value goes stale — it's a record of the
-- temp password issued at signup, not a live mirror of the real one.
-- ============================================================================
create table if not exists profile_temp_passwords (
  profile_id uuid primary key references profiles(id) on delete cascade,
  temp_password text not null,
  updated_at timestamptz not null default now()
);

alter table profile_temp_passwords enable row level security;

-- Only admins can read this table directly (the anon/authenticated key never
-- gets insert/update/delete access — only the admin-create-account Edge
-- Function's service-role client writes to it, which bypasses RLS entirely).
drop policy if exists "profile_temp_passwords_select_admin" on profile_temp_passwords;
create policy "profile_temp_passwords_select_admin" on profile_temp_passwords
  for select using (is_admin());

-- ============================================================================
-- CLIENT PIPELINE STATUS ("Categories" on the client profile — see
-- CLIENT_STATUSES in js/clients.js). Colored the same way dials.contact_status
-- is, plus a new "sold" (light blue) tint not used anywhere in dials. Not
-- required at creation — new clients default to 'not_in_contact'.
-- ============================================================================
alter table clients add column if not exists pipeline_status text not null default 'not_in_contact';
alter table clients drop constraint if exists clients_pipeline_status_check;
alter table clients add constraint clients_pipeline_status_check
  check (pipeline_status in ('sold', 'connected_to_buyer', 'potentially_interested', 'not_in_contact', 'no_longer_interested'));

-- ============================================================================
-- ADMIN-ONLY DIALS TAB TRANSFER
-- Lets an admin hand off one of their own dial_lists tabs (and every dial in
-- it) to a different account — see the "Transfer" option added to the tab's
-- archive/delete popup in js/dials.js. Reassigning created_by is what actually
-- moves it: dial_lists_select_own / dials_select_own both scope visibility to
-- created_by = auth.uid(), so the tab simply stops appearing for the admin and
-- starts appearing for whoever it was transferred to. The existing "_own"
-- UPDATE policies don't allow that (they only let you update your OWN rows),
-- so both are widened here to also allow any admin to update either table.
-- ============================================================================
drop policy if exists "dial_lists_update_own" on dial_lists;
create policy "dial_lists_update_own" on dial_lists
  for update using (created_by = auth.uid() or is_admin());

drop policy if exists "dials_update_own" on dials;
create policy "dials_update_own" on dials
  for update using (created_by = auth.uid() or is_admin());

-- ============================================================================
-- NEW CLIENTS DEFAULT TO "POTENTIALLY INTERESTED"
-- Was 'not_in_contact' — changed per product decision that a freshly-added
-- client has, by definition, already had some contact (that's how they got
-- added), so "potentially interested" is the more accurate starting bucket.
-- Only affects the column default for future inserts; existing rows keep
-- whatever status they already have.
-- ============================================================================
alter table clients alter column pipeline_status set default 'potentially_interested';

-- ============================================================================
-- PROFILE PICTURES
-- Public Storage bucket + per-user-folder RLS (each account's photo lives at
-- "<their own profile id>/avatar.<ext>", enforced via the folder-name check
-- below) so anyone can VIEW any photo (needed to show teammates' pictures in
-- Teams) but only the account itself can upload/replace/remove its own photo.
-- profiles.avatar_url just stores the public URL after upload — see
-- handleAvatarFileSelected() in js/profile.js.
-- ============================================================================
alter table profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own" on storage.objects
  for insert with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own" on storage.objects
  for update using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own" on storage.objects
  for delete using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================================
-- INTRO CALLS SCHEDULED (Profile page's "Intro calls" tracker/graph — the
-- toggled alternative to the "people called" outreach chart, see
-- loadIntroCallsChart() in js/profile.js). One row is inserted every time the
-- shared "Schedule Intro Call" flow is used (js/introCall.js's
-- wireIntroCallForm), from EITHER the Dials or the Clients page — this counts
-- the act of scheduling itself, independent of client_events/Timeline (which
-- is now only ever touched by manually clicking "+" in a client's Timeline).
-- ============================================================================
create table if not exists intro_call_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  scheduled_at timestamptz not null default now()
);

alter table intro_call_log enable row level security;

drop policy if exists "intro_call_log_select_own" on intro_call_log;
create policy "intro_call_log_select_own" on intro_call_log
  for select using (user_id = auth.uid());

drop policy if exists "intro_call_log_insert_own" on intro_call_log;
create policy "intro_call_log_insert_own" on intro_call_log
  for insert with check (user_id = auth.uid());

-- ============================================================================
-- ONE-TIME CLEANUP: the intro_call events on JD Smith and Curtis Pittman were
-- test data logged before Timeline switched to manual-only entries (see the
-- ADMIN-ONLY DIALS TAB TRANSFER block's client_events comment above) — this
-- removes those two specific client_events rows so both clients look like
-- they haven't had their intro call yet. Safe to re-run (no-ops once gone).
-- ============================================================================
delete from client_events
where event_type = 'intro_call'
  and client_id in (
    select id from clients
    where (first_name = 'JD' and last_name = 'Smith')
       or (first_name = 'Curtis' and last_name = 'Pittman')
  );
