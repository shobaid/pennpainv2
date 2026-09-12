require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');

// ── Auth mode: %%AUTH_MODE%% (service_account or oauth) ───────────────────
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
const DASH_COOKIE = 'pennpain-dashboard';
const REVIEW_COOKIE = 'pp_reviewer';

// Sheet columns — injected by generator
const SHEET_COLUMNS = [{"key":"ad_spend","label":"Ad Spend","color":"#f87171","type":"currency"},{"key":"mtd_np_appts_occurring_this_month","label":"MTD: NP Appts Occurring This Month","color":"#00d084","type":"integer"},{"key":"mtd_np_future_month_appts","label":"MTD: NP Future Month Appts","color":"#4d9fff","type":"integer"},{"key":"mtd_np_appts_total","label":"MTD: NP Appts Total","color":"#f59e0b","type":"integer"}];
const QUALIFIED_LABEL = 'NP Appointments';

// ── Supabase ───────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Google auth (service account) ─────────────────────────────────────────
// ── Google Auth (supports both service account and OAuth) ─────────────────
const AUTH_MODE = 'service_account'; // injected by generator: 'service_account' or 'oauth'

let _oauthClient = null;
function getOAuthClient() {
  if (!_oauthClient) {
    _oauthClient = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.REDIRECT_URI || 'https://your-dashboard.vercel.app/auth/callback'
    );
    _oauthClient.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }
  return _oauthClient;
}

