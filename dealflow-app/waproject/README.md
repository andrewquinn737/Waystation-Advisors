# Temporary WhatsApp dialing page

Standalone copy of the Dials page (tabs, category filter, search, CSV import, dial popup) for a side project.
Calls and texts open WhatsApp instead of the company line.

- Link: `/waproject/` on the app's domain (add to home screen from there for its own icon).
- Not linked from anywhere in the main app; the main app does not import anything from this folder.
- It only reads `../css/style.css` (looks) and `../js/supabaseClient.js` (same login / same database).
- Own tables: `wp_lists`, `wp_dials` (see `schema.sql`).

## To remove it
1. In Supabase run: `drop table public.wp_dials; drop table public.wp_lists;`
2. Delete this `waproject/` folder and push.
Nothing else needs touching.
