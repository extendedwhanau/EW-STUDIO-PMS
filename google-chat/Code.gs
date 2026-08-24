/**
 * Extended Whānau PMS — Google Chat app
 *
 * DMs people assigned to a job when the PMS queues a notification.
 * Also replies if someone messages the bot with "test".
 *
 * Script properties:
 *   WEBHOOK_SECRET              — same as ?secret= on the web app URL
 *   CHAT_SERVICE_ACCOUNT        — full JSON key of a service account in the Chat Cloud project
 *   WEBHOOK_PUBLIC_URL          — optional /exec URL for self-tests
 *   SUPABASE_URL                — Project URL (for Google Tasks → PMS completions)
 *   SUPABASE_SERVICE_ROLE_KEY   — service_role key (Apps Script only, never the website)
 *
 * Calendar milestones need domain-wide delegation on that service account for
 * scope https://www.googleapis.com/auth/calendar (impersonate each designer).
 */

function onMessage(event) {
  rememberChatUser_(event);
  const text = messageTextFromEvent(event).toLowerCase();
  if (text === 'test' || text.indexOf('test') >= 0) {
    return chatReply('PMS bot is on. You get a DM when you are added to a job, or when that job’s dates change.');
  }
  return chatReply('Studio PMS Chat: added to a job, or timeline dates change. Message **test** to check.');
}

/** Names must match Chat API → Configuration → Triggers. */
function onAppCommand(event) {
  return onMessage(event);
}

function onAddedToSpace(event) {
  rememberChatUser_(event);
  return chatReply('PMS bot added. I DM you when you are put on a job, or when that job’s dates change.');
}

function onAddToSpace() {
  return onAddedToSpace();
}

function onRemovedFromSpace() {
  return {};
}

function onRemoveFromSpace() {
  return {};
}

/** Workspace add-on Chat: only this shape. Extra keys (like top-level `text`) make Chat say "not responding". */
function chatReply(text) {
  try {
    const message = AddOnsResponseService.newChatMessage().setText(text);
    const action = AddOnsResponseService.newCreateMessageAction().setMessage(message);
    return AddOnsResponseService.newChatDataActionBuilder()
      .setCreateChatMessageAction(action)
      .build();
  } catch (err) {
    return {
      hostAppDataAction: {
        chatDataAction: {
          createMessageAction: {
            message: { text: text }
          }
        }
      }
    };
  }
}

function messageTextFromEvent(event) {
  if (!event) return '';
  const classic = event.message && (event.message.argumentText || event.message.text);
  const addon = event.chat && event.chat.messagePayload && event.chat.messagePayload.message
    && (event.chat.messagePayload.message.argumentText || event.chat.messagePayload.message.text);
  return String(classic || addon || '').trim();
}

