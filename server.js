// server.js — Flashka Kiosk (Express + QR + daily stats)
// Folder structure expected:
// C:\Users\User\Desktop\flashka\kiosk\
//   server.js
//   package.json
//   .env           (optional; see notes at bottom)
//   \public\flashka_logo.png
//
// Dependencies in package.json: express, qrcode, dotenv, pg

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3030;

// Public base URL for the kiosk itself. On Render, you can omit this;
// the server will derive it from the incoming request host automatically.
const ENV_BASE_URL = process.env.BASE_URL || null;

// Where players should be sent on first scan. {token} will be replaced.
// Defaults to your Render game URL if not provided.
const GAME_URL_TEMPLATE =
  process.env.GAME_URL_TEMPLATE || 'https://flashka.onrender.com/?token={token}';

// Optional: protect /kiosk/stats, /kiosk/stats.json, /kiosk/stats.csv
const ADMIN_KEY = process.env.ADMIN_KEY || null;

// Optional: Postgres URL. If set, data persists in Postgres; otherwise JSON files.
const DATABASE_URL = process.env.DATABASE_URL || null;

// ---------- STATIC ASSETS ----------
const PUBLIC_DIR = path.join(__dirname, 'public'); // NOTE: kiosk/public
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// ---------- TIME / HELPERS ----------
const BRIS_TZ = 'Australia/Brisbane';

function dayKeyBrisbane(d = new Date()) {
  // "YYYY-MM-DD"
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BRIS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function buildBaseUrl(req) {
  return ENV_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function playUrlFor(req, token) {
  return `${buildBaseUrl(req)}/kiosk/play/${token}`;
}

async function makeQrDataUrl(text) {
  // NOTE: Option A is CSS-only; leaving QR bitmap size unchanged (scale: 8)
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    scale: 8,
    margin: 1
  });
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY) return null;
  if ((req.query.key || '') === ADMIN_KEY) return null;
  res.status(401).send('Unauthorized. Append ?key=YOUR_ADMIN_KEY to the URL.');
  return 'blocked';
}

// ---------- STORAGE LAYER (Postgres or JSON) ----------
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
}
function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}
function saveJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const usingPG = !!DATABASE_URL;
let store;

// ---- File-backed store (JSON) ----
function fileStore() {
  ensureDataDir();
  let state = loadJson(STATE_FILE, { currentToken: 1000, consumed: {} });
  let metrics = loadJson(METRICS_FILE, { tz: BRIS_TZ, days: {} });

  function saveState() { saveJson(STATE_FILE, state); }
  function saveMetrics() { saveJson(METRICS_FILE, metrics); }

  return {
    async init() {},
    async getCurrentToken() { return state.currentToken; },
    async setCurrentToken(v) { state.currentToken = v; saveState(); },
    async isConsumed(token) { return !!state.consumed[String(token)]; },
    async consumeToken(token) {
      state.consumed[String(token)] = new Date().toISOString();
      saveState();
    },
    async getConsumedAt(token) {
      return state.consumed[String(token)] || null;
    },
    async bumpMetric(kind) {
      const day = dayKeyBrisbane();
      if (!metrics.days[day]) {
        metrics.days[day] = { qr_scans: 0, unique_scans: 0, redirects: 0, revisits: 0 };
      }
      metrics.days[day][kind] = (metrics.days[day][kind] || 0) + 1;
      saveMetrics();
    },
    async getMetrics() { return metrics; },
    async getMetricsRows() {
      const days = Object.keys(metrics.days).sort();
      return days.map(d => ({ day: d, ...metrics.days[d] }));
    }
  };
}

