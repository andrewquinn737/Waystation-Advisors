# Temporary WhatsApp dialing page

Standalone copy of the Dials page (tabs, category filter, search, CSV import, dial popup) for a side project.
Calls and texts open WhatsApp instead of the company line.

- Link: `/waproject/` on the app's domain (add to home screen from there for its own icon).
- Not linked from anywhere in the main app; the main app does not import anything from this folder.
- It only reads `../css/style.css` (looks). No sign-in: it opens from a private link ending in `#key=...` and remembers the key in the browser.
- Own connection to the same Supabase project (`client.js`).
- Own tables: `wp_lists`, `wp_dials` (see `schema.sql`).

## To remove it
1. In Supabase run: `drop table public.wp_dials; drop table public.wp_lists; drop function public.wp_key_ok();`
2. Delete this `waproject/` folder and push.
Nothing else needs touching.