function doPost(e) {
  try {
    const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET') || '';
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const querySecret = (e && e.parameter && e.parameter.secret)
      || String(body.webhook_secret || '');
    if (!secret || querySecret !== secret) {
      const bad = { ok: false, error: 'unauthorized', hasSecret: Boolean(secret), hasQuerySecret: Boolean(querySecret) };
      Logger.log(JSON.stringify(bad));
      PropertiesService.getScriptProperties().setProperty('LAST_DOPOST', JSON.stringify(bad));
      return jsonOut(bad);
    }

    const record = parseNotifyRecord_(body);
    const kind = notifyKind_(record);
    PropertiesService.getScriptProperties().setProperty(
      'LAST_DOPOST',
      JSON.stringify({ kind: kind, summary: record.summary || '', payload: record.payload || {} })
    );
    if (kind === 'calendar_milestone') {
      const result = handleCalendarMilestone_(record);
      Logger.log(JSON.stringify(result));
      PropertiesService.getScriptProperties().setProperty('LAST_DOPOST', JSON.stringify(result));
      return jsonOut(result);
    }
    if (kind === 'calendar_reset') {
      const result = resetStudioPmsCalendarEvents();
      Logger.log(JSON.stringify(result));
      PropertiesService.getScriptProperties().setProperty('LAST_DOPOST', JSON.stringify(result));
      return jsonOut(result);
    }
    if (kind === 'calendar_todo') {
      const result = handleCalendarTodo_(record);
      Logger.log(JSON.stringify(result));
      PropertiesService.getScriptProperties().setProperty('LAST_DOPOST', JSON.stringify(result));
      return jsonOut(result);
    }
    if (kind.indexOf('calendar_') === 0 || (record.payload && (record.payload.todo_id || record.payload.marker_id || record.payload.calendar_title))) {
      const skipCal = { ok: false, error: 'skip chat for calendar payload', kind: kind };
      Logger.log(JSON.stringify(skipCal));
      PropertiesService.getScriptProperties().setProperty('LAST_DOPOST', JSON.stringify(skipCal));
      return jsonOut(skipCal);
    }

    const summary = String(record.summary || '').trim();
    const recipients = parseRecipients(record.recipients);
    if (!summary || recipients.length === 0) {
      const skip = {
        ok: false,
        error: 'no recipients',
        summary: summary,
        rawRecipients: record.recipients,
        linked: Object.keys(parseJsonMap_(PropertiesService.getScriptProperties().getProperty('CHAT_USER_SPACES'))),
      };
      Logger.log(JSON.stringify(skip));
      PropertiesService.getScriptProperties().setProperty('LAST_DOPOST', JSON.stringify(skip));
      return jsonOut(skip);
    }

    const sent = [];
    const failed = [];
    recipients.forEach(function (email) {
      try {
        sendDirectMessage(email, summary);
        sent.push(email);
      } catch (err) {
        failed.push({ email: email, error: String(err && err.message ? err.message : err) });
      }
    });

    const result = {
      ok: failed.length === 0 && sent.length > 0,
      via: 'chat',
      kind: kind || 'chat',
      sent: sent,
      failed: failed,
    };
    Logger.log(JSON.stringify(result));
    PropertiesService.getScriptProperties().setProperty('LAST_DOPOST', JSON.stringify(result));
    return jsonOut(result);
  } catch (err) {
    const bad = { ok: false, error: String(err && err.message ? err.message : err) };
    Logger.log(JSON.stringify(bad));
    PropertiesService.getScriptProperties().setProperty('LAST_DOPOST', JSON.stringify(bad));
    return jsonOut(bad);
  }
}

function doGet() {
  return ContentService.createTextOutput('PMS webhook v7 calendar-upsert. Use POST from Supabase.');
}

/** Run in editor after messaging Studio PMS with test — same path as Supabase webhook. */
function testDoPostWebhook() {
  const email = Session.getActiveUser().getEmail();
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET') || '';
  const out = doPost({
    parameter: { secret: secret },
    postData: {
      contents: JSON.stringify({
        type: 'INSERT',
        record: {
          summary: 'Apps Script webhook test',
          recipients: [email],
        },
        webhook_secret: secret,
      }),
    },
  });
  Logger.log(out.getContent());
  const data = JSON.parse(out.getContent());
  if (!data.ok || (data.failed && data.failed.length)) {
    throw new Error(out.getContent());
  }
  if (!data.sent || !data.sent.length) {
    throw new Error('Nothing sent: ' + out.getContent());
  }
}

function pickBotDm_(dms) {
  const list = dms || [];
  if (list.length === 0) return null;
  const score = function (space) {
    const label = String(space.displayName || space.name || '').toLowerCase();
    let n = 0;
    if (label.indexOf('pms') >= 0) n += 100;
    if (label.indexOf('studio') >= 0) n += 50;
    if (label.indexOf('whanau') >= 0 || label.indexOf('whānau') >= 0) n += 20;
    return n;
  };
  let best = list[0];
  let bestScore = score(best);
  for (let i = 1; i < list.length; i++) {
    const s = score(list[i]);
    if (s > bestScore) {
      best = list[i];
      bestScore = s;
    }
  }
  if (bestScore > 0) return best;
  const byActive = list.slice().sort(function (a, b) {
    return String(b.lastActiveTime || b.updateTime || '').localeCompare(String(a.lastActiveTime || a.updateTime || ''));
  });
  return byActive[0] || list[0];
}

/**
 * Run once per person: links your Google email to your Studio PMS Chat DM.
 * Do this after sending test to Studio PMS in Chat.
 */
function linkMyChat() {
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('Could not read your email.');
  const token = getChatBotToken_();
  const listed = chatApi_(
    'get',
    'https://chat.googleapis.com/v1/spaces?filter=' + encodeURIComponent('spaceType = "DIRECT_MESSAGE"') + '&pageSize=100',
    token
  );
  const dms = (listed.spaces || []).filter(function (s) { return s.singleUserBotDm; });
  const picked = pickBotDm_(dms);
  if (!picked) {
    throw new Error('Send test to Studio PMS in Chat first. No bot DMs found.');
  }
  const props = PropertiesService.getScriptProperties();
  const spaces = parseJsonMap_(props.getProperty('CHAT_USER_SPACES'));
  spaces[String(email).toLowerCase()] = picked.name;
  props.setProperty('CHAT_USER_SPACES', JSON.stringify(spaces));
  chatApi_('post', 'https://chat.googleapis.com/v1/' + picked.name + '/messages', token, {
    text: 'You are linked. PMS job updates will appear here from Studio PMS.',
  });
}