// ---- Postgres-backed store ----
function pgStore() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    // If you set PGSSLMODE=require in env, most providers will negotiate SSL automatically.
    max: 5
  });

  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kiosk_state (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS consumed_tokens (
          token INTEGER PRIMARY KEY,
          consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS metrics_days (
          day DATE PRIMARY KEY,
          qr_scans INTEGER NOT NULL DEFAULT 0,
          unique_scans INTEGER NOT NULL DEFAULT 0,
          redirects INTEGER NOT NULL DEFAULT 0,
          revisits INTEGER NOT NULL DEFAULT 0
        );
      `);
      // seed state if missing
      const r = await pool.query(`SELECT 1 FROM kiosk_state WHERE key='state'`);
      if (!r.rowCount) {
        await pool.query(
          `INSERT INTO kiosk_state(key, value) VALUES ('state', $1)`,
          [{ currentToken: 1000 }]
        );
      }
    },
    async getCurrentToken() {
      const r = await pool.query(
        `SELECT (value->>'currentToken')::int AS t FROM kiosk_state WHERE key='state'`
      );
      return r.rows[0]?.t ?? 1000;
    },
    async setCurrentToken(v) {
      await pool.query(
        `INSERT INTO kiosk_state(key, value) VALUES ('state', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [{ currentToken: v }]
      );
    },
    async isConsumed(token) {
      const r = await pool.query(`SELECT 1 FROM consumed_tokens WHERE token=$1`, [token]);
      return r.rowCount > 0;
    },
    async consumeToken(token) {
      await pool.query(
        `INSERT INTO consumed_tokens(token) VALUES ($1) ON CONFLICT DO NOTHING`,
        [token]
      );
    },
    async getConsumedAt(token) {
      const r = await pool.query(
        `SELECT consumed_at FROM consumed_tokens WHERE token=$1`,
        [token]
      );
      return r.rowCount ? r.rows[0].consumed_at.toISOString() : null;
    },
    async bumpMetric(kind) {
      const day = dayKeyBrisbane();
      const cols = { qr_scans: 0, unique_scans: 0, redirects: 0, revisits: 0 };
      cols[kind] = 1;
      await pool.query(
        `INSERT INTO metrics_days(day, qr_scans, unique_scans, redirects, revisits)
         VALUES ($1::date, $2, $3, $4, $5)
         ON CONFLICT (day) DO UPDATE SET
           qr_scans    = metrics_days.qr_scans    + EXCLUDED.qr_scans,
           unique_scans= metrics_days.unique_scans+ EXCLUDED.unique_scans,
           redirects   = metrics_days.redirects   + EXCLUDED.redirects,
           revisits    = metrics_days.revisits    + EXCLUDED.revisits`,
        [day, cols.qr_scans, cols.unique_scans, cols.redirects, cols.revisits]
      );
    },
    async getMetrics() {
      const r = await pool.query(
        `SELECT day, qr_scans, unique_scans, redirects, revisits
         FROM metrics_days ORDER BY day`
      );
      const out = { tz: BRIS_TZ, days: {} };
      for (const row of r.rows) {
        const d = row.day.toISOString().slice(0, 10);
        out.days[d] = {
          qr_scans: Number(row.qr_scans) || 0,
          unique_scans: Number(row.unique_scans) || 0,
          redirects: Number(row.redirects) || 0,
          revisits: Number(row.revisits) || 0
        };
      }
      return out;
    },
    async getMetricsRows() {
      const r = await pool.query(
        `SELECT day, qr_scans, unique_scans, redirects, revisits
         FROM metrics_days ORDER BY day`
      );
      return r.rows.map(row => ({
        day: row.day.toISOString().slice(0, 10),
        qr_scans: Number(row.qr_scans) || 0,
        unique_scans: Number(row.unique_scans) || 0,
        redirects: Number(row.redirects) || 0,
        revisits: Number(row.revisits) || 0
      }));
    }
  };
}

// Pick store implementation
store = usingPG ? pgStore() : fileStore();

