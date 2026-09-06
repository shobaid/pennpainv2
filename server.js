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
const SHEET_COLUMNS = [{"column_letter":"D","sheet_header":"Ad Spend","key":"custom","label":"Ad Spend","type":"currency","color":"#6b7280"},{"column_letter":"E","sheet_header":"MTD: NP Appts Occurring This Month","key":"custom","label":"MTD: NP Appts Occurring This Month","type":"integer","color":"#0055ff"},{"column_letter":"F","sheet_header":"MTD: NP Future Month Appts","key":"custom","label":"MTD: NP Future Month Appts","type":"integer","color":"#00ff6e"},{"column_letter":"G","sheet_header":"MTD: NP Appts Total","key":"custom","label":"MTD: NP Appts Total","type":"integer","color":"#ffae00"}];
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
        if (envKey) return envKey.replace(/\\n/g, '\n'); // <-- FIXED: escapes the backslash
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

// ── GA4 events proxy — auto-discovers all key events ──────────────────────
app.get('/api/ga4/events', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const token = await getGAToken();

    // Step 1: Fetch all events with counts for this period
    const totalsRes = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
      {
        dateRanges: [{ startDate: start_date, endDate: end_date }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: 50
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Build event list — filter out GA4 system events
    const systemEvents = new Set([
      'session_start','first_visit','page_view','user_engagement',
      'scroll','click','file_download','video_start','video_progress','video_complete',
      'view_search_results','exception','purchase','add_to_cart','begin_checkout'
    ]);

    const allEvents = (totalsRes.data.rows || [])
      .map(r => ({ name: r.dimensionValues[0].value, count: parseInt(r.metricValues[0].value) || 0 }))
      .filter(e => e.count > 0 && !systemEvents.has(e.name));

    if (allEvents.length === 0) {
      return res.json({ groups: [], evMap: {} });
    }

    // Step 2: Fetch time series for all discovered events
    const eventNames = allEvents.map(e => e.name);
    const tsRes = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
      {
        dateRanges: [{ startDate: start_date, endDate: end_date }],
        dimensions: [{ name: 'date' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: eventNames } } },
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: 5000
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Build time series map
    const tsMap = {};
    (tsRes.data.rows || []).forEach(r => {
      const date = r.dimensionValues[0].value;
      const event = r.dimensionValues[1].value;
      if (!tsMap[date]) tsMap[date] = {};
      tsMap[date][event] = parseInt(r.metricValues[0].value) || 0;
    });

    const dates = Object.keys(tsMap).sort();

    // Assign colors — cycle through palette
    const palette = ['#3a8fd4','#a78bfa','#f59e0b','#34d399','#f87171','#60a5fa','#fb923c','#a3e635','#e879f9','#2dd4bf'];

    // Build groups — each event is its own group
    const evMap = {};
    allEvents.forEach(e => { evMap[e.name] = e.count; });

    const groups = allEvents.map((ev, i) => ({
      key: ev.name.replace(/[^a-z0-9]/gi, '_'),
      label: formatEventLabel(ev.name),
      eventName: ev.name,
      color: palette[i % palette.length],
      total: ev.count,
      timeseries: dates.map(date => ({ date, value: tsMap[date]?.[ev.name] || 0 }))
    }));

    res.json({ groups, evMap });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

function formatEventLabel(eventName) {
  // Convert snake_case event names to readable labels
  return eventName
    .replace(/_/g, ' ')
    .replace(/\w/g, l => l.toUpperCase())
    .replace(/^Ads Conversion/, 'Ads')
    .replace(/Unique$/, '(Unique)')
    .replace(/Repeat$/, '(Repeat)');
}

// ── GSC proxy ──────────────────────────────────────────────────────────────
app.post('/api/gsc', async (req, res) => {
  try {
    const token = await getGAToken();
    const response = await axios.post(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`,
      req.body, { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── WhatConverts proxy ─────────────────────────────────────────────────────
app.get('/api/whatconverts', async (req, res) => {
  try {
    const { start_date, end_date, leads_per_page = 25, page_number = 1, quotable } = req.query;
    const token = Buffer.from(`${process.env.WHATCONVERTS_TOKEN}:${process.env.WHATCONVERTS_SECRET}`).toString('base64');
    const params = { profile_id: WC_PROFILE, start_date, end_date, leads_per_page, page_number };
    if (quotable) params.quotable = quotable;
    const response = await axios.get('https://app.whatconverts.com/api/v1/leads', {
      headers: { Authorization: `Basic ${token}` },
      params
    });
    const data = response.data;
    const leads = data.leads || [];
    const callLeads = leads.filter(l => (l.lead_type||'').toLowerCase().includes('call') || (l.lead_type||'').toLowerCase().includes('phone')).length;
    const formLeads = leads.filter(l => (l.lead_type||'').toLowerCase().includes('form') || (l.lead_type||'').toLowerCase().includes('web')).length;
    const textLeads = leads.filter(l => (l.lead_type||'').toLowerCase().includes('text') || (l.lead_type||'').toLowerCase().includes('sms')).length;
    res.json({
      total_leads: data.total_leads || 0,
      total_pages: data.total_pages || 1,
      leads,
      summary: { total: data.total_leads || 0, calls: callLeads, forms: formLeads, texts: textLeads }
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message, total_leads: 0, leads: [], summary: { total: 0, calls: 0, forms: 0, texts: 0 } });
  }
});

// ── WhatConverts NP Appointments (quotable=yes) ────────────────────────────
app.get('/api/whatconverts/np-appointments', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const token = Buffer.from(`${process.env.WHATCONVERTS_TOKEN}:${process.env.WHATCONVERTS_SECRET}`).toString('base64');

    const firstRes = await axios.get('https://app.whatconverts.com/api/v1/leads', {
      headers: { Authorization: `Basic ${token}` },
      params: { profile_id: WC_PROFILE, start_date, end_date, quotable: 'yes', leads_per_page: 100, page_number: 1 }
    });
    const total = firstRes.data.total_leads || 0;
    const totalPages = firstRes.data.total_pages || Math.ceil(total / 20);
    let leads = firstRes.data.leads || [];

    if (totalPages > 1) {
      const pageRequests = [];
      for (let p = 2; p <= totalPages; p++) {
        pageRequests.push(axios.get('https://app.whatconverts.com/api/v1/leads', {
          headers: { Authorization: `Basic ${token}` },
          params: { profile_id: WC_PROFILE, start_date, end_date, quotable: 'yes', leads_per_page: 100, page_number: p }
        }));
      }
      const pageResults = await Promise.all(pageRequests);
      pageResults.forEach(r => { leads = leads.concat(r.data.leads || []); });
    }

    const seen = new Set();
    const uniqueLeads = leads.filter(lead => {
      const id = lead.lead_id || lead.id;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const sourceMap = {};
    uniqueLeads.forEach(lead => {
      const source = lead.lead_source || lead.traffic_source || 'direct';
      const medium = lead.lead_medium || lead.traffic_medium || 'none';
      const key = medium === 'cpc' ? 'Google Ads' :
                  source === 'google' && medium === 'organic' ? 'Google Organic' :
                  source === '(direct)' || source === 'direct' ? 'Direct' :
                  medium === 'referral' ? 'Referral' :
                  medium === 'newsletter' || medium === 'email' ? 'Email' :
                  source ? source.charAt(0).toUpperCase() + source.slice(1) : 'Other';
      sourceMap[key] = (sourceMap[key] || 0) + 1;
    });

    const dateMap = {};
    uniqueLeads.forEach(lead => {
      if (lead.date_created) {
        const date = lead.date_created.split('T')[0];
        dateMap[date] = (dateMap[date] || 0) + 1;
      }
    });

    res.json({ total, leads: uniqueLeads.slice(0, 20), by_source: sourceMap, by_date: dateMap });
  } catch (e) {
    res.json({ error: e.message, total: 0, leads: [], by_source: {}, by_date: {} });
  }
});

// ── Google Sheets (Ad Spend + NP Appointments) ────────────────────────────
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

// ── Google Business Profile (via Google Sheets) ────────────────────────────
app.get('/api/gmb', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const authClient = await gauth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'gmb_data!A:J'
    });
    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ rows: [], totals: {} });

    const data = rows.slice(1).map(row => ({
      date: row[0] || '',
      impressions: parseInt((row[1] || '0').replace(/[^0-9]/g, '')) || 0,
      interactions: parseInt((row[2] || '0').replace(/[^0-9]/g, '')) || 0,
      website_clicks: parseInt((row[3] || '0').replace(/[^0-9]/g, '')) || 0,
      calls: parseInt((row[4] || '0').replace(/[^0-9]/g, '')) || 0,
      directions: parseInt((row[5] || '0').replace(/[^0-9]/g, '')) || 0,
      impressions_desktop_maps: parseInt((row[6] || '0').replace(/[^0-9]/g, '')) || 0,
      impressions_desktop_search: parseInt((row[7] || '0').replace(/[^0-9]/g, '')) || 0,
      impressions_mobile_maps: parseInt((row[8] || '0').replace(/[^0-9]/g, '')) || 0,
      impressions_mobile_search: parseInt((row[9] || '0').replace(/[^0-9]/g, '')) || 0
    })).filter(r => {
      if (!r.date || r.date === 'Date') return false;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return false;
      if (r.impressions === 0 && r.interactions === 0 && r.calls === 0) return false;
      return true;
    });

    const filtered = (start_date && end_date)
      ? data.filter(r => r.date >= start_date && r.date <= end_date)
      : data;

    const totals = filtered.reduce((acc, row) => {
      acc.impressions += row.impressions; acc.interactions += row.interactions;
      acc.website_clicks += row.website_clicks; acc.calls += row.calls;
      acc.directions += row.directions; acc.desktop_search += row.impressions_desktop_search;
      acc.mobile_search += row.impressions_mobile_search;
      acc.desktop_maps += row.impressions_desktop_maps;
      acc.mobile_maps += row.impressions_mobile_maps;
      return acc;
    }, { impressions:0, interactions:0, website_clicks:0, calls:0, directions:0, desktop_search:0, mobile_search:0, desktop_maps:0, mobile_maps:0 });

    res.json({ rows: filtered, totals });
  } catch (e) {
    res.json({ error: e.message, rows: [], totals: { impressions:0, interactions:0, website_clicks:0, calls:0, directions:0, desktop_search:0, mobile_search:0, desktop_maps:0, mobile_maps:0 } });
  }
});

// ── Dashboard Auth (email/password) ───────────────────────────────────────
app.post('/auth/dashboard/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(' LOGIN ATTEMPT:', { 
      email, 
      emailLength: email?.length,
      hasTrailingSpace: email?.endsWith(' '),
      passwordLength: password?.length 
    });

    const { data: user, error } = await supabase
      .from('dashboard_users')
      .select('id, email, name, role, password_hash')
      .eq('email', email.toLowerCase().trim())
      .single();

    console.log(' SUPABASE RESULT:', { 
      found: !!user, 
      error: error?.message,
      userEmail: user?.email,
      hasHash: !!user?.password_hash,
      hashStart: user?.password_hash?.slice(0, 20) 
    });

    if (error || !user) {
      console.log('❌ USER NOT FOUND');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    console.log('🔑 PASSWORD CHECK:', { isValid });

    if (!isValid) {
      console.log('❌ PASSWORD MISMATCH');
      console.log('Attempted password length:', password.length);
      console.log('Stored hash:', user.password_hash);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Success...
    const sessionData = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token = signSession(sessionData);
    
    res.cookie('pp_dashboard', token, COOKIE_OPTS);
    res.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
  } catch (e) {
    console.error('💥 LOGIN ERROR:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/auth/dashboard/me', (req, res) => {
  try {
    const token = req.cookies?.[DASH_COOKIE];
    if (!token) return res.json({ authenticated: false });
    const user = jwt.verify(token, process.env.SESSION_SECRET || 'penn-pain-secret');
    res.json({ authenticated: true, user });
  } catch { res.json({ authenticated: false }); }
});

app.post('/auth/dashboard/logout', (req, res) => {
  res.clearCookie(DASH_COOKIE);
  res.json({ ok: true });
});

// ── Review Auth (Supabase Email/Password) ──────────────────────────────
app.post('/auth/review/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: user, error } = await supabase
      .from('dashboard_users')
      .select('id, email, name, role, password_hash')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if user has permission to review (admin or reviewer)
    if (user.role !== 'admin' && user.role !== 'reviewer') {
      return res.status(403).json({ error: 'You do not have permission to review documents' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Set reviewer session cookie
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

// ── Documents API ──────────────────────────────────────────────────────────
app.get('/api/documents', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { data, error } = await supabase.from('documents').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/documents', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { title, google_doc_url, description } = req.body;
  if (!title || !google_doc_url) return res.status(400).json({ error: 'Title and Google Doc URL are required' });
  const { data, error } = await supabase.from('documents').insert([{
    title, google_doc_url, description, created_by: session.email, status: 'pending'
  }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/documents/:id/status', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { status } = req.body;
  if (!['pending', 'approved', 'needs_edits'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { data, error } = await supabase.from('documents').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/documents/:id', async (req, res) => {
  const session = readSession(req);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/documents/:id/comments', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { data, error } = await supabase.from('comments').select('*').eq('document_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/documents/:id/comments', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  const { data, error } = await supabase.from('comments').insert([{
    document_id: req.params.id, author_email: session.email,
    author_name: session.name || session.email, body: body.trim()
  }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ Penn Pain Dashboard running at http://localhost:${PORT}\n`));
module.exports = app;
