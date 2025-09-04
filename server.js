// server.js — Static QR for kiosk + daily scan tracking (Brisbane time)

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3030;
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const DATABASE_URL = process.env.DATABASE_URL || null;

// Always redirect here after counting scans
const GAME_URL = 'https://flashka.onrender.com';

// ---------- STATIC ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// ---------- TIMEZONE / HELPERS ----------
const BRIS_TZ = 'Australia/Brisbane';
function dayKeyBrisbane(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BRIS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
function buildBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}
async function makeQrPngBuffer(text, opts = {}) {
  return QRCode.toBuffer(text, {
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: 10, // crisp for printing
    ...opts,
  });
}
function requireAdmin(req, res) {
  if (!ADMIN_KEY) return null;
  if ((req.query.key || '') === ADMIN_KEY) return null;
  res.status(401).send('Unauthorized. Append ?key=YOUR_ADMIN_KEY to the URL.');
  return 'blocked';
}

// ---------- STORAGE (PG or JSON) ----------
const DATA_DIR = path.join(__dirname, 'data');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
}
function loadJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function fileStore() {
  ensureDataDir();
  let metrics = loadJson(METRICS_FILE, { tz: BRIS_TZ, days: {} });
  const saveMetrics = () => saveJson(METRICS_FILE, metrics);

  return {
    async init() {},
    async bumpScan() {
      const day = dayKeyBrisbane();
      if (!metrics.days[day]) metrics.days[day] = { qr_scans: 0, redirects: 0 };
      metrics.days[day].qr_scans++;
      saveMetrics();
    },
    async bumpRedirect() {
      const day = dayKeyBrisbane();
      if (!metrics.days[day]) metrics.days[day] = { qr_scans: 0, redirects: 0 };
      metrics.days[day].redirects++;
      saveMetrics();
    },
    async getMetrics() {
      return metrics;
    },
    async getMetricsRows() {
      const days = Object.keys(metrics.days).sort();
      return days.map((d) => ({ day: d, ...metrics.days[d] }));
    },
  };
}

function pgStore() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS metrics_days (
          day DATE PRIMARY KEY,
          qr_scans INTEGER NOT NULL DEFAULT 0,
          redirects INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
    async bumpScan() {
      const day = dayKeyBrisbane();
      await pool.query(
        `INSERT INTO metrics_days(day, qr_scans, redirects)
         VALUES ($1::date, 1, 0)
         ON CONFLICT (day) DO UPDATE SET
           qr_scans = metrics_days.qr_scans + 1`,
        [day],
      );
    },
    async bumpRedirect() {
      const day = dayKeyBrisbane();
      await pool.query(
        `INSERT INTO metrics_days(day, qr_scans, redirects)
         VALUES ($1::date, 0, 1)
         ON CONFLICT (day) DO UPDATE SET
           redirects = metrics_days.redirects + 1`,
        [day],
      );
    },
    async getMetrics() {
      const r = await pool.query(
        `SELECT day, qr_scans, redirects FROM metrics_days ORDER BY day`,
      );
      const out = { tz: BRIS_TZ, days: {} };
      for (const row of r.rows) {
        const d = (row.day instanceof Date ? row.day : new Date(row.day))
          .toISOString()
          .slice(0, 10);
        out.days[d] = {
          qr_scans: Number(row.qr_scans) || 0,
          redirects: Number(row.redirects) || 0,
        };
      }
      return out;
    },
    async getMetricsRows() {
      const r = await pool.query(
        `SELECT day, qr_scans, redirects FROM metrics_days ORDER BY day`,
      );
      return r.rows.map((row) => {
        const d = (row.day instanceof Date ? row.day : new Date(row.day))
          .toISOString()
          .slice(0, 10);
        return {
          day: d,
          qr_scans: Number(row.qr_scans) || 0,
          redirects: Number(row.redirects) || 0,
        };
      });
    },
  };
}

const store = DATABASE_URL ? pgStore() : fileStore();

// ---------- KIOSK POSTER ----------
app.get('/kiosk', async (req, res) => {
  const scanUrl = `${buildBaseUrl(req)}/kiosk/scan`;
  const dataUrl = await QRCode.toDataURL(scanUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: 10,
  });

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Flashka – Scan to Play</title>
<style>
  :root{--card-w:min(560px,94vw)}
  *{box-sizing:border-box}
  body{margin:0;background:#f6f6f6;color:#111;font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .wrap{width:var(--card-w);background:#fff;border:1px solid #eee;border-radius:20px;box-shadow:0 10px 36px rgba(0,0,0,.08);padding:18px 18px 22px;text-align:center}
  .logo{max-width:460px;width:100%;height:auto;object-fit:contain;display:block;margin:6px auto 8px}
  .qrBox{display:inline-block;border:1px solid #e7e7e7;border-radius:14px;padding:14px;background:#fff;margin:2px auto 8px}
  .qrBox img{width:min(320px,72vw);height:auto;display:block}
  .lines{margin-top:6px;line-height:1.35}
  .lines .big{font-size:22px;font-weight:700;margin:6px 0 2px}
  .lines .mid{font-size:16px;margin:2px 0}
  .lines .small{font-size:14px;color:#444;margin:2px 0}
  .meta{margin-top:8px;font-size:12px;color:#666}
  @media print {
    body{background:#fff}
    .wrap{box-shadow:none;border:none}
    .meta{display:none}
  }
</style>
</head><body>
  <div class="wrap">
    <img class="logo" src="/flashka_logo.png" alt="Flashka"/>
    <div class="qrBox">
      <img src="${dataUrl}" alt="Scan to play"/>
    </div>
    <div class="lines">
      <div class="big">win a choccy with your coffee</div>
      <div class="mid">1 scan per order</div>
      <div class="small">free to play</div>
    </div>
    <div class="meta">
      <a href="/kiosk/qr.png" target="_blank" rel="noopener">Open QR as PNG</a>
    </div>
  </div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Direct PNG for printing
app.get('/kiosk/qr.png', async (req, res) => {
  const scanUrl = `${buildBaseUrl(req)}/kiosk/scan`;
  const buf = await makeQrPngBuffer(scanUrl);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', 'inline; filename="kiosk-qr.png"');
  res.send(buf);
});

// ---------- SCAN HANDLER (counts -> redirect) ----------
app.get('/kiosk/scan', async (req, res) => {
  await store.bumpScan();
  await store.bumpRedirect();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.redirect(302, GAME_URL);
});

// ---------- STATS ----------
app.get('/kiosk/stats', async (req, res) => {
  if (requireAdmin(req, res)) return;
  const rows = await store.getMetricsRows();
  const body = rows.length
    ? rows.map(r => `<tr>
        <td>${r.day}</td>
        <td style="text-align:right">${r.qr_scans || 0}</td>
        <td style="text-align:right">${r.redirects || 0}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" style="text-align:center;color:#777">No data yet</td></tr>';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><title>Stats</title></head><body>
  <h1>Flashka – Kiosk Stats</h1>
  <table border="1" cellpadding="5"><tr><th>D
