require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const GA4_PROPERTY = 'properties/486245473';
const GSC_SITE = 'sc-domain:pennpain.com';
const WC_PROFILE = '148479';
const SHEET_ID = '1cXnqHBu9OJXA-TIemxTAm8tkKNDOMbY8hWgWlpbi3P4';
const SHEET_TAB = 'dash data mtd';
const DASH_COOKIE = 'penn-pain-dashboard';
const REVIEW_COOKIE = 'pp_reviewer';

// Sheet columns — injected by generator
const SHEET_COLUMNS = [{"column_letter":"D","sheet_header":"Ad Spend","key":"ad_spend","label":"Ad Spend","type":"currency","color":"#f87171"},{"column_letter":"E","sheet_header":"MTD: NP Appts Occurring This Month","key":"np_appointments","label":"MTD: NP Appts Occurring This Month","type":"currency","color":"#00d084"},{"column_letter":"F","sheet_header":"MTD: NP Future Month Appts","key":"custom","label":"MTD: NP Future Month Appts","type":"currency","color":"#0055ff"},{"column_letter":"G","sheet_header":"MTD: NP Appts Total","key":"custom","label":"MTD: NP Appts Total","type":"currency","color":"#fbff00"}];
const QUALIFIED_LABEL = 'NP Appointments';

// ── Supabase ───────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
    const response = await axios.post(
      `https://searchconsole.googleapis.com/v1/searchAnalytics/query`,
      { ...req.body, siteUrl: GSC_SITE },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    // LOG THE FULL ERROR DETAILS HERE
    console.error('GSC API Full Error:', e.response?.data);
    
    res.status(e.response?.status || 500).json({ error: e.message,
      // Send the Google API error message back to the browser
      details: e.response?.data?.error?.message || 'No details'
     });
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

// ── WhatConverts NP Appointments ───────────────────────────────────────────
app.get('/api/whatconverts/np-appointments', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const auth = Buffer.from(`${process.env.WHATCONVERTS_TOKEN}:${process.env.WHATCONVERTS_SECRET}`).toString('base64');
    const response = await axios.get(`https://whatconverts.com/api/v1/profiles/${WC_PROFILE}/leads`, {
      headers: { Authorization: `Basic ${auth}` },
      params: { 
        start_date, 
        end_date, 
        limit: 1000,
        'filter[field]': 'quotable',
        'filter[value]': 'Yes'
      }
    });
    
    const leads = response.data.leads || [];
    const bySource = {};
    const byType = {};
    const byDate = {};
    
    leads.forEach(lead => {
      const source = lead.traffic_source || 'Direct';
      const type = lead.lead_type || 'Unknown';
      const date = lead.date_created?.split('T')[0] || 'Unknown';
      
      bySource[source] = (bySource[source] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;
      byDate[date] = (byDate[date] || 0) + 1;
    });
    
    res.json({
      total: leads.length,
      leads,
      by_source: bySource,
      by_type: byType,
      by_date: byDate
    });
  } catch (e) {
    res.json({ error: e.message, total: 0, leads: [], by_source: {}, by_type: {}, by_date: {} });
  }
});

