# Studio PM

A minimal project management tool for small design studios.

## Features
- Project list with designer assignment, status, and checklist tracking
- Timeline / Gantt chart with designer colour coding
- Checklist per project (brief, content, print quotes, approvals, etc.)
- Dropbox folder link per project
- Data persists in localStorage (ready to upgrade to Supabase)

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

## Upgrading to Supabase (when ready)

Replace the `localStorage.getItem / setItem` calls in `App.js` with
Supabase client reads/writes. The data shape stays identical — just swap
the persistence layer. See `src/App.js` for the two `useEffect` hooks
and two state initialisers to update.

## Adding Google Calendar integration

Each project has `startDate` and `endDate`. To push deadlines to Google
Calendar, use the Google Calendar API with OAuth2. The event creation
endpoint is `POST /calendars/primary/events` with the project's
`endDate` as the event date.