/** Run in editor — lists emails that have messaged the bot (can receive DMs). */
function listLinkedChatUsers() {
  const spaces = parseJsonMap_(PropertiesService.getScriptProperties().getProperty('CHAT_USER_SPACES'));
  Logger.log('Linked emails: ' + (Object.keys(spaces).join(', ') || '(none — send test to Studio PMS in Chat first)'));
}

/** Run after a quiet date-change: shows the last webhook result (why Chat stayed silent). */
function showLastDoPost() {
  const raw = PropertiesService.getScriptProperties().getProperty('LAST_DOPOST') || '(none yet)';
  Logger.log(raw);
  throw new Error(raw);
}

/**
 * Calls this project's Web app over HTTP (same path Netlify uses).
 * Web app must be: Execute as Me, Who has access = Anyone.
 * Optional script property WEBHOOK_PUBLIC_URL = the /exec URL from Manage deployments.
 */
function testWebhookViaHttp() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEBHOOK_PUBLIC_URL') || ScriptApp.getService().getUrl();
  if (!url) {
    throw new Error('No Web app URL. Deploy → New deployment → Web app (access: Anyone), then set WEBHOOK_PUBLIC_URL to the /exec link.');
  }
  const secret = props.getProperty('WEBHOOK_SECRET') || '';
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('Could not read your email.');
  Logger.log('POST ' + url);
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      webhook_secret: secret,
      type: 'INSERT',
      record: {
        summary: 'Self HTTP webhook test',
        recipients: [email],
      },
    }),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const text = res.getContentText() || '';
  const short = text.indexOf('<!DOCTYPE') === 0
    ? ('HTML error page (access not public). HTTP ' + res.getResponseCode()
      + '. Redeploy Web app with Who has access = Anyone, copy /exec URL into WEBHOOK_PUBLIC_URL and Netlify.')
    : text;
  Logger.log('HTTP ' + res.getResponseCode() + ' ' + short.slice(0, 500));
  throw new Error('HTTP ' + res.getResponseCode() + ' ' + short.slice(0, 500));
}

/** Hits the live Web app with a fake dated to-do — same path as the PMS. */
function testWebhookTodoViaHttp() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEBHOOK_PUBLIC_URL') || ScriptApp.getService().getUrl();
  if (!url) {
    throw new Error('No Web app URL. Deploy → Manage deployments → Web app, copy /exec URL into WEBHOOK_PUBLIC_URL.');
  }
  const secret = props.getProperty('WEBHOOK_SECRET') || '';
  const tomorrow = new Date();
  tomorrow.setHours(12, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = tomorrow.getFullYear() + '-'
    + ('0' + (tomorrow.getMonth() + 1)).slice(-2) + '-'
    + ('0' + tomorrow.getDate()).slice(-2);
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      webhook_secret: secret,
      type: 'INSERT',
      record: {
        kind: 'calendar_todo',
        summary: 'Studio PMS to-do webhook test',
        recipients: [Session.getActiveUser().getEmail()],
        payload: {
          notify_kind: 'calendar_todo',
          action: 'create',
          todo_id: 'pms-todo-webhook-test',
          date: iso,
          done: false,
          calendar_title: 'Studio PMS to-do webhook test',
        },
      },
    }),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const text = res.getContentText() || '';
  const short = text.indexOf('<!DOCTYPE') === 0
    ? ('HTML error page. Redeploy Web app, access Anyone.')
    : text;
  throw new Error('HTTP ' + res.getResponseCode() + ' ' + short.slice(0, 800));
}

/** Run once in the editor — Google will ask for Calendar access. Then Deploy Web app → New version. */
function testCalendar() {
  const email = Session.getActiveUser().getEmail();
  const cal = CalendarApp.getDefaultCalendar();
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const event = cal.createAllDayEvent(
    'Studio PMS calendar test',
    tomorrow,
    {
      description: 'You can delete this. PMS milestone invites will work after this permission.',
      guests: email,
      sendInvites: false,
    }
  );
  Logger.log('Created event id: ' + event.getId());
  throw new Error('Calendar OK. Event “Studio PMS calendar test” is on your calendar for tomorrow. Deploy Web app → New version next.');
}

