/**
 * Supabase → Apps Script bridge.
 * Apps Script /exec returns 302; fetch must re-POST to the redirect URL.
 * Set APPS_SCRIPT_WEBHOOK_URL to the web app URL including ?secret=...
 */
async function postAppsScript(target, body) {
  let res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    redirect: 'manual',
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (location) {
      res = await fetch(location, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    }
  }

  return res;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'POST only' };
  }

  const target = process.env.APPS_SCRIPT_WEBHOOK_URL;
  if (!target) {
    return { statusCode: 500, body: 'Missing APPS_SCRIPT_WEBHOOK_URL' };
  }

  const body = event.body || '{}';

  try {
    const res = await postAppsScript(target, body);
    const text = await res.text();
    const ok = res.status >= 200 && res.status < 300;
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
