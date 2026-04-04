# Studio PM

A minimal project management tool for small design studios.

## Features
- Project list with designer assignment, status, and checklist tracking
- Timeline / Gantt chart with designer colour coding
- Checklist per project (brief, content, print quotes, approvals, etc.)
- Dropbox folder link per project
- Data persists in **localStorage** for now (Supabase wiring started; cloud sync comes next)

## Deploy to Netlify via GitHub

1. Push this folder to a new GitHub repo
2. Log in to Netlify → "Add new site" → "Import an existing project"
3. Connect your GitHub repo
4. Build settings are auto-detected from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `build`
5. Click Deploy — you'll have a live URL in ~2 minutes

## Run locally

```bash
npm install
npm start
```

## Supabase — simple checklist

**What Supabase is:** A free online database. Your app will save projects there so everyone sees the same data (instead of only on one computer’s browser).

**What is already done**

1. You created a project at [supabase.com](https://supabase.com).
2. The app has a file **`.env.local`** (in this folder, next to `package.json`). It holds your project **URL** and **API key** so the app knows *which* database to talk to.
3. The code file **`src/supabaseClient.js`** is ready to use once we hook up saving/loading.

**Where is `.env.local`? (why you might not see it)**

- It lives in the **project root** — the **same folder** as `package.json`, `README.md`, and `src/`.
- On your Mac the full path is:  
  `Documents/Design/Web/EW STUDIO PMS/.env.local`
- Files whose name starts with a **dot** (`.`) are often **hidden** in Finder and sometimes in the editor sidebar.
- **In Cursor:** press **Cmd+P** (Quick Open), type **`.env.local`**, press Enter — that opens the file even if it’s not listed in the tree.
- **Or:** menu **File → Open File…** and navigate to the project folder, then press **Cmd+Shift+.** in Finder to show hidden files so `.env.local` appears.
- If you ever delete it by mistake, copy **`.env.example`** to **`.env.local`** and paste your URL and key again from the Supabase dashboard (**Project Settings → API**).

**What you do day to day**

- Run `npm start` as usual.  
- **Do not** commit `.env.local` to Git — it’s private settings (Git is already set to ignore it).

**If something says “invalid API key” or won’t connect**

- In Supabase: **Project Settings → API**.  
- Copy the **`anon` `public`** key (a long string, often starts with `eyJ…`) into `.env.local` on the line `REACT_APP_SUPABASE_ANON_KEY=...` and save.  
- Stop and start `npm start` again.

**Database (required once for cloud sync)**

1. Supabase → **SQL Editor** → New query.  
2. Paste everything in **`supabase/schema.sql`** from this repo and click **Run**.  
3. Reload the app (`npm start`). It will **load** that shared data and **save** after you edit (still also writes **localStorage** as a backup).

If you skip the SQL step, the app keeps working from **localStorage** only (you may see a `[Supabase] load failed` message in the browser console).

## Adding Google Calendar integration

Each project has `startDate` and `endDate`. To push deadlines to Google
Calendar, use the Google Calendar API with OAuth2. The event creation
endpoint is `POST /calendars/primary/events` with the project's
`endDate` as the event date.
