# Waystation Advisors

A small internal web app for tracking clients (buyers and sellers), the
team's own profiles, and the money (monthly subscriptions + closing
commissions).

**Start here:** `DEPLOYMENT.md` — step-by-step setup, ~15 minutes.

## What's in this folder

- `supabase/schema.sql` — the entire database: tables, roles, and the
  Row Level Security rules that enforce who can see/edit what.
- `js/config.js` — where you paste your Supabase project URL + key.
- `*.html` + `js/*.js` — the actual pages (login, profile, clients, dials,
  finance). Plain HTML/JS, no build step — open `login.html` and go, once
  it's deployed and configured.

## Pages

- **Profile** — your own account: name, role, and a Teams button (list of
  company teams — coming soon).
- **Clients** — every buyer and seller in one list. Tap a client to view
  their details; the + button in the corner adds a new one (name, buyer or
  seller, company name, contact info, industry, location, size, founding
  date, what they're looking for, and the intern/contractor working it).
- **Dials** — placeholder for now, more coming soon.
- **Finance** — team-lead-only: monthly subscription payments and deal
  commissions.

## Roles

- **Intern** — day-to-day use of Profile, Clients, and Dials.
- **Team lead** — everything interns have, plus the Finance page.

New signups always start as interns; promote someone to team lead from
the Supabase Table Editor (see `DEPLOYMENT.md` step 4).
