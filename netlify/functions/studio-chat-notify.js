/**
 * Supabase → Apps Script bridge.
 * Secret goes in the JSON body (Google drops ?secret= on redirect).
 * APPS_SCRIPT_WEBHOOK_URL may include ?secret=... or use APPS_SCRIPT_WEBHOOK_SECRET.
 */
function splitTarget(raw) {
  const url = new URL(raw);
  const secret = url.searchParams.get('secret') || process.env.APPS_SCRIPT_WEBHOOK_SECRET || '';
  url.searchParams.delete('secret');
  return { target: url.toString(), secret };
}

async function postAppsScript(target, body, secret) {
  let payload = body;
  try {
    const parsed = JSON.parse(body || '{}');
    if (secret) parsed.webhook_secret = secret;
    payload = JSON.stringify(parsed);
  } catch (err) {
    payload = JSON.stringify({ webhook_secret: secret, record: { summary: body, recipients: [] } });
  }

  let res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    redirect: 'manual',
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (location) {
      res = await fetch(location, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
    }
  }

  return res;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'POST only' };
  }

  const raw = process.env.APPS_SCRIPT_WEBHOOK_URL;
  if (!raw) {
    return { statusCode: 500, body: 'Missing APPS_SCRIPT_WEBHOOK_URL' };
  }

  const { target, secret } = splitTarget(raw);
  const body = event.body || '{}';

  try {
    const res = await postAppsScript(target, body, secret);
    const text = await res.text();
    const ok = res.status >= 200 && res.status < 300 && text.indexOf('"ok":false') === -1;
    return {
      statusCode: ok ? 200 : 502,
      body: text.slice(0, 2000) || ('HTTP ' + res.status),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: String(err && err.message ? err.message : err),
    };
  }
};