// ---------- VIEWS ----------
app.get('/kiosk', async (req, res) => {
  const token = await store.getCurrentToken();
  const playUrl = playUrlFor(req, token);
  const qrDataUrl = await makeQrDataUrl(playUrl);

  // ===== Option A (CSS-only) — smaller QR + tighter layout for iPhone 6 =====
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Flashka Kiosk</title>
<style>
 body{font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa}
 .wrap{width:min(360px,96vw);text-align:center;padding:16px;background:#fff;border:1px solid #eee;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,0.06)}
 img.logo{max-width:320px;width:100%;height:auto;object-fit:contain;margin-bottom:10px}
 h1{font-size:20px;margin:6px 0 6px}
 .sub{font-size:12px;color:#555;margin-bottom:12px}
 .qr{border:1px solid #e5e5e5;padding:10px;border-radius:12px}
 .token{color:#333;margin-top:6px;font-size:13px}
</style>
</head><body>
 <div class="wrap">
   <img class="logo" src="/flashka_logo.png" alt="Flashka"/>
   <h1>Scan to play Flashka</h1>
   <div class="sub">Each scan generates a fresh, single-use game link.</div>
   <div class="qr">
     <img id="qrImg" src="${qrDataUrl}" alt="QR" style="width:85%;max-width:260px;height:auto"/>
     <div id="tokenInfo" class="token">Token: <strong>${token}</strong></div>
   </div>
 </div>
<script>
  const qrImg = document.getElementById('qrImg');
  const tokenInfo = document.getElementById('tokenInfo');
  let lastPlayUrl = null;
  async function tick(){
    try{
      const r = await fetch('/kiosk/api/current');
      const d = await r.json();
      if (d.playUrl !== lastPlayUrl) {
        lastPlayUrl = d.playUrl;
        qrImg.src = d.qrDataUrl;
        tokenInfo.innerHTML = 'Token: <strong>' + d.token + '</strong>';
      }
    }catch(e){}
    setTimeout(tick, 1200);
  }
  tick();
</script>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/kiosk/api/current', async (req, res) => {
  const token = await store.getCurrentToken();
  const playUrl = playUrlFor(req, token);
  res.json({
    token,
    playUrl,
    qrDataUrl: await makeQrDataUrl(playUrl)
  });
});

// Player landing: count stats, consume, advance, redirect to game (single-use)
app.get('/kiosk/play/:token', async (req, res) => {
  const token = parseInt(req.params.token, 10);
  if (!Number.isInteger(token)) return res.status(400).send('Invalid token');

  // Count every landing as a scan
  await store.bumpMetric('qr_scans');

  const alreadyUsed = await store.isConsumed(token);
  if (!alreadyUsed) {
    await store.consumeToken(token);
    await store.bumpMetric('unique_scans');

    const current = await store.getCurrentToken();
    if (token === current) {
      await store.setCurrentToken(current + 1); // advance kiosk
    }

    // First-time: redirect to your game
    await store.bumpMetric('redirects');
    const target = GAME_URL_TEMPLATE.replace('{token}', String(token));
    return res.redirect(302, target);
  }

  // Re-use → expired
  await store.bumpMetric('revisits');
  const consumedAt = (store.getConsumedAt ? await store.getConsumedAt(token) : null) || 'earlier';
  res
    .status(410)
    .send(
      `<h1>Link expired</h1><p>This game link was already used at <b>${consumedAt}</b>.</p>
       <p>Please scan a fresh QR at the kiosk.</p>`
    );
});

// ---------- STATS ----------
app.get('/kiosk/stats', async (req, res) => {
  if (requireAdmin(req, res)) return;
  const rows = await store.getMetricsRows();
  const body =
    rows.map(r => `<tr>
      <td>${r.day}</td>
      <td style="text-align:right">${r.qr_scans||0}</td>
      <td style="text-align:right">${r.unique_scans||0}</td>
      <td style="text-align:right">${r.redirects||0}</td>
      <td style="text-align:right">${r.revisits||0}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#777">No data yet</td></tr>';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Flashka – Kiosk Stats</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;padding:24px;background:#fafafa}
    h1{margin:0 0 8px}
    .sub{color:#555;margin:0 0 16px}
    table{width:100%;max-width:680px;border-collapse:collapse;background:#fff;border:1px solid #eee;border-radius:12px;overflow:hidden}
    th,td{padding:10px;border-bottom:1px solid #f0f0f0}
    th{background:#f7f7f7;text-align:left}
    tr:last-child td{border-bottom:none}
    .actions a{margin-right:10px}
  </style></head><body>
  <h1>Flashka – Kiosk Stats</h1>
  <div class="sub">Timezone: ${BRIS_TZ}</div>
  <div class="actions">
    <a href="/kiosk/stats.json${ADMIN_KEY ? `?key=${ADMIN_KEY}` : ''}">JSON</a>
    <a href="/kiosk/stats.csv${ADMIN_KEY ? `?key=${ADMIN_KEY}` : ''}">CSV</a>
  </div>
  <table>
    <thead><tr>
      <th>Date (YYYY-MM-DD)</th>
      <th style="text-align:right">QR scans</th>
      <th style="text-align:right">Unique scans</th>
      <th style="text-align:right">Redirects</th>
      <th style="text-align:right">Revisits</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
</body></html>`);
});

app.get('/kiosk/stats.json', async (req, res) => {
  if (requireAdmin(req, res)) return;
  const metrics = await store.getMetrics();
  res.json(metrics);
});

app.get('/kiosk/stats.csv', async (req, res) => {
  if (requireAdmin(req, res)) return;
  const rows = await store.getMetricsRows();
  let csv = 'date,qr_scans,unique_scans,redirects,revisits\n';
  for (const r of rows) {
    csv += `${r.day},${r.qr_scans||0},${r.unique_scans||0},${r.redirects||0},${r.revisits||0}\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="kiosk-stats.csv"');
  res.send(csv);
});

// Convenience: root → kiosk
app.get('/', (req, res) => res.redirect('/kiosk'));

// ---------- BOOT ----------
(async () => {
  store = usingPG ? pgStore() : fileStore();
  if (store.init) await store.init();
  app.listen(PORT, () => {
    console.log(`Flashka kiosk running on port ${PORT}`);
  });
})();