/** Send a bot DM. Select testDm, Run. */
function testDm() {
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('Could not read your email. Authorise the script and try again.');
  sendDirectMessage(email, 'PMS test: this message should appear from Studio PMS, not from you.');
}

function parseRecipients(raw) {
  if (!raw) return [];
  if (Object.prototype.toString.call(raw) === '[object Array]') {
    return raw.map(function (item) { return String(item || '').trim().toLowerCase(); }).filter(Boolean);
  }
  if (typeof raw === 'string') {
    try {
      return parseRecipients(JSON.parse(raw));
    } catch (err) {
      return raw.split(',').map(function (item) { return item.trim().toLowerCase(); }).filter(Boolean);
    }
  }
  return [];
}

function sendDirectMessage(email, text) {
  const token = getChatBotToken_();
  const spaceName = spaceNameForEmail_(email, token);
  if (!spaceName) {
    throw new Error('No Chat DM for ' + email + '. They must open Studio PMS in Chat, send test, then try again.');
  }
  chatApi_('post', 'https://chat.googleapis.com/v1/' + spaceName + '/messages', token, { text: text });
}

function rememberChatUser_(event) {
  const email = chatEmailFromEvent_(event);
  const space = chatSpaceFromEvent_(event);
  const user = chatUserNameFromEvent_(event);
  if (!email) return;
  const props = PropertiesService.getScriptProperties();
  const spaces = parseJsonMap_(props.getProperty('CHAT_USER_SPACES'));
  const users = parseJsonMap_(props.getProperty('CHAT_USER_IDS'));
  if (space) spaces[email] = space;
  if (user) users[email] = user;
  if (space) props.setProperty('CHAT_USER_SPACES', JSON.stringify(spaces));
  if (user) props.setProperty('CHAT_USER_IDS', JSON.stringify(users));
}

function spaceNameForEmail_(email, token) {
  const key = String(email || '').trim().toLowerCase();
  const props = PropertiesService.getScriptProperties();
  const spaces = parseJsonMap_(props.getProperty('CHAT_USER_SPACES'));
  if (spaces[key]) return spaces[key];
  const users = parseJsonMap_(props.getProperty('CHAT_USER_IDS'));
  if (users[key]) {
    const dm = chatApi_(
      'get',
      'https://chat.googleapis.com/v1/spaces:findDirectMessage?name=' + encodeURIComponent(users[key]),
      token
    );
    if (dm && dm.name) {
      spaces[key] = dm.name;
      props.setProperty('CHAT_USER_SPACES', JSON.stringify(spaces));
      return dm.name;
    }
  }
  const listed = chatApi_(
    'get',
    'https://chat.googleapis.com/v1/spaces?filter=' + encodeURIComponent('spaceType = "DIRECT_MESSAGE"') + '&pageSize=100',
    token
  );
  const dms = (listed.spaces || []).filter(function (s) { return s.singleUserBotDm; });
  const picked = pickBotDm_(dms);
  if (picked && picked.name) {
    spaces[key] = picked.name;
    props.setProperty('CHAT_USER_SPACES', JSON.stringify(spaces));
    return picked.name;
  }
  return '';
}

function parseJsonMap_(raw) {
  try {
    const obj = JSON.parse(raw || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    return {};
  }
}

function objectPayload_(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (err) { /* ignore */ }
  }
  return {};
}

function parseNotifyRecord_(body) {
  let record = (body && (body.record || body.new)) || body || {};
  if (typeof record === 'string') {
    try { record = JSON.parse(record); } catch (err) { record = {}; }
  }
  if (!record || typeof record !== 'object') record = {};
  record.payload = objectPayload_(record.payload);
  return record;
}

function notifyKind_(record) {
  const payload = (record && record.payload) || {};
  if (payload.notify_kind === 'calendar_reset' || payload.action === 'calendar_reset') return 'calendar_reset';
  if (payload.todo_id || payload.notify_kind === 'calendar_todo') return 'calendar_todo';
  if (payload.marker_id || payload.notify_kind === 'calendar_milestone') return 'calendar_milestone';
  return String((record && record.kind) || payload.notify_kind || '').trim();
}

function chatEmailFromEvent_(event) {
  if (!event) return '';
  const classic = event.user && event.user.email;
  const addon = event.chat && event.chat.user && event.chat.user.email;
  const sender = event.chat && event.chat.messagePayload && event.chat.messagePayload.message
    && event.chat.messagePayload.message.sender && event.chat.messagePayload.message.sender.email;
  return String(classic || addon || sender || '').trim().toLowerCase();
}

