/**
 * Supabase → Apps Script bridge.
 * pg_net does not follow Google’s 302 redirect, so Chat never runs.
 * Point the database webhook here after setting APPS_SCRIPT_WEBHOOK_URL
 * (the Apps Script web app URL including ?secret=...).
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'POST only' };
  }
  const target = process.env.APPS_SCRIPT_WEBHOOK_URL;
  if (!target) {
    return { statusCode: 500, body: 'Missing APPS_SCRIPT_WEBHOOK_URL' };
  }
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: event.body || '{}',
      redirect: 'follow',
    });
    const text = await res.text();
    return { statusCode: res.ok ? 200 : 502, body: text.slice(0, 2000) };
  } catch (err) {
    return { statusCode: 502, body: String(err && err.message ? err.message : err) };
  }
};
