/**
 * Extended Whānau PMS — Google Chat app
 *
 * DMs people assigned to a job when the PMS queues a notification.
 * Also replies if someone messages the bot with "test".
 *
 * Script properties:
 *   WEBHOOK_SECRET         — same as ?secret= on the web app URL
 *   CHAT_SERVICE_ACCOUNT   — full JSON key of a service account in the Chat Cloud project
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

    const record = body.record || body;
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

    const result = { ok: failed.length === 0 && sent.length > 0, sent: sent, failed: failed };
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
  return ContentService.createTextOutput('PMS Chat app is deployed. Use POST from Supabase.');
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
  const raw = PropertiesService.getScriptProperties().getProperty('CHAT_SERVICE_ACCOUNT');
  if (!raw) {
    throw new Error('Add script property CHAT_SERVICE_ACCOUNT: paste the whole service account JSON key.');
  }
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const b64urlJson = function (obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  };
  const toSign = b64urlJson({ alg: 'RS256', typ: 'JWT' }) + '.' + b64urlJson({
    iss: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/chat.bot'
  });
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
    throw new Error('Could not get Chat bot token. ' + resp.getContentText());
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
    throw new Error('Chat API ' + resp.getResponseCode() + ': ' + raw.slice(0, 180));
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
