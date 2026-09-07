require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GA4_PROPERTY = 'properties/486245473';
const GSC_SITE = 'sc-domain:pennpain.com';
const WC_PROFILE = '';
const SHEET_ID = '';
const SHEET_TAB = 'dashboard_data';
const DASH_COOKIE = 'penn-pain-dashboard';
const REVIEW_COOKIE = 'pp_reviewer';

// Sheet columns — injected by generator
const SHEET_COLUMNS = '[]';
const QUALIFIED_LABEL = 'NP Appointments';

// ── Supabase ───────────────────────────────────────────────────────────────

// ── Google auth (service account) ─────────────────────────────────────────
const gauth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (() => {
      const envKey = process.env.GOOGLE_PRIVATE_KEY;
      if (envKey) return envKey.replace(/\\n/g, '\n');
      try { return require('fs').readFileSync(require('path').join(__dirname, 'private-key.pem'), 'utf8'); } catch(e) {}
      return '';
    })()
  },
  scopes: [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly'
  ]
});

async function getGAToken() {
  const client = await gauth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

// ── Session helpers ────────────────────────────────────────────────────────
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000
};

function signSession(data) {
  return jwt.sign(data, process.env.SESSION_SECRET || 'penn-pain-secret', { expiresIn: '7d' });
}

function readSession(req) {
  try {
    const token = req.cookies?.[REVIEW_COOKIE];
    if (!token) return null;
    return jwt.verify(token, process.env.SESSION_SECRET || 'penn-pain-secret');
  } catch { return null; }
}

// ── GA4 proxy ──────────────────────────────────────────────────────────────
app.post('/api/ga4', async (req, res) => {
  try {
    const token = await getGAToken();
    const response = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
      req.body, { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── GSC proxy ──────────────────────────────────────────────────────────────
app.post('/api/gsc', async (req, res) => {
  try {
    const token = await getGAToken();
    const encodedSiteUrl = encodeURIComponent(GSC_SITE);
    const response = await axios.post(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`,
      req.body,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

// ── WhatConverts proxy ─────────────────────────────────────────────────────
app.get('/api/whatconverts', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const auth = Buffer.from(`${process.env.WHATCONVERTS_TOKEN}:${process.env.WHATCONVERTS_SECRET}`).toString('base64');
    const response = await axios.get(`https://whatconverts.com/api/v1/profiles/${WC_PROFILE}/leads`, {
      headers: { Authorization: `Basic ${auth}` },
      params: { start_date, end_date, limit: 100 }
    });
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Penn Pain Dashboard running on port', PORT));