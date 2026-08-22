# Studio PMS Chat app

DMs for:

1. **Added to a job** — not while **Potential** or **Scheduled**  
2. **Timeline dates changed** — not while **Potential** / **Scheduled**  
3. **Job Complete** — always `kaye@extendedwhanau.com`  

Check-in milestones also create/update all-day events on each assignee’s **primary Google Calendar** (Client — Project — Milestone).

**Already done if the bot replied in Chat:** Cloud Chat API, Apps Script `onMessage`, Head deployment ID.

Do the four blocks below in order. Each block says **where you click** and **what you should see**.

---

## A. Turn on the Chat service in Apps Script

This lets the script *send* DMs (`testDm` and PMS notifications). The Chat reply you already got does not use this.

1. Open [script.google.com](https://script.google.com) and open the **Studio PMS Chat** project (the one with `Code.gs`).
2. Left sidebar: under **Services**, click **+**.
   - If you do not see Services: click **Editor** (the `<>` icon) first.
3. In the list, click **Google Chat API**.
4. Leave identifier as `Chat`.
5. Click **Add**.
6. You should see **Chat** listed under Services.

If it asks to enable the API in Google Cloud, click to enable it, then Add again.

Then copy [`appsscript.json`](appsscript.json) from this folder into Apps Script (Editor → `appsscript.json`). It must include `oauthScopes` for `chat.spaces` and `chat.messages.create`. Do **not** add `chat.bot` — that causes `Error 400: invalid_scope` when you click Run.

---

## B. Add the webhook secret

1. In the same Apps Script project, left sidebar: **Project Settings** (gear).
2. Scroll to **Script properties**.
3. Click **Add script property**.
4. **Property:** `WEBHOOK_SECRET`  
   Type it exactly, all caps, no spaces.
5. **Value:** invent a long password, for example `ew-pms-7f3k9q2m`.  
   Copy it into a note. You need the same string in Supabase later.
6. Click **Save script properties**.

---

## C. Deploy a Web app (this is not the Chat deployment)

You already have a Chat / Head deployment. This is a **second** deployment. Supabase will POST to it.

1. Top right, click **Deploy**.
2. Click **New deployment**.
3. Next to **Select type**, click the gear.
4. Click **Web app**.
5. Fill in:
   - **Description:** `Supabase webhook`
   - **Execute as:** `Me` (your Google account)
   - **Who has access:** `Anyone`
6. Click **Deploy**.
7. If Google asks you to **Authorise access**:
   - Click **Authorise access**
   - Pick your **@extendedwhanau.com** account
   - If you see **Google hasn’t verified this app**: click **Advanced** → **Go to Studio PMS Chat (unsafe)** → **Allow**
8. On the success screen, copy **Web app URL**.  
   It looks like:  
   `https://script.google.com/macros/s/AKfycb…/exec`  
   **Copy this URL, not the Deployment ID.**
9. Click **Done**.

Paste the URL into a note. The full webhook address is:

```
https://script.google.com/macros/s/YOUR_ID/exec?secret=YOUR_WEBHOOK_SECRET
```

Replace `YOUR_WEBHOOK_SECRET` with the exact value from step B (no extra spaces).

---

## D. Send yourself a test DM from Apps Script

1. Click **Editor** (`<>`) so you see `Code.gs`.
2. In the toolbar, find the function dropdown (it may say `onMessage` or `doGet`).
3. Choose **`testDm`**.
4. Click **Run** (the play button).
5. Authorise if asked (same Allow flow as above).
6. Open [Google Chat](https://chat.google.com). You should get a DM from **Studio PMS**:  
   `PMS test: Chat bot can message you.`

**If it errors** with no DM space: in Chat, open the Studio PMS DM, send `test`, wait for the reply, then Run `testDm` again.

**If it errors** about Chat / `Chat is not defined`: step A did not stick. Add Google Chat API under Services again, Save, Run `testDm` again.

---

## E. Connect Supabase

1. Open your Supabase project.
2. Left: **SQL Editor** → New query. Paste the `studio_notify_events` section from `supabase/auth-rls.sql` if you have not already run that file. Run it.
3. Left: **Table Editor** → confirm a table named **`studio_notify_events`** exists.
4. Left: **Database** → **Webhooks** (sometimes under **Integrations**).
5. **Create a new webhook**:
   - **Name:** `studio-pms-chat`
   - **Table:** `studio_notify_events`
   - **Events:** tick **Insert** only
   - **Type:** HTTP request
   - **Method:** POST
   - **URL:** the full URL from the end of step C (`…/exec?secret=…`)
6. Save the webhook.

---

## F. Test from the PMS

1. Open the studio PMS in the browser.
2. **Team:** open each person and set **Google email** to their real `@extendedwhanau.com` address. Save.
3. Open a job. Assign **someone else** (not you) who has an email set.
4. Change something (status or a date) and **Save**.
5. That other person should get a Chat DM from Studio PMS.  
   **You will not**, if you were the one who clicked Save.

If nobody is DMed: Table Editor → `studio_notify_events`. A new row should appear after Save.  
- No row → the PMS did not queue a notification (email missing, or you were the only assignee).  
- Row exists, no DM → Apps Script **Executions**: look for `doPost`. Open the failed one for the error.

---

## Calendar (milestones → calendars)

**No domain-wide delegation needed.**

When a check-in milestone is added/updated, the Web app (Execute as **Me**) creates an all-day event on **your** Google Calendar and **invites** each assignee. It shows on their calendars as a meeting invite.

1. Paste latest `Code.gs` + `appsscript.json` → Save  
2. **Web app → New version → Deploy** (Execute as Me, Anyone)  
3. First calendar run: allow Calendar permission if Google asks  

Event title: `Client — Project — Milestone name`.

If invites never appear: confirm Team Google emails, and that the person who owns the Apps Script Web app can create calendar events.

---

## To-Do → Google Tasks / Calendar

Dated to-dos from the PMS **To-Do** page become a Google **Task** only (Calendar → Tasks, with a checkbox). They do **not** create calendar events.

- Tick it done in the PMS → the Google Task completes  
- Clear the date or delete the to-do → the Google Task is removed  
- No date → stays in the PMS only  

Tasks are created on the Apps Script owner’s Google Tasks list (Execute as Me).

1. Paste latest `Code.gs` + `appsscript.json` → Save  
2. Services **+** → **Tasks API** → Add  
3. Run **`testTodoTask`** → allow Tasks access if Google asks  
4. **Web app → New version → Deploy** (Execute as Me, Anyone)  

Team members need a **Google email** set. Google sync only runs when you are **signed into the PMS** (not the localhost preview bypass).

Ticking complete in Google Calendar does not yet write back to the PMS — that is the next step.

---

## Chat API reminder (already working)

Bot replies in Chat use **Deploy → Test deployments → Head deployment ID** pasted into  
[Chat API → Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) → **Connection settings** → **Deployment ID**.

Do not replace that with the Web app URL. They are different.
