const GITHUB_REPO = 'jbsbackgammon/member';
const GITHUB_BRANCH = 'main';
const FRONTEND_ORIGIN_DEFAULT = 'https://jbsbackgammon.github.io';

function json(data, status = 200, origin = FRONTEND_ORIGIN_DEFAULT) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store'
    }
  });
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function safeFilename(value) {
  const filename = String(value || '').trim();
  if (
    !filename ||
    filename.length > 220 ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    !filename.toLowerCase().endsWith('.png')
  ) {
    return '';
  }
  return filename;
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'jbs-headshot-member-writer'
  };
}

async function exchangeCode(env, code) {
  const body = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    code
  });

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'GitHub token exchange failed');
  }
  return data;
}

async function refreshGithubToken(env, sessionData) {
  if (!sessionData.refreshToken) return sessionData;

  const body = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: sessionData.refreshToken
  });

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'GitHub token refresh failed');
  }

  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || sessionData.refreshToken,
    accessExpiresAt: data.expires_in ? now + data.expires_in * 1000 : 0,
    refreshExpiresAt: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : sessionData.refreshExpiresAt || 0
  };
}

async function getSession(env, sessionId, { refresh = true } = {}) {
  if (!sessionId) return null;

  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    refresh &&
    data.accessExpiresAt &&
    data.accessExpiresAt - Date.now() < 5 * 60 * 1000
  ) {
    try {
      data = await refreshGithubToken(env, data);
      await env.SESSIONS.put(
        `session:${sessionId}`,
        JSON.stringify(data),
        { expirationTtl: 60 * 60 * 24 * 190 }
      );
    } catch {
      await env.SESSIONS.delete(`session:${sessionId}`);
      return null;
    }
  }

  return data;
}

function authResultHtml(origin, payload) {
  const safeOrigin = JSON.stringify(origin);
  const safePayload = JSON.stringify(payload).replace(/</g, '\\u003c');

  return new Response(`<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>GitHub認可</title></head>
<body>
<script>
  if (window.opener) {
    window.opener.postMessage(${safePayload}, ${safeOrigin});
  }
  window.close();
</script>
認可処理が完了しました。この画面は閉じてください。
</body>
</html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function handleAuthStart(request, env) {
  const state = randomToken();
  await env.SESSIONS.put(
    `state:${state}`,
    JSON.stringify({ createdAt: Date.now() }),
    { expirationTtl: 600 }
  );

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'offline_access');

  return Response.redirect(url.toString(), 302);
}

async function handleAuthCallback(request, env) {
  const origin = env.FRONTEND_ORIGIN || FRONTEND_ORIGIN_DEFAULT;
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';

  if (error) {
    return authResultHtml(origin, {
      type: 'headshot-github-auth',
      ok: false,
      message: 'GitHub認可がキャンセルされました。'
    });
  }

  const stateKey = `state:${state}`;
  const stateData = state ? await env.SESSIONS.get(stateKey) : null;
  if (!code || !stateData) {
    return authResultHtml(origin, {
      type: 'headshot-github-auth',
      ok: false,
      message: 'GitHub認可情報を確認できませんでした。'
    });
  }

  await env.SESSIONS.delete(stateKey);

  try {
    const token = await exchangeCode(env, code);
    const now = Date.now();
    const sessionId = randomToken();

    const sessionData = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || '',
      accessExpiresAt: token.expires_in ? now + token.expires_in * 1000 : 0,
      refreshExpiresAt: token.refresh_token_expires_in
        ? now + token.refresh_token_expires_in * 1000
        : 0
    };

    await env.SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify(sessionData),
      { expirationTtl: 60 * 60 * 24 * 190 }
    );

    return authResultHtml(origin, {
      type: 'headshot-github-auth',
      ok: true,
      session: sessionId
    });
  } catch (error) {
    return authResultHtml(origin, {
      type: 'headshot-github-auth',
      ok: false,
      message: error.message || 'GitHub認可に失敗しました。'
    });
  }
}

async function handleStatus(request, env) {
  const origin = env.FRONTEND_ORIGIN || FRONTEND_ORIGIN_DEFAULT;
  const session = await getSession(env, bearerToken(request));
  if (!session) return json({ ok: false }, 401, origin);
  return json({ ok: true }, 200, origin);
}

async function handlePublish(request, env) {
  const origin = env.FRONTEND_ORIGIN || FRONTEND_ORIGIN_DEFAULT;
  const sessionId = bearerToken(request);
  const session = await getSession(env, sessionId);

  if (!session) {
    return json({ ok: false, message: 'GitHubの再認可が必要です。' }, 401, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: '送信データが正しくありません。' }, 400, origin);
  }

  const filename = safeFilename(body.filename);
  const contentBase64 = String(body.contentBase64 || '');
  const overwrite = body.overwrite === true;

  if (!filename) {
    return json({ ok: false, message: 'ファイル名が正しくありません。' }, 400, origin);
  }

  if (!contentBase64 || contentBase64.length > 10_000_000) {
    return json({ ok: false, message: 'PNGデータが正しくありません。' }, 400, origin);
  }

  const repoPath = `images/${filename}`;
  const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
  const contentUrl =
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodedPath}`;

  let existingSha = '';

  const existing = await fetch(
    `${contentUrl}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
    { headers: githubHeaders(session.accessToken) }
  );

  if (existing.status === 200) {
    const existingData = await existing.json();
    existingSha = existingData.sha || '';

    if (!overwrite) {
      return json({
        ok: false,
        exists: true,
        filename
      }, 409, origin);
    }
  } else if (existing.status !== 404) {
    const detail = await existing.json().catch(() => ({}));
    return json({
      ok: false,
      message: detail.message || `既存ファイル確認に失敗しました (${existing.status})`
    }, existing.status, origin);
  }

  const payload = {
    message: existingSha
      ? `Update member headshot: ${filename}`
      : `Add member headshot: ${filename}`,
    content: contentBase64,
    branch: GITHUB_BRANCH
  };

  if (existingSha) payload.sha = existingSha;

  const write = await fetch(contentUrl, {
    method: 'PUT',
    headers: {
      ...githubHeaders(session.accessToken),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await write.json().catch(() => ({}));

  if (!write.ok) {
    return json({
      ok: false,
      message: data.message || `GitHubへの保存に失敗しました (${write.status})`
    }, write.status, origin);
  }

  return json({
    ok: true,
    filename,
    path: repoPath,
    commitSha: data.commit?.sha || ''
  }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = env.FRONTEND_ORIGIN || FRONTEND_ORIGIN_DEFAULT;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (url.pathname === '/auth/start' && request.method === 'GET') {
      return handleAuthStart(request, env);
    }

    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      return handleAuthCallback(request, env);
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      return handleStatus(request, env);
    }

    if (url.pathname === '/publish' && request.method === 'POST') {
      return handlePublish(request, env);
    }

    return json({ ok: false, message: 'Not found' }, 404, origin);
  }
};
