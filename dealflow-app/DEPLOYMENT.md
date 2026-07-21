# Deploying Waystation Advisors

This app is plain HTML/CSS/JS — no build step, no npm install required. It talks
directly to a Supabase project (a hosted Postgres database + login system).
Getting it live takes two accounts, both free to start: **Supabase** (the
database) and **Vercel** (hosting the pages).

Total time: ~15 minutes.

## 1. Create the database (Supabase)

1. Go to [supabase.com](https://supabase.com) and sign up / sign in.
2. Click **New project**. Pick any name (e.g. "dealflow"), set a database
   password (save it somewhere), pick the region closest to you, and create it.
   Wait ~2 minutes for it to provision.
3. In the left sidebar, open **SQL Editor** → **New query**.
4. Open `supabase/schema.sql` from this project, copy the whole file, paste it
   into the SQL editor, and click **Run**. This creates all the tables,
   permissions, and automation described below.
5. In the left sidebar, go to **Project Settings** → **API**. You'll need two
   values from this page in the next step:
   - **Project URL**
   - **anon / public** key (NOT the `service_role` key — never put that one
     in frontend code)
6. Still in Supabase, go to **Authentication** → **Providers** → **Email**,
   and turn **off** "Confirm email" while you're testing (turn it back on
   later if you want people to verify their email before logging in).

## 2. Point the app at your database

1. Open `js/config.js` in this project.
2. Replace the two placeholder values with the Project URL and anon key from
   step 1.5 above.

```js
export const SUPABASE_URL = "https://your-project-ref.supabase.co";
export const SUPABASE_ANON_KEY = "your-anon-public-key";
```

## 3. Put it online (Vercel)

Since there's no build step, this is just "upload the folder":

1. Go to [vercel.com](https://vercel.com) and sign up / sign in (GitHub login
   is easiest).
2. Click **Add New** → **Project**.
3. Easiest path: push this whole `dealflow-app` folder to a new GitHub repo,
   then import that repo in Vercel. (Alternative: some Vercel accounts
   support dragging a folder straight onto the dashboard — if you see that
   option, you can skip GitHub entirely.)
4. Framework preset: choose **Other** — there's no build command, no output
   directory to set. Deploy.
5. Vercel gives you a URL like `dealflow-app.vercel.app`. That's the app,
   live, shareable with your whole team.

Any static host works the same way (Netlify, Cloudflare Pages, GitHub Pages)
if you'd rather use one of those.

## 4. Create your account and become a team lead

1. Visit your new URL, click **Create an account**, sign up with your email.
2. Every new signup starts as an **intern** (safe default). To make yourself
   (or anyone else) a **team lead**:
   - In Supabase, go to **Table Editor** → `profiles`.
   - Find your row, change `role` from `intern` to `team_lead`, save.
   - Refresh the app — you'll now see the Finance tab and full edit rights.
3. Repeat that role change for other team leads. Everyone else who signs up
   stays an intern automatically.

## 5. Day-to-day use

- **Interns**: sign up, see their own info on the Profile page, and add/view
  clients (buyers and sellers) on the Clients page.
- **Team leads**: everything interns have, plus the Finance page — logging
  and tracking monthly subscription payments and commissions.

## 6. Get it on interns' phones (no app store needed)

The app is already set up as a **PWA (Progressive Web App)** — it has an
icon, a name, and can run full-screen like a native app once "installed"
from the browser. No Apple/Google developer account, no app review, no fees.
Once it's deployed (step 3), send interns the URL and have them:

**iOS (iPhone), in Safari:**
1. Open the app URL in Safari (must be Safari, not Chrome — iOS only allows
   installing from Safari).
2. Tap the **Share** icon (square with an arrow) in the toolbar.
3. Scroll down and tap **Add to Home Screen**.
4. It now appears as a "Waystation Advisors" icon and opens full-screen, no browser
   bar.

**Android, in Chrome:**
1. Open the app URL in Chrome.
2. Tap the **⋮** menu → **Add to Home screen** (or Chrome may show an
   automatic **Install app** banner/prompt — tap it).
3. Same result: a home screen icon that opens full-screen.

This is almost always the right call for an internal team tool — it's free,
instant to roll out (no review wait), and update instantly for everyone the
next time they open it (no app store update cycle).

### If you actually want it on the App Store / Play Store later

Possible, but worth knowing before you commit:

- **Apple is picky about this.** App Store guideline 4.2 explicitly allows
  rejecting apps that are just a website wrapped in a shell with no added
  native functionality. Internal business tools like this one are exactly
  the kind of app that can get bounced. Apple's own workaround for
  business-internal apps is often **TestFlight** (for a small known group,
  no public review) rather than the public App Store.
- **The technical path**, if you go this way: wrap the app with
  [Capacitor](https://capacitorjs.com) (turns this same HTML/JS/CSS into an
  installable iOS/Android binary with minimal changes), then submit through
  an Apple Developer account ($99/year) and a Google Play Developer account
  ($25 one-time).
- Since this is an internal tool with a small, known user base (your
  interns), the PWA approach above gets you the same "tap an icon, it
  opens" experience without any of that overhead. I'd only revisit the
  native-wrapper route if you outgrow the PWA (e.g. need push notifications,
  camera access, or other native-only APIs).

## Costs

Supabase and Vercel free tiers comfortably cover 50–500 records and a
handful of simultaneous users. If you outgrow the free tier (heavy traffic,
need daily backups, etc.), both have inexpensive pay-as-you-go plans — you
won't need to rebuild anything, just upgrade the plan.

## If something breaks

- **"Failed to fetch" or blank pages**: double check `js/config.js` has the
  right URL/key and that you ran `schema.sql` successfully (check the SQL
  Editor for errors).
- **A user can't see data they should**: check their `role` in the
  `profiles` table, and check the `assigned_to` field on the buyer/seller
  record actually points to their user id.
- **Login works but nothing loads**: open the browser console (F12) — errors
  from Supabase show up there with a specific reason (usually an RLS policy
  blocking something, which tells you exactly which table/action).