const gauth = AUTH_MODE === 'oauth' ? null : new GoogleAuth({
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
  if (AUTH_MODE === 'oauth') {
    const client = getOAuthClient();
    const { token } = await client.getAccessToken();
    return token;
  }
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
  return jwt.sign(data, process.env.SESSION_SECRET || 'pennpain-secret', { expiresIn: '7d' });
}

function readSession(req) {
  try {
    const token = req.cookies?.[REVIEW_COOKIE];
    if (!token) return null;
    return jwt.verify(token, process.env.SESSION_SECRET || 'pennpain-secret');
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

    // Build event list — filter out GA4 system events + user-excluded events
    const systemEvents = new Set([
      'session_start','first_visit','page_view','user_engagement',
      'scroll','click','file_download','video_start','video_progress','video_complete',
      'view_search_results','exception','purchase','add_to_cart','begin_checkout'
    ]);

    // User-excluded events (configured in generator)
    const excludeParam = req.query.exclude || '';
    const excludeEvents = new Set(
      excludeParam ? excludeParam.split(',').map(e => e.trim()).filter(Boolean) : []
    );

    const allEvents = (totalsRes.data.rows || [])
      .map(r => ({ name: r.dimensionValues[0].value, count: parseInt(r.metricValues[0].value) || 0 }))
      .filter(e => e.count > 0 && !systemEvents.has(e.name) && !excludeEvents.has(e.name));

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

// ── Google Business Profile (Sheets or GA4) ───────────────────────────────
const GMB_SOURCE = 'ga4'; // 'sheets' or 'ga4'
const GMB_SHEET_TAB = 'gmb_data'; // tab name for sheets mode

app.get('/api/gmb', async (req, res) => {
  const { start_date, end_date } = req.query;

  // ── GA4 mode ───────────────────────────────────────────────────────────
  if (GMB_SOURCE === 'ga4') {
    try {
      const token = await getGAToken();
      const gbpEvents = [
        'business_impressions_desktop_maps',
        'business_impressions_desktop_search',
        'business_impressions_mobile_maps',
        'business_impressions_mobile_search',
        'business_direction_requests',
        'business_phone_calls',
        'business_website_clicks',
        'business_impressions_maps',
        'business_impressions_search'
      ];

      // Fetch totals
      const totalsRes = await axios.post(
        `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
        {
          dateRanges: [{ startDate: start_date, endDate: end_date }],
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: gbpEvents } } }
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Fetch time series
      const tsRes = await axios.post(
        `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
        {
          dateRanges: [{ startDate: start_date, endDate: end_date }],
          dimensions: [{ name: 'date' }, { name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: gbpEvents } } },
          orderBys: [{ dimension: { dimensionName: 'date' } }]
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Build event map
      const evMap = {};
      (totalsRes.data.rows || []).forEach(r => {
        evMap[r.dimensionValues[0].value] = parseInt(r.metricValues[0].value) || 0;
      });

      // Build daily rows from time series
      const dateMap = {};
      (tsRes.data.rows || []).forEach(r => {
        const date = r.dimensionValues[0].value;
        const ev = r.dimensionValues[1].value;
        if (!dateMap[date]) dateMap[date] = {};
        dateMap[date][ev] = parseInt(r.metricValues[0].value) || 0;
      });

      const rows = Object.keys(dateMap).sort().map(date => {
        const d = dateMap[date];
        const impressions_desktop_maps = d['business_impressions_desktop_maps'] || 0;
        const impressions_desktop_search = d['business_impressions_desktop_search'] || 0;
        const impressions_mobile_maps = d['business_impressions_mobile_maps'] || 0;
        const impressions_mobile_search = d['business_impressions_mobile_search'] || 0;
        return {
          date: `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`,
          impressions: impressions_desktop_maps + impressions_desktop_search + impressions_mobile_maps + impressions_mobile_search + (d['business_impressions_maps']||0) + (d['business_impressions_search']||0),
          interactions: (d['business_direction_requests']||0) + (d['business_phone_calls']||0) + (d['business_website_clicks']||0),
          calls: d['business_phone_calls'] || 0,
          directions: d['business_direction_requests'] || 0,
          website_clicks: d['business_website_clicks'] || 0,
          impressions_desktop_maps,
          impressions_desktop_search,
          impressions_mobile_maps,
          impressions_mobile_search
        };
      });

      const totals = rows.reduce((acc, r) => {
        acc.impressions += r.impressions;
        acc.interactions += r.interactions;
        acc.calls += r.calls;
        acc.directions += r.directions;
        acc.website_clicks += r.website_clicks;
        acc.desktop_maps += r.impressions_desktop_maps;
        acc.desktop_search += r.impressions_desktop_search;
        acc.mobile_maps += r.impressions_mobile_maps;
        acc.mobile_search += r.impressions_mobile_search;
        return acc;
      }, { impressions:0, interactions:0, calls:0, directions:0, website_clicks:0, desktop_maps:0, desktop_search:0, mobile_maps:0, mobile_search:0 });

      return res.json({ rows, totals, source: 'ga4' });
    } catch(e) {
      return res.json({ error: e.message, rows: [], totals: {}, source: 'ga4' });
    }
  }

  // ── Sheets mode ───────────────────────────────────────────────────────
  try {
    const authClient = await gauth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${GMB_SHEET_TAB}!A:J`
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
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { data: user, error } = await supabase
      .from('dashboard_users').select('*').ilike('email', email.trim()).maybeSingle();
    if (error || !user) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign(
      { email: user.email, name: user.name, role: user.role },
      process.env.SESSION_SECRET || 'pennpain-secret',
      { expiresIn: '30d' }
    );
    res.cookie(DASH_COOKIE, token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/auth/dashboard/me', (req, res) => {
  try {
    const token = req.cookies?.[DASH_COOKIE];
    if (!token) return res.json({ authenticated: false });
    const user = jwt.verify(token, process.env.SESSION_SECRET || 'pennpain-secret');
    res.json({ authenticated: true, user });
  } catch { res.json({ authenticated: false }); }
});

app.post('/auth/dashboard/logout', (req, res) => {
  res.clearCookie(DASH_COOKIE);
  res.json({ ok: true });
});

// ── Review Auth: start OAuth ───────────────────────────────────────────────
app.get('/auth/review/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('pp_review_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    response_type: 'code',
    scope: 'email profile',
    access_type: 'online',
    prompt: 'select_account',
    state
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?review_error=${encodeURIComponent(error)}`);
  const savedState = req.cookies?.pp_review_state;
  if (!savedState || savedState !== state) return res.redirect('/?review_error=invalid_state');
  res.clearCookie('pp_review_state');
  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.REDIRECT_URI, grant_type: 'authorization_code'
    });
    const userRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    const email = userRes.data.email;
    const { data: reviewer, error: reviewerError } = await supabase
      .from('allowed_reviewers').select('*').ilike('email', email.trim()).maybeSingle();
    if (reviewerError) return res.redirect(`/?review_error=${encodeURIComponent('Database error: ' + reviewerError.message)}`);
    if (!reviewer) return res.redirect(`/?review_error=${encodeURIComponent('not_authorized: ' + email)}`);
    res.cookie(REVIEW_COOKIE, signSession({ email, name: userRes.data.name, picture: userRes.data.picture, role: reviewer.role }), COOKIE_OPTS);
    res.redirect('/?section=documents');
  } catch (e) {
    res.redirect(`/?review_error=${encodeURIComponent('Authentication failed')}`);
  }
});

app.get('/auth/review/me', (req, res) => {
  const session = readSession(req);
  if (!session) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: session });
});

