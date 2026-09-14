# AI 劍道動作分析系統

- Frontend: GitHub Pages (`index.html`, MediaPipe Pose)
- Backend: Supabase Edge Function `kendo-diagnosis` + table `kendo_records`

## Pages
Settings → Pages → Deploy from branch `main` / root.

## Supabase
1. SQL Editor 執行 `supabase/kendo_records.sql`
2. `supabase secrets set GEMINI_API_KEY=...`
3. `supabase functions deploy kendo-diagnosis --project-ref atbptsrpubmefyydgnde`