function chatSpaceFromEvent_(event) {
  if (!event) return '';
  const classic = event.space && event.space.name;
  const msg = event.chat && event.chat.messagePayload && event.chat.messagePayload.space
    && event.chat.messagePayload.space.name;
  const added = event.chat && event.chat.addedToSpacePayload && event.chat.addedToSpacePayload.space
    && event.chat.addedToSpacePayload.space.name;
  return String(classic || msg || added || '').trim();
}

function chatUserNameFromEvent_(event) {
  if (!event) return '';
  const classic = event.user && event.user.name;
  const addon = event.chat && event.chat.user && event.chat.user.name;
  return String(classic || addon || '').trim();
}

function getChatBotToken_() {
  return getServiceAccountToken_('https://www.googleapis.com/auth/chat.bot');
}

/** Run once in the editor (or via webhook kind calendar_reset) to wipe Studio PMS calendar junk. */
function resetStudioPmsCalendarEvents() {
  const props = PropertiesService.getScriptProperties();
  const cal = CalendarApp.getDefaultCalendar();
  const ids = parseJsonMap_(props.getProperty('CALENDAR_EVENT_IDS'));
  let deletedById = 0;
  let missingId = 0;
  Object.keys(ids).forEach(function (key) {
    const eventId = ids[key];
    if (!eventId) return;
    try {
      const event = cal.getEventById(eventId);
      if (event) {
        event.deleteEvent();
        deletedById += 1;
      } else {
        missingId += 1;
      }
    } catch (err) {
      missingId += 1;
    }
  });

  const start = new Date();
  start.setFullYear(start.getFullYear() - 2);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setFullYear(end.getFullYear() + 5);
  end.setHours(23, 59, 59, 999);

  let deletedByScan = 0;
  const events = cal.getEvents(start, end) || [];
  events.forEach(function (event) {
    const description = String(event.getDescription() || '');
    const title = String(event.getTitle() || '');
    // Legacy PMS notes only — new invites are just the client name.
    const fromPms = description.indexOf('From Studio PMS') >= 0
      || description.indexOf('pms_marker_id:') >= 0
      || title.indexOf('Studio PMS calendar test') >= 0;
    if (!fromPms) return;
    try {
      event.deleteEvent();
      deletedByScan += 1;
    } catch (err) { /* ignore */ }
  });

  props.setProperty('CALENDAR_EVENT_IDS', JSON.stringify({}));
  const result = {
    ok: true,
    kind: 'calendar_reset',
    deletedById: deletedById,
    missingId: missingId,
    deletedByScan: deletedByScan,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function pmsEventDescription_(markerId, client) {
  return String(client || '').trim();
}

function findPmsEventByMarkerId_(cal, markerId, aroundDate) {
  const id = String(markerId || '').trim();
  if (!id || !cal) return null;
  const needle = 'pms_marker_id:' + id;
  const start = new Date(aroundDate || new Date());
  start.setMonth(start.getMonth() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(aroundDate || new Date());
  end.setMonth(end.getMonth() + 1);
  end.setHours(23, 59, 59, 999);
  try {
    const events = cal.getEvents(start, end) || [];
    for (let i = 0; i < events.length; i += 1) {
      const description = String(events[i].getDescription() || '');
      if (description.indexOf(needle) >= 0) return events[i];
    }
  } catch (err) { /* ignore */ }
  return null;
}

function clearEventReminders_(event) {
  if (!event) return;
  try {
    event.removeAllReminders();
  } catch (err) { /* ignore */ }
}

/** One-shot: strip reminders from every tracked PMS milestone invite. */
function stripPmsEventReminders() {
  const props = PropertiesService.getScriptProperties();
  const cal = CalendarApp.getDefaultCalendar();
  const ids = parseJsonMap_(props.getProperty('CALENDAR_EVENT_IDS'));
  let cleared = 0;
  let missing = 0;
  Object.keys(ids).forEach(function (key) {
    const eventId = ids[key];
    if (!eventId) return;
    try {
      const event = cal.getEventById(eventId);
      if (!event) {
        missing += 1;
        return;
      }
      clearEventReminders_(event);
      cleared += 1;
    } catch (err) {
      missing += 1;
    }
  });
  const result = { ok: true, kind: 'strip_reminders', cleared: cleared, missing: missing };
  Logger.log(JSON.stringify(result));
  return result;
}

function handleCalendarMilestone_(record) {
  const payload = record.payload || {};
  const date = String(payload.date || '').trim();
  const title = String(payload.calendar_title || record.summary || '').trim();
  const markerId = String(payload.marker_id || '').trim();
  const client = String(payload.client || '').trim();
  const action = String(payload.action || 'upsert').trim();
  const recipients = parseRecipients(record.recipients);
  if (!date || !title || recipients.length === 0) {
    return { ok: false, error: 'calendar missing date/title/recipients' };
  }
  if (!markerId) {
    return { ok: false, error: 'calendar missing marker_id (refusing undedupable create)' };
  }

  const start = parseIsoDateLocal_(date);
  if (!start) {
    return { ok: false, error: 'bad calendar date: ' + date };
  }

  const props = PropertiesService.getScriptProperties();
  const ids = parseJsonMap_(props.getProperty('CALENDAR_EVENT_IDS'));
  const key = markerId;
  let existingId = ids[key];
  const guestList = recipients.join(',');
  const description = pmsEventDescription_(markerId, client);

  try {
    const cal = CalendarApp.getDefaultCalendar();
    let event = null;
    if (existingId) {
      try { event = cal.getEventById(existingId); } catch (err) { event = null; }
    }
    if (!event) {
      event = findPmsEventByMarkerId_(cal, markerId, start);
      if (event) {
        existingId = event.getId();
        if (existingId) ids[key] = existingId;
      }
    }

    if (event) {
      event.setTitle(title);
      event.setAllDayDate(start);
      event.setDescription(description);
      clearEventReminders_(event);
      syncGuests_(event, recipients);
      props.setProperty('CALENDAR_EVENT_IDS', JSON.stringify(ids));
      return {
        ok: true,
        kind: 'calendar_milestone',
        action: 'update',
        guests: recipients,
        eventId: existingId || event.getId(),
        markerId: markerId,
      };
    }

    if (action === 'delete') {
      props.setProperty('CALENDAR_EVENT_IDS', JSON.stringify(ids));
      return { ok: true, kind: 'calendar_milestone', action: 'delete', skipped: true, markerId: markerId };
    }

    const created = cal.createAllDayEvent(title, start, {
      description: description,
      guests: guestList,
      sendInvites: true,
    });
    clearEventReminders_(created);
    const newId = created.getId();
    if (newId) ids[key] = newId;
    props.setProperty('CALENDAR_EVENT_IDS', JSON.stringify(ids));
    return {
      ok: true,
      kind: 'calendar_milestone',
      action: 'create',
      guests: recipients,
      eventId: newId,
      markerId: markerId,
    };
  } catch (err) {
    return {
      ok: false,
      kind: 'calendar_milestone',
      error: String(err && err.message ? err.message : err),
      hint: 'Web app must Execute as Me. Calendar invites go to each designer as guests (no domain-wide delegation).',
    };
  }
}

function syncGuests_(event, emails) {
  const want = {};
  (emails || []).forEach(function (e) { want[String(e).toLowerCase()] = true; });
  const guests = event.getGuestList(true) || [];
  guests.forEach(function (g) {
    const em = String(g.getEmail() || '').toLowerCase();
    if (em && !want[em]) {
      try { event.removeGuest(em); } catch (err) { /* ignore */ }
    }
  });
  (emails || []).forEach(function (email) {
    try { event.addGuest(email); } catch (err) { /* already a guest */ }
  });
}

function parseIsoDateLocal_(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function handleCalendarTodo_(record) {
  const payload = record.payload || {};
  const action = String(payload.action || 'create').trim();
  const title = String(payload.calendar_title || record.summary || '').trim();
  const todoId = String(payload.todo_id || '').trim();
  const date = String(payload.date || '').trim();
  const done = Boolean(payload.done);
  if (!title || !todoId) {
    return { ok: false, error: 'todo missing title/id' };
  }
  if (action !== 'delete' && !date) {
    return { ok: false, error: 'todo missing date' };
  }

  removeTodoCalendarLeftover_(todoId);

  const result = upsertGoogleTask_(todoId, title, date, done, action);
  return {
    ok: Boolean(result && result.ok),
    kind: 'calendar_todo',
    results: [result],
  };
}

/** Deletes leftover all-day calendar events from the old to-do fallback. */
function removeTodoCalendarLeftover_(todoId) {
  const props = PropertiesService.getScriptProperties();
  const ids = parseJsonMap_(props.getProperty('TODO_EVENT_IDS'));
  const key = 'todo:' + String(todoId);
  const existingId = ids[key];
  if (!existingId) return;
  try {
    const event = CalendarApp.getDefaultCalendar().getEventById(existingId);
    if (event) event.deleteEvent();
  } catch (err) { /* already gone */ }
  delete ids[key];
  props.setProperty('TODO_EVENT_IDS', JSON.stringify(ids));
}

function upsertGoogleTask_(todoId, title, date, done, action) {
  const props = PropertiesService.getScriptProperties();
  const ids = parseJsonMap_(props.getProperty('TODO_TASK_IDS'));
  const key = String(todoId);
  const existingId = ids[key];
  const listId = '@default';

  try {
    if (action === 'delete') {
      if (existingId) {
        try { Tasks.Tasks.remove(listId, existingId); } catch (err) { /* already gone */ }
        delete ids[key];
        props.setProperty('TODO_TASK_IDS', JSON.stringify(ids));
      }
      return { ok: true, via: 'tasks', action: 'delete', taskId: existingId || null };
    }

    const resource = {
      title: title,
      notes: 'From Studio PMS',
      status: done ? 'completed' : 'needsAction',
    };
    if (date) resource.due = date + 'T12:00:00.000Z';

    if (existingId) {
      try {
        Tasks.Tasks.patch(resource, listId, existingId);
        return { ok: true, via: 'tasks', action: 'update', taskId: existingId };
      } catch (err) {
        /* recreate below */
      }
    }

    const created = Tasks.Tasks.insert(resource, listId);
    const newId = created && created.id;
    if (newId) {
      ids[key] = newId;
      props.setProperty('TODO_TASK_IDS', JSON.stringify(ids));
    }
    return { ok: true, via: 'tasks', action: 'create', taskId: newId || null };
  } catch (err) {
    return {
      ok: false,
      via: 'tasks',
      error: String(err && err.message ? err.message : err),
      hint: 'Enable Tasks in Apps Script Services, then Run testTodoTask and allow access.',
    };
  }
}

/** Run once in the editor — Google will ask for Tasks access. Then Deploy Web app → New version. */
function testTodoTask() {
  const tomorrow = new Date();
  tomorrow.setHours(12, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const y = tomorrow.getFullYear();
  const m = ('0' + (tomorrow.getMonth() + 1)).slice(-2);
  const d = ('0' + tomorrow.getDate()).slice(-2);
  const iso = y + '-' + m + '-' + d;
  const result = handleCalendarTodo_({
    summary: 'Studio PMS to-do test',
    recipients: [Session.getActiveUser().getEmail()],
    payload: {
      action: 'create',
      todo_id: 'pms-todo-test',
      date: iso,
      done: false,
      calendar_title: 'Studio PMS to-do test',
    },
  });
  Logger.log(JSON.stringify(result));
  if (!result.ok) {
    throw new Error('To-do test failed: ' + JSON.stringify(result));
  }
}

/**
 * Run once after adding SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 * Creates a 1-minute trigger so ticking a Google Task completes the PMS to-do.
 */
function installTodoCompletionSync() {
  const probe = markTodosDoneInSupabase_([]);
  if (!probe.ok) {
    throw new Error('Could not reach Supabase: ' + JSON.stringify(probe));
  }
  const existing = ScriptApp.getProjectTriggers();
  existing.forEach(function (t) {
    if (t.getHandlerFunction() === 'syncCompletedGoogleTasks') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('syncCompletedGoogleTasks')
    .timeBased()
    .everyMinutes(1)
    .create();
  const result = syncCompletedGoogleTasks_();
  PropertiesService.getScriptProperties().setProperty('LAST_TODO_PULL', JSON.stringify(result));
  Logger.log(JSON.stringify(result));
  if (!result.ok) {
    throw new Error('Trigger installed, but first sync failed: ' + JSON.stringify(result));
  }
}

/** Time trigger — do not throw (that emails the script owner every minute). */
function syncCompletedGoogleTasks() {
  try {
    const result = syncCompletedGoogleTasks_();
    PropertiesService.getScriptProperties().setProperty('LAST_TODO_PULL', JSON.stringify(result));
  } catch (err) {
    const bad = { ok: false, error: String(err && err.message ? err.message : err) };
    PropertiesService.getScriptProperties().setProperty('LAST_TODO_PULL', JSON.stringify(bad));
  }
}

function syncCompletedGoogleTasks_() {
  const completedIds = listCompletedPmsTodoIds_();
  if (!completedIds.length) {
    return { ok: true, completed: 0, changed: 0 };
  }
  const marked = markTodosDoneInSupabase_(completedIds);
  return {
    ok: Boolean(marked && marked.ok),
    completed: completedIds.length,
    ids: completedIds,
    supabase: marked,
    changed: marked && marked.changed,
    error: marked && marked.error,
  };
}

function listCompletedPmsTodoIds_() {
  const props = PropertiesService.getScriptProperties();
  const ids = parseJsonMap_(props.getProperty('TODO_TASK_IDS'));
  const todoByTask = {};
  Object.keys(ids).forEach(function (todoId) {
    const taskId = ids[todoId];
    if (taskId) todoByTask[taskId] = todoId;
  });
  const mapped = Object.keys(todoByTask);
  if (!mapped.length) return [];

  const seen = {};
  const completed = [];
  let pageToken = '';
  do {
    const params = {
      showCompleted: true,
      showHidden: true,
      maxResults: 100
    };
    if (pageToken) params.pageToken = pageToken;
    const resp = Tasks.Tasks.list('@default', params);
    (resp.items || []).forEach(function (task) {
      if (!task || !task.id) return;
      seen[task.id] = true;
      const todoId = todoByTask[task.id];
      if (todoId && task.status === 'completed') completed.push(todoId);
    });
    pageToken = resp.nextPageToken || '';
  } while (pageToken);

  mapped.forEach(function (taskId) {
    if (seen[taskId]) return;
    try {
      const task = Tasks.Tasks.get('@default', taskId);
      if (task && task.status === 'completed' && todoByTask[task.id]) {
        completed.push(todoByTask[task.id]);
      }
    } catch (err) { /* task gone */ }
  });

  const unique = {};
  completed.forEach(function (id) { unique[id] = true; });
  return Object.keys(unique);
}

function markTodosDoneInSupabase_(todoIds) {
  const props = PropertiesService.getScriptProperties();
  const base = String(props.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  const key = String(props.getProperty('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
  if (!base || !key) {
    return {
      ok: false,
      error: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
      hint: 'Project Settings → API. URL + service_role go in Apps Script properties only.',
    };
  }
  const resp = UrlFetchApp.fetch(base + '/rest/v1/rpc/mark_studio_todos_done', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
    },
    payload: JSON.stringify({ p_todo_ids: todoIds }),
    muteHttpExceptions: true,
  });
  const raw = resp.getContentText() || '';
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch (err) {
    body = { ok: false, error: raw.slice(0, 240) };
  }
  if (resp.getResponseCode() >= 400) {
    return {
      ok: false,
      error: (body && body.message) || (body && body.error) || raw.slice(0, 240),
      hint: 'Run supabase/todo-task-sync.sql in the SQL Editor, then try again.',
    };
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  return { ok: true, changed: 0, raw: body };
}

/** Run in editor — shows the last Google Tasks → PMS sync result. */
function showLastTodoPull() {
  const raw = PropertiesService.getScriptProperties().getProperty('LAST_TODO_PULL') || '(none yet)';
  Logger.log(raw);
  throw new Error(raw);
}

/** Impersonate a Workspace user — only if domain-wide delegation is set up. Unused by default. */
function getCalendarToken_(email) {
  return getServiceAccountToken_(
    'https://www.googleapis.com/auth/calendar',
    String(email || '').trim().toLowerCase()
  );
}

function getServiceAccountToken_(scope, subject) {
  const raw = PropertiesService.getScriptProperties().getProperty('CHAT_SERVICE_ACCOUNT');
  if (!raw) {
    throw new Error('Add script property CHAT_SERVICE_ACCOUNT: paste the whole service account JSON key.');
  }
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const b64urlJson = function (obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  };
  const claim = {
    iss: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: scope
  };
  if (subject) claim.sub = subject;
  const toSign = b64urlJson({ alg: 'RS256', typ: 'JWT' }) + '.' + b64urlJson(claim);
  const sig = Utilities.computeRsaSha256Signature(toSign, sa.private_key);
  const jwt = toSign + '.' + Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
  const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  const body = JSON.parse(resp.getContentText() || '{}');
  if (!body.access_token) {
    throw new Error('Could not get token (' + scope + '). ' + resp.getContentText());
  }
  return body.access_token;
}

function chatApi_(method, url, token, payload) {
  const options = {
    method: String(method || 'get').toUpperCase(),
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  const resp = UrlFetchApp.fetch(url, options);
  const raw = resp.getContentText() || '';
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw new Error('API ' + resp.getResponseCode() + ': ' + raw.slice(0, 180));
  }
  if (resp.getResponseCode() >= 400) {
    throw new Error(body.error && body.error.message ? body.error.message : raw);
  }
  return body;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
