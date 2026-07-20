# Deal Flow

A small internal web app for tracking sellers (leads found by interns),
buyers (paying clients), the deals connecting them, and the money
(monthly subscriptions + closing commissions).

**Start here:** `DEPLOYMENT.md` — step-by-step setup, ~15 minutes.

## What's in this folder

- `supabase/schema.sql` — the entire database: tables, roles, and the
  Row Level Security rules that enforce who can see/edit what.
- `js/config.js` — where you paste your Supabase project URL + key.
- `*.html` + `js/*.js` — the actual pages (login, buyers, sellers, deals,
  finance). Plain HTML/JS, no build step — open `login.html` and go, once
  it's deployed and configured.

## Roles

- **Intern** — edits contact info & status on buyers/sellers assigned to
  them. No access to financials (subscriptions, commissions, pricing).
- **Team lead** — full access: assigns work, sets pricing, closes deals,
  tracks payments and commissions on the Finance page.

New signups always start as interns; promote someone to team lead from
the Supabase Table Editor (see `DEPLOYMENT.md` step 4).
