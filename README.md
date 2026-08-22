# Studio PM

A minimal project management tool for small design studios.

## Features
- Project list with designer assignment, status, and checklist tracking
- Timeline / Gantt chart with designer colour coding
- Checklist per project (brief, content, print quotes, approvals, etc.)
- Dropbox folder link per project
- Data syncs to **Supabase** when configured (and still mirrors to **localStorage**); see **Supabase** section below

## Deploy to Netlify via GitHub

1. Push this folder to a new GitHub repo
2. Log in to Netlify → "Add new site" → "Import an existing project"
3. Connect your GitHub repo
4. Build settings are auto-detected from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `build`
5. Click Deploy — you'll have a live URL in ~2 minutes

**So the live site uses the same cloud data as your computer**

6. Netlify → your site → **Site configuration** → **Environment variables** → **Add a variable**:
   - `REACT_APP_SUPABASE_URL` = your project URL (same as in `.env.local`)
   - `REACT_APP_SUPABASE_ANON_KEY` = your anon / publishable key (same as in `.env.local`)
7. **Deploys** → **Trigger deploy** → **Clear cache and deploy site** (env vars are baked in at build time).

Anyone who opens your Netlify URL then shares the same **Supabase** `studio_workspace` row — no extra setup on their machine.

## Google login (studio accounts)

The live app signs in with **Google** through Supabase. Only `@extendedwhanau.com` emails can load or save data (see `supabase/auth-rls.sql`).

### 1. Google Cloud — OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Create or pick a project in the Extended Whānau org
3. [APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)  
   User type: **Internal** (Workspace only)
4. [Credentials → Create credentials → OAuth client ID](https://console.cloud.google.com/apis/credentials)  
   Application type: **Web application**
5. Authorised JavaScript origins:
   - `http://localhost:3000`
   - `https://extendedwhanau.netlify.app`
   - your custom domain if you add one
6. Authorised redirect URIs — copy the callback from Supabase (step 2). It looks like:  
   `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`

### 2. Supabase — Google provider

Dashboard links (replace `YOUR_PROJECT_REF` with your ref from **Project Settings → General**):

- [Authentication → Providers → Google](https://supabase.com/dashboard/project/_/auth/providers)
- [Authentication → URL Configuration](https://supabase.com/dashboard/project/_/auth/url-configuration)
- [SQL Editor](https://supabase.com/dashboard/project/_/sql/new)
- [Project Settings → API](https://supabase.com/dashboard/project/_/settings/api)

Steps:

1. **Providers → Google** → enable, paste the Google **Client ID** and **Client secret**
2. **URL Configuration**
   - Site URL: `https://extendedwhanau.netlify.app` (and `http://localhost:3000` for local)
   - Redirect URLs: same origins as above
3. Copy **Callback URL** from the Google provider panel into Google Cloud redirect URIs
4. SQL Editor → paste and run [`supabase/auth-rls.sql`](supabase/auth-rls.sql)  
   If your email domain is not `extendedwhanau.com`, edit the domain list in that file first.

### 3. App + Netlify env

In `.env.local` and Netlify **Site configuration → Environment variables**:

- `REACT_APP_SUPABASE_URL`
- `REACT_APP_SUPABASE_ANON_KEY`
- `REACT_APP_STUDIO_EMAIL_DOMAINS=extendedwhanau.com`

Redeploy after changing env vars.

### Notifications (Google Chat)

Chat DMs only when someone is **added to a job**, or that job’s **timeline start/end dates** change. Set each person’s **Google email** in Team. See [`google-chat/README.md`](google-chat/README.md).

**Milestones** are intended for **Google Calendar** (client + project + milestone name + date), not Chat.

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
3. Reload the app (`npm start`). It will **load** that shared data, **save** after you edit, and **sync live** across open tabs/devices (still also writes **localStorage** as a backup).

If Realtime was enabled after your first setup, run only the Realtime block at the bottom of **`supabase/schema.sql`** once in the SQL Editor.

If sync stops after the first edit, run the **`set_studio_workspace_updated_at` trigger block** in **`supabase/schema.sql`** (middle of the file) so timestamps always come from the server, not the browser clock.

If you skip the SQL step, the app keeps working from **localStorage** only (you may see a `[Supabase] load failed` message in the browser console).

## Google Calendar (milestones)

When a milestone (review / check-in marker) is **added or its date changes**, create or update an all-day Calendar event for each designer on that job:

- **Title:** `{Client} — {Project} — {Milestone name}`
- **Date:** the milestone date
- **Who:** people assigned to the job (same Google emails as Team)

Store `google_event_id` on each marker so updates move the event instead of duplicating it. Not wired yet — Chat path is separate.