// ── Google Sheets ──────────────────────────────────────────────────────────
app.get('/api/adspend', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const authClient = await gauth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const colCount = SHEET_COLUMNS.length + 3;
    const lastCol = String.fromCharCode(64 + colCount);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:${lastCol}`
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ rows: [], columns: SHEET_COLUMNS, latest: null, totals: {} });

    const data = rows.slice(1).map(row => {
      const entry = { date: row[0] || '', week_start: row[1] || '', week_end: row[2] || '' };
      SHEET_COLUMNS.forEach((col, i) => {
        const raw = (row[i + 3] || '0').toString().replace(/[$,]/g, '');
        entry[col.key] = col.type === 'currency' || col.type === 'number'
          ? parseFloat(raw) || 0
          : parseInt(raw.replace(/[^0-9]/g, '')) || 0;
      });
      return entry;
    }).filter(r => r.date && r.week_end);

    const filtered = (start_date && end_date)
      ? data.filter(r => r.week_end >= start_date && r.week_end <= end_date)
      : data;

    const latest = data[0] || null;
    const totals = {};
    SHEET_COLUMNS.forEach(col => {
      totals[col.key] = Math.round(filtered.reduce((s, r) => s + (r[col.key] || 0), 0) * 100) / 100;
    });

    res.json({ rows: filtered, all_rows: data, columns: SHEET_COLUMNS, latest, totals });
  } catch (e) {
    res.json({ error: e.message, rows: [], columns: SHEET_COLUMNS, latest: null, totals: {} });
  }
});

// ── Google Business Profile ────────────────────────────────────────────────

app.get('/api/gmb', async (req, res) => {
  try {
    const authClient = await gauth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'gmb_data!A:J'
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ rows: [], totals: {} });

    const headers = rows[0];
    const data = rows.slice(1).map(row => {
      const entry = {};
      headers.forEach((h, i) => {
        const key = h.toLowerCase().replace(/[^a-z0-9]/g, '_');
        entry[key] = row[i] || '';
      });
      return entry;
    });

    const totals = {
      impressions: data.reduce((s, r) => s + (parseInt(r.impressions) || 0), 0),
      interactions: data.reduce((s, r) => s + (parseInt(r.interactions) || 0), 0),
      calls: data.reduce((s, r) => s + (parseInt(r.calls) || 0), 0),
      directions: data.reduce((s, r) => s + (parseInt(r.direction_requests) || 0), 0),
      website_clicks: data.reduce((s, r) => s + (parseInt(r.website_clicks) || 0), 0)
    };

    res.json({ rows: data, totals });
  } catch (e) {
    res.json({ error: e.message, rows: [], totals: {} });
  }
});

// ── Dashboard Auth ───────────────────────────────────────────────────────
app.post('/auth/dashboard/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { data: user, error } = await supabase
      .from('dashboard_users')
      .select('id, email, name, role, password_hash')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      console.log('❌ USER NOT FOUND');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      console.log('❌ PASSWORD MISMATCH');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const sessionData = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token = signSession(sessionData);
    
    res.cookie(DASH_COOKIE, token, COOKIE_OPTS);
    res.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/auth/dashboard/logout', (req, res) => {
  res.clearCookie(DASH_COOKIE);
  res.json({ ok: true });
});

app.get('/auth/dashboard/me', (req, res) => {
  try {
    const token = req.cookies?.[DASH_COOKIE];
    if (!token) return res.json({ authenticated: false });
    
    const user = jwt.verify(token, process.env.SESSION_SECRET || 'penn-pain-secret');
    res.json({ authenticated: true, user });
  } catch {
    res.json({ authenticated: false });
  }
});

// ── Review Auth (Supabase Email/Password) ────────────────────────────────
app.post('/auth/review/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: user, error } = await supabase
      .from('dashboard_users')
      .select('id, email, name, role, password_hash')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.role !== 'admin' && user.role !== 'reviewer') {
      return res.status(403).json({ error: 'You do not have permission to review documents' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const sessionData = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token = signSession(sessionData);
    
    res.cookie(REVIEW_COOKIE, token, COOKIE_OPTS);
    res.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
  } catch (e) {
    console.error('Review login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/auth/review/logout', (req, res) => {
  res.clearCookie(REVIEW_COOKIE);
  res.json({ ok: true });
});

app.get('/auth/review/me', (req, res) => {
  const user = readSession(req);
  if (user && (user.role === 'admin' || user.role === 'reviewer')) {
    res.json({ authenticated: true, user });
  } else {
    res.json({ authenticated: false });
  }
});

// ── Documents API ─────────────────────────────────────────────────────────
app.get('/api/documents', async (req, res) => {
  try {
    const { data, error } = await supabase.from('documents').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/documents', async (req, res) => {
  try {
    const user = readSession(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
    
    const { title, google_doc_url, description } = req.body;
    const { data, error } = await supabase
      .from('documents')
      .insert([{ title, google_doc_url, description, created_by: user.email }])
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/documents/:id/comments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('comments')
      .select('*')
      .eq('document_id', req.params.id)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/documents/:id/comments', async (req, res) => {
  try {
    const user = readSession(req);
    if (!user) return res.status(403).json({ error: 'Unauthorized' });
    
    const { body } = req.body;
    const { data, error } = await supabase
      .from('comments')
      .insert([{ 
        document_id: req.params.id, 
        author_email: user.email, 
        author_name: user.name,
        body 
      }])
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/documents/:id/status', async (req, res) => {
  try {
    const user = readSession(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
    
    const { status } = req.body;
    const { data, error } = await supabase
      .from('documents')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Penn Pain Dashboard running on port', PORT));