app.post('/auth/review/logout', (req, res) => {
  res.clearCookie(REVIEW_COOKIE);
  res.json({ ok: true });
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

// ── OAuth Setup (only active when AUTH_MODE === 'oauth') ─────────────────
if (AUTH_MODE === 'oauth') {
  app.get('/setup', (req, res) => {
    const hasToken = !!process.env.GOOGLE_REFRESH_TOKEN;
    res.send(`<!DOCTYPE html>
<html>
<head><title>Dashboard Setup</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1117;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1d24;border:1px solid #2a2d35;border-radius:12px;padding:2.5rem;max-width:440px;width:100%;text-align:center}
h1{font-size:22px;margin:0 0 8px}p{color:#9ca3af;font-size:14px;margin:0 0 24px}
.btn{display:inline-flex;align-items:center;gap:8px;background:#4285f4;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{background:#3367d6}.success{color:#34d399;font-size:14px;margin-top:16px}
</style></head>
<body><div class="card">
<h1>Dashboard Setup</h1>
<p>Connect your Google account to authorize this dashboard to pull GA4 and Search Console data.</p>
${hasToken
  ? '<div class="success">✅ Google account connected. Dashboard is ready.</div><br><a href="/" class="btn">Go to Dashboard</a>'
  : '<a href="/auth/google" class="btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Connect Google Account</a>'
}
</div></body></html>`);
  });

  app.get('/auth/google', (req, res) => {
    const client = getOAuthClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/analytics.readonly',
        'https://www.googleapis.com/auth/webmasters.readonly',
        'https://www.googleapis.com/auth/spreadsheets.readonly'
      ]
    });
    res.redirect(url);
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      const { code } = req.query;
      const client = getOAuthClient();
      const { tokens } = await client.getToken(code);
      // Show the refresh token to copy into Vercel env vars
      res.send(`<!DOCTYPE html>
<html>
<head><title>OAuth Complete</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1117;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1d24;border:1px solid #2a2d35;border-radius:12px;padding:2.5rem;max-width:540px;width:100%}
h1{font-size:20px;margin:0 0 16px;color:#34d399}
.token{background:#0f1117;border:1px solid #2a2d35;border-radius:6px;padding:12px;font-family:monospace;font-size:12px;word-break:break-all;margin:12px 0}
p{color:#9ca3af;font-size:13px;margin:8px 0}
.step{background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:8px;padding:12px;margin:12px 0;font-size:13px}
</style></head>
<body><div class="card">
<h1>✅ Google Account Connected!</h1>
<p>Copy the refresh token below and add it as a Vercel environment variable:</p>
<div class="step">
  <strong>Variable name:</strong> GOOGLE_REFRESH_TOKEN<br>
  <strong>Value:</strong>
  <div class="token">${tokens.refresh_token || '(already set — token refreshed)'}</div>
</div>
<p>After adding it in Vercel → Settings → Environment Variables, redeploy the project. Then visit <a href="/setup" style="color:#4285f4">/setup</a> to confirm.</p>
</div></body></html>`);
    } catch(e) {
      res.status(500).send('OAuth error: ' + e.message);
    }
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ PennPain Dashboard running at http://localhost:${PORT}\n`));
module.exports = app;
