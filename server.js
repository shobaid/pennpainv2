require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'momentum2026';

// ── Auth ───────────────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ error: 'Wrong password' });
});

// ── Generate ───────────────────────────────────────────────────────────────
app.post('/api/generate', (req, res) => {
  const { password, config } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let indexHtml = fs.readFileSync(path.join(__dirname, 'template-index.html'), 'utf8');
    let serverJs  = fs.readFileSync(path.join(__dirname, 'template-server.js'), 'utf8');

    const {
      clientName, clientWebsite, clientInitials, brandColor, logoB64, agencyLabel,
      authMethod, oauthClientId, oauthClientSecret, oauthRedirectUri,
      ga4PropertyId, gscSiteUrl, wcProfileId,
      sheetId, sheetTab, sheetColumns,
      qualifiedLabel,
      supabaseUrl, redirectUri,
      useGA4, useGSC, useWC, useSheets, useDocs, useQualified, useAdSpend,
      useGMB, useDashboardLogin, gmbSource, gmbTab, gmbSheetId, ga4ExcludeEvents
    } = config;

    const slug     = toSlug(clientName);
    const colorRgb = hexToRgb(brandColor);
    const rgbStr   = colorRgb ? `${colorRgb.r},${colorRgb.g},${colorRgb.b}` : '58,143,212';
    const initials = clientInitials || clientName.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const qlabel   = qualifiedLabel || 'Qualified Leads';
    const agency   = agencyLabel || 'Momentum Digital';

    // ── index.html swaps ──────────────────────────────────────────────────

    // Title
    indexHtml = indexHtml.replace(
      '<title>Penn Pain· Analytics by Momentum Digital</title>',
      `<title>${clientName} · Analytics by ${agency}</title>`
    );

    // Brand color
    indexHtml = indexHtml.replace(/--green: #3a8fd4;/, `--green: ${brandColor};`);
    indexHtml = indexHtml.replace(/rgba\(58,143,212,0\.12\)/g, `rgba(${rgbStr},0.12)`);
    indexHtml = indexHtml.replace(/rgba\(58,143,212,0\.07\)/g, `rgba(${rgbStr},0.07)`);
    indexHtml = indexHtml.replace(/rgba\(58,143,212,0\.06\)/g, `rgba(${rgbStr},0.06)`);
    indexHtml = indexHtml.replace(/rgba\(58,143,212,0\.2\)/g,  `rgba(${rgbStr},0.2)`);
    indexHtml = indexHtml.replace(/rgba\(58,143,212,0\.3\)/g,  `rgba(${rgbStr},0.3)`);
    indexHtml = indexHtml.replace(/#3a8fd4/g, brandColor);

    // Logo
    const { logoInvert = true } = config;
    if (logoB64) {
      const filterStyle = logoInvert ? 'filter:brightness(0) invert(1)' : '';
      indexHtml = indexHtml.replace(
        /<img src="data:image\/webp;base64,[^"]*" alt="Momentum Digital"[^>]*>/,
        `<img src="${logoB64}" alt="${clientName}" style="max-height:36px;max-width:160px;height:auto;display:block;${filterStyle}">`
      );
    }

    // Client name, website, initials
    indexHtml = indexHtml.replace(/Penn Pain Physicians/g, clientName);
    indexHtml = indexHtml.replace(/Penn Pain·/g, clientName + '·');
    indexHtml = indexHtml.replace(/PennPain(?!\.com)/g, initials);
    indexHtml = indexHtml.replace(/https:\/\/pennpain\.com/g, clientWebsite || '#');
    indexHtml = indexHtml.replace(/pennpain\.com(?!\/search)/g, clientWebsite ? clientWebsite.replace(/https?:\/\//, '') : '');
    indexHtml = indexHtml.replace(/GA4 · 486245473/g, useGA4 ? `GA4 · ${ga4PropertyId}` : '');
    indexHtml = indexHtml.replace(/GSC · pennpain\.com/g, useGSC ? `GSC · ${gscSiteUrl}` : '');

    // Agency label
    indexHtml = indexHtml.replace(/%%AGENCY_LABEL%%/g, agency);
    indexHtml = indexHtml.replace(/%%CLIENT_NAME%%/g, clientName);
    if (agency !== 'Momentum Digital') {
      indexHtml = indexHtml.replace(/Momentum Digital/g, agency);
    }

    // GA4 property ID
    if (ga4PropertyId) indexHtml = indexHtml.replace(/486245473/g, ga4PropertyId);

    // Qualified leads label
    indexHtml = indexHtml.replace(/%%QUALIFIED_LABEL%%/g, qlabel);

    // Colors array
    indexHtml = indexHtml.replace(
      "const COLORS = ['#3a8fd4',",
      `const COLORS = ['${brandColor}',`
    );

    // ── GMB section ───────────────────────────────────────────────────────
    if (useGMB) {
      indexHtml = indexHtml.replace('%%GMB_NAV%%', `<button class="nav-item" onclick="showSection('gmb',this)" id="nav-gmb">
      <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1C5.2 1 3 3.2 3 6c0 3.9 5 9 5 9s5-5.1 5-9c0-2.8-2.2-5-5-5zm0 6.8C6.8 7.8 5.8 6.8 5.8 5.6S6.8 3.5 8 3.5s2.2 1 2.2 2.2S9.2 7.8 8 7.8z"/></svg>
      Google Business
    </button>`);

      indexHtml = indexHtml.replace('%%GMB_SECTION%%', `<div id="sec-gmb" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;padding:1rem 1.25rem;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);animation:fadeUp 0.3s ease both">
          <div style="display:flex;align-items:center;gap:14px">
            <div style="width:42px;height:42px;border-radius:10px;background:rgba(66,133,244,0.12);display:flex;align-items:center;justify-content:center;font-size:20px">📍</div>
            <div><div style="font-size:15px;font-weight:600;letter-spacing:-0.2px">Google Business Profile</div>
            <div style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-top:3px">${clientName} · Both Locations Combined</div></div>
          </div>
          <span class="pill" style="background:rgba(66,133,244,0.12);color:#4285f4">Agency Analytics</span>
        </div>
        <div class="section-label">Performance</div>
        <div class="stats-grid" style="margin-bottom:1.5rem">
          <div class="chart-card" style="padding:1.25rem"><div style="font-size:10.5px;font-weight:500;color:var(--muted);letter-spacing:0.06em;text-transform:uppercase;font-family:var(--font-mono);margin-bottom:10px">Impressions</div><div style="font-family:var(--font-display);font-size:28px;font-weight:600;letter-spacing:-0.3px;color:#4285f4" id="gmb-impressions">–</div><div style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-top:6px">Search + Maps views</div></div>
          <div class="chart-card" style="padding:1.25rem"><div style="font-size:10.5px;font-weight:500;color:var(--muted);letter-spacing:0.06em;text-transform:uppercase;font-family:var(--font-mono);margin-bottom:10px">Interactions</div><div style="font-family:var(--font-display);font-size:28px;font-weight:600;letter-spacing:-0.3px;color:var(--green)" id="gmb-interactions">–</div><div style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-top:6px">Total profile actions</div></div>
          <div class="chart-card" style="padding:1.25rem"><div style="font-size:10.5px;font-weight:500;color:var(--muted);letter-spacing:0.06em;text-transform:uppercase;font-family:var(--font-mono);margin-bottom:10px">Calls</div><div style="font-family:var(--font-display);font-size:28px;font-weight:600;letter-spacing:-0.3px;color:var(--green)" id="gmb-calls">–</div><div style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-top:6px">Phone call clicks</div></div>
          <div class="chart-card" style="padding:1.25rem"><div style="font-size:10.5px;font-weight:500;color:var(--muted);letter-spacing:0.06em;text-transform:uppercase;font-family:var(--font-mono);margin-bottom:10px">Direction Requests</div><div style="font-family:var(--font-display);font-size:28px;font-weight:600;letter-spacing:-0.3px;color:var(--amber)" id="gmb-directions">–</div><div style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-top:6px">Get directions clicks</div></div>
          <div class="chart-card" style="padding:1.25rem"><div style="font-size:10.5px;font-weight:500;color:var(--muted);letter-spacing:0.06em;text-transform:uppercase;font-family:var(--font-mono);margin-bottom:10px">Website Clicks</div><div style="font-family:var(--font-display);font-size:28px;font-weight:600;letter-spacing:-0.3px;color:#4285f4" id="gmb-website-clicks">–</div><div style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-top:6px">Visit website clicks</div></div>
        </div>
        <div class="chart-row-2" style="margin-bottom:1.5rem">
          <div class="chart-card"><div class="section-header"><div><div class="section-title">Search vs Maps</div><div class="section-sub">Impressions by platform</div></div><span class="pill" style="background:rgba(66,133,244,0.12);color:#4285f4">GBP</span></div><div id="gmbSearchMapsLegend" class="legend-row" style="margin-bottom:8px"></div><div style="position:relative;height:200px"><canvas id="gmbSearchMapsChart"></canvas></div></div>
          <div class="chart-card"><div class="section-header"><div><div class="section-title">Mobile vs Desktop</div><div class="section-sub">Impressions by device</div></div><span class="pill" style="background:rgba(66,133,244,0.12);color:#4285f4">GBP</span></div><div id="gmbDeviceLegend" class="legend-row" style="margin-bottom:8px"></div><div style="position:relative;height:200px"><canvas id="gmbDeviceChart"></canvas></div></div>
        </div>
        <div class="chart-card" style="margin-bottom:1.5rem"><div class="section-header"><div><div class="section-title">Impressions Over Time</div><div class="section-sub">Daily GBP profile views</div></div><span class="pill" style="background:rgba(66,133,244,0.12);color:#4285f4">GBP</span></div><div class="legend-row" style="margin-bottom:8px"><div class="legend-item"><div class="legend-swatch" style="background:#4285f4"></div>Impressions</div><div class="legend-item"><div class="legend-swatch" style="background:var(--green)"></div>Interactions</div></div><div style="position:relative;height:220px"><canvas id="gmbImpressionsChart"></canvas></div></div>
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;font-size:12px;color:var(--muted);font-family:var(--font-mono);margin-bottom:1.5rem">💡 Data from Agency Analytics Google Sheets add-on · Refresh the gmb_data sheet tab to update</div>
      </div>`);

      indexHtml = indexHtml.replace('%%GMB_FETCH%%', `fetch(\`/api/gmb?start_date=\${start}&end_date=\${end}\`).then(r=>r.json()).catch(()=>({rows:[],totals:{}}))`);
    } else {
      indexHtml = indexHtml.replace('%%GMB_NAV%%', '');
      indexHtml = indexHtml.replace('%%GMB_SECTION%%', '');
      indexHtml = indexHtml.replace('%%GMB_FETCH%%', `Promise.resolve({rows:[],totals:{}})`);
    }

    // ── Sheet KPI cards (dynamic) ─────────────────────────────────────────
    if (useSheets && sheetColumns && sheetColumns.length > 0) {
      const kpiCardsHtml = `<div style="display:grid;grid-template-columns:repeat(${Math.min(sheetColumns.length, 4)},1fr);gap:12px;margin-bottom:1.5rem">\n` +
        sheetColumns.map(col => `          <div class="chart-card" style="padding:1rem;border-color:${col.color}33">
            <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">${col.label}</div>
            <div style="font-family:var(--font-display);font-size:32px;font-weight:700;color:${col.color};letter-spacing:-0.5px" id="sheet-kpi-${col.key}">–</div>
            <div style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-top:4px">from sheet · date filtered</div>
          </div>`).join('\n') +
        '\n        </div>';
      indexHtml = indexHtml.replace('        %%SHEET_KPI_CARDS%%', kpiCardsHtml);

      const kpiJs = sheetColumns.map(col => {
        const elVar = `el_${col.key}`;
        const getValue = col.type === 'currency'
          ? `'$' + (adSpend.totals['${col.key}'] || 0).toLocaleString()`
          : `fmt(adSpend.totals['${col.key}'] || 0)`;
        return [
          `    const ${elVar} = document.getElementById('sheet-kpi-${col.key}');`,
          `    if (${elVar}) ${elVar}.textContent = adSpend.totals ? (${getValue}) : '\u2013';`
        ].join('\n');
      }).join('\n');
      indexHtml = indexHtml.replace('    %%SHEET_KPI_JS%%', kpiJs);
    } else {
      indexHtml = indexHtml.replace('        %%SHEET_KPI_CARDS%%', '');
      indexHtml = indexHtml.replace('    %%SHEET_KPI_JS%%', '');
    }

    // Remove unused sections
    if (!useWC) {
      indexHtml = indexHtml.replace('<span class="nav-badge" id="nb-conversions">–</span>', '');
    }
    if (!useDocs) {
      indexHtml = indexHtml.replace(/id="nav-documents"[\s\S]*?<\/button>\s*\n/, '');
    }
    if (!useQualified) {
      indexHtml = indexHtml.replace(
        /<!-- NP Appointments section -->[\s\S]*?<div style="height:1px;background:var\(--border\)/,
        '<div style="height:1px;background:var(--border)'
      );
    }

    // ── server.js swaps ───────────────────────────────────────────────────
    serverJs = serverJs.replace("'properties/486245473'", `'properties/${ga4PropertyId || ''}'`);
    serverJs = serverJs.replace("'sc-domain:pennpain.com'", `'${gscSiteUrl || ''}'`);
    serverJs = serverJs.replace("'148479'", `'${wcProfileId || ''}'`);
    serverJs = serverJs.replace("'1cXnqHBu9OJXA-TIemxTAm8tkKNDOMbY8hWgWlpbi3P4'", `'${sheetId || ''}'`);
    serverJs = serverJs.replace("'dashboard_data'", `'${sheetTab || 'dashboard_data'}'`);
    serverJs = serverJs.replace(/%%SLUG%%/g, slug);
    // Auth mode
    const authMode = authMethod || 'service_account';
    serverJs = serverJs.replace("'%%AUTH_MODE%%'", `'${authMode}'`);
    const excludeEventsStr = (ga4ExcludeEvents || '').trim();
    // GMB source + tab
    const gmbSrc = gmbSource || 'sheets';
    const gmbTabName = gmbTab || 'gmb_data';
    serverJs = serverJs.replace("'%%GMB_SOURCE%%'", `'${gmbSrc}'`);
    serverJs = serverJs.replace("'%%GMB_SHEET_TAB%%'", `'${gmbTabName}'`);
    if (gmbSrc === 'ga4') {
      indexHtml = indexHtml.replace('Data from Agency Analytics Google Sheets add-on · Refresh the gmb_data sheet tab to update', 'Data from GA4 · GBP linked via GA4 → Admin → Google Business Profile linking');
    }
    serverJs = serverJs.replace('%%GA4_EXCLUDE_EVENTS%%', excludeEventsStr);
    indexHtml = indexHtml.replace('%%GA4_EXCLUDE_EVENTS%%', excludeEventsStr);
    serverJs = serverJs.replace(/%%AGENCY_LABEL%%/g, agency);
    serverJs = serverJs.replace(/%%CLIENT_NAME%%/g, clientName);

    // Inject SHEET_COLUMNS config
    const colsJson = JSON.stringify(
      (sheetColumns || []).map(c => ({ key: c.key, label: c.label, color: c.color, type: c.type || 'number' }))
    );
    serverJs = serverJs.replace('%%SHEET_COLUMNS%%', colsJson);
    serverJs = serverJs.replace('%%QUALIFIED_LABEL%%', qlabel);

    // ── Conditional KPI cards ─────────────────────────────────────────────
    // Inject conditional KPI cards — null means card won't show (filtered by .filter(Boolean))
    const wcLeadsCard = useWC
      ? `{id:'wc-leads',label:'Total Leads',value:fmt(wcTotal),color:'#f59e0b',noComp:true,sub:true,path:'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',sparkData:(ts.rows||[]).map((_,i)=>i),subLabel:'WhatConverts · all leads'}`
      : 'null';
    const npApptsCard = (useWC && useQualified)
      ? `{id:'np-appts',label:'${qlabel}',value:fmt(cachedData.npData?.total||0),color:'#00d084',noComp:true,sub:true,path:'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',sparkData:(ts.rows||[]).map((_,i)=>i),subLabel:'WhatConverts · ${qlabel}'}`
      : 'null';
    const adSpendCard = (useSheets || useAdSpend)
      ? `{id:'ad-spend',label:'Ad Spend',value:'$'+(cachedData.adSpendData?.totals ? Object.values(cachedData.adSpendData.totals)[0] || 0 : 0).toLocaleString(),color:'#f87171',noComp:true,sub:true,path:'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',sparkData:(cachedData.adSpendData?.rows||[]).map(r=>r[Object.keys(r)[3]]||0),subLabel:'Google Ads · from sheet'}`
      : 'null';

    indexHtml = indexHtml.replace('    %%WC_LEADS_CARD%%', '    ' + wcLeadsCard + ',');
    indexHtml = indexHtml.replace('    %%NP_APPTS_CARD%%', '    ' + npApptsCard + ',');
    indexHtml = indexHtml.replace('    %%AD_SPEND_CARD%%', '    ' + adSpendCard + ',');

    // Remove unused endpoints
    if (!useWC) {
      serverJs = serverJs.replace(/\/\/ ── WhatConverts proxy[\s\S]*?(?=\/\/ ── WhatConverts NP|\/\/ ── Google Sheets|\/\/ ── Google Business|\/\/ ── Dashboard Auth|\/\/ ── Review Auth|const PORT)/, '');
    }
    if (!useQualified) {
      serverJs = serverJs.replace(/\/\/ ── WhatConverts NP Appointments[\s\S]*?(?=\/\/ ── Google Sheets|\/\/ ── Google Business|\/\/ ── Dashboard Auth|\/\/ ── Review Auth|const PORT)/, '');
    }
    if (!useSheets) {
      serverJs = serverJs.replace(/\/\/ ── Google Sheets[\s\S]*?(?=\/\/ ── Google Business|\/\/ ── Dashboard Auth|\/\/ ── Review Auth|const PORT)/, '');
    }
    if (!useGMB) {
      serverJs = serverJs.replace(/\/\/ ── Google Business Profile[\s\S]*?(?=\/\/ ── Dashboard Auth|\/\/ ── Review Auth|const PORT)/, '');
    }
    if (!useDashboardLogin) {
      serverJs = serverJs.replace(/\/\/ ── Dashboard Auth[\s\S]*?(?=\/\/ ── Review Auth|const PORT)/, '');
    }
    if (!useDocs) {
      serverJs = serverJs.replace(/\/\/ ── Review Auth[\s\S]*?(?=const PORT)/, '');
      serverJs = serverJs.replace(/\/\/ ── Documents API[\s\S]*?(?=const PORT)/, '');
    }

    // Update console log
    serverJs = serverJs.replace('PennPain Dashboard running', `${clientName} Dashboard running`);

    // ── Strip unused requires based on enabled features ───────────────────
    const needsSupabase = useDocs || useDashboardLogin;

    const needsJwt = useDocs || useDashboardLogin;
    const needsCookieParser = useDocs || useDashboardLogin;
    const needsBcrypt = useDashboardLogin;
    const needsGoogleapis = useSheets || useGMB;
    const needsCrypto = useDocs;

    if (!needsSupabase) {
      serverJs = serverJs.replace("const { createClient } = require('@supabase/supabase-js');\n", '');
      serverJs = serverJs.replace(/const supabase = createClient\([\s\S]*?\);\n/, '');
    }
    if (!needsBcrypt) serverJs = serverJs.replace("const bcrypt = require('bcryptjs');\n", '');
    if (!needsJwt) serverJs = serverJs.replace("const jwt = require('jsonwebtoken');\n", '');
    if (!needsCookieParser) {
      serverJs = serverJs.replace("const cookieParser = require('cookie-parser');\n", '');
      serverJs = serverJs.replace("app.use(cookieParser());\n", '');
    }
    if (!needsGoogleapis) serverJs = serverJs.replace("const { google } = require('googleapis');\n", '');
    if (!needsCrypto) serverJs = serverJs.replace("const crypto = require('crypto');\n", '');

    // ── package.json ──────────────────────────────────────────────────────
    const deps = {
      "express": "^4.18.2",
      "axios": "^1.6.0",
      "google-auth-library": "^9.0.0",
      "dotenv": "^16.3.1"
    };
    if (needsGoogleapis) deps["googleapis"] = "^140.0.0";
    if (needsJwt) deps["jsonwebtoken"] = "^9.0.2";
    if (needsCookieParser) deps["cookie-parser"] = "^1.4.6";
    if (needsSupabase) deps["@supabase/supabase-js"] = "^2.38.0";
    if (needsBcrypt) deps["bcryptjs"] = "^2.4.3";

    const packageJson = JSON.stringify({
      name: `${slug}-dashboard`,
      version: "1.0.0",
      main: "server.js",
      scripts: { start: "node server.js" },
      dependencies: deps
    }, null, 2);

    // ── vercel.json ───────────────────────────────────────────────────────
    const vercelJson = JSON.stringify({
      version: 2,
      builds: [{ src: "server.js", use: "@vercel/node" }],
      routes: [{ src: "/(.*)", dest: "server.js" }]
    }, null, 2);

    // ── .env.example ──────────────────────────────────────────────────────
    let envExample = `# ${clientName} Dashboard — Environment Variables\n\n`;
    if (authMode === 'oauth') {
      envExample += `# Google OAuth\nGOOGLE_CLIENT_ID=${oauthClientId || 'your-client-id.apps.googleusercontent.com'}\nGOOGLE_CLIENT_SECRET=${oauthClientSecret || 'your-client-secret'}\nREDIRECT_URI=${oauthRedirectUri || 'https://your-dashboard.vercel.app/auth/callback'}\nGOOGLE_REFRESH_TOKEN=# Get this by visiting /setup after deploying\n`;
    } else {
      envExample += `# Google Service Account\nGOOGLE_SERVICE_ACCOUNT_EMAIL=momentum-dashboard@momentum-digital-506700.iam.gserviceaccount.com\nGOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nYOUR_KEY_HERE\\n-----END PRIVATE KEY-----\\n"\n`;
    }
    if (useWC) envExample += `\n# WhatConverts\nWHATCONVERTS_TOKEN=your_token\nWHATCONVERTS_SECRET=your_secret\n`;
    if (useDashboardLogin || useDocs) {
      envExample += `\n# Supabase\nSUPABASE_URL=${supabaseUrl || 'https://xxxx.supabase.co'}\nSUPABASE_SERVICE_KEY=your_service_key\n`;
    }
    if (useDocs) {
      envExample += `\n# Google OAuth (for Document Review)\nGOOGLE_CLIENT_ID=your_client_id\nGOOGLE_CLIENT_SECRET=your_client_secret\nREDIRECT_URI=${redirectUri || `https://${slug}-dashboard.vercel.app/auth/callback`}\n`;
    }
    envExample += `\nSESSION_SECRET=${slug}-change-this-to-random-string\n`;

    // ── Supabase SQL ──────────────────────────────────────────────────────
    let supabaseSql = `-- ${clientName} Dashboard — Supabase Setup\n-- Run this in the Supabase SQL Editor\n\n`;

    if (useDashboardLogin) {
      supabaseSql += `-- Dashboard Users (email/password login)\nCREATE TABLE dashboard_users (\n  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,\n  email TEXT UNIQUE NOT NULL,\n  password_hash TEXT NOT NULL,\n  name TEXT,\n  role TEXT DEFAULT 'viewer',\n  created_at TIMESTAMPTZ DEFAULT NOW()\n);\nALTER TABLE dashboard_users ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "service_role_all" ON dashboard_users FOR ALL USING (true);\nGRANT ALL ON dashboard_users TO service_role;\n\n-- Add users (password: Momentum2026! — change after first login)\n-- Generate bcrypt hashes at: https://bcrypt-generator.com\n-- INSERT INTO dashboard_users (email, name, role, password_hash) VALUES\n-- ('user@email.com', 'Name', 'viewer', 'bcrypt_hash_here');\n\n`;
    }

    if (useDocs) {
      supabaseSql += `-- Document Review Portal\nCREATE TABLE documents (\n  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,\n  title TEXT NOT NULL,\n  google_doc_url TEXT NOT NULL,\n  description TEXT,\n  status TEXT DEFAULT 'pending',\n  created_by TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT NOW(),\n  updated_at TIMESTAMPTZ DEFAULT NOW()\n);\nCREATE TABLE comments (\n  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,\n  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,\n  author_email TEXT NOT NULL,\n  author_name TEXT,\n  body TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT NOW()\n);\nCREATE TABLE allowed_reviewers (\n  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,\n  email TEXT UNIQUE NOT NULL,\n  name TEXT,\n  role TEXT DEFAULT 'reviewer',\n  added_at TIMESTAMPTZ DEFAULT NOW()\n);\nALTER TABLE documents ENABLE ROW LEVEL SECURITY;\nALTER TABLE comments ENABLE ROW LEVEL SECURITY;\nALTER TABLE allowed_reviewers ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "service_role_all" ON documents FOR ALL USING (true);\nCREATE POLICY "service_role_all" ON comments FOR ALL USING (true);\nCREATE POLICY "service_role_all" ON allowed_reviewers FOR ALL USING (true);\nGRANT ALL ON documents TO service_role;\nGRANT ALL ON comments TO service_role;\nGRANT ALL ON allowed_reviewers TO service_role;\n\n`;
    }

    // ── Sheet structure guide ─────────────────────────────────────────────
    let sheetGuide = '';
    if (useSheets && sheetColumns?.length) {
      const colLetters = sheetColumns.map((c, i) => `| ${String.fromCharCode(68 + i)} | ${c.label} | ${c.type} |`).join('\n');
      sheetGuide = `\n## Google Sheet Structure (${sheetTab})\n\n| Column | Label | Type |\n|--------|-------|------|\n| A | Date (e.g. 8/1-8/6) | text |\n| B | Week Start (YYYY-MM-DD) | date |\n| C | Week End (YYYY-MM-DD) | date |\n${colLetters}\n\nNewest row at top (row 2). Dashboard filters by Week End date.\n`;
    }

    if (useGMB) {
      sheetGuide += `\n## Google Business Profile Sheet (gmb_data tab)\n\nExport from Agency Analytics Google Sheets add-on:\n- Integration: Google Business Profile\n- View: Location Analytics\n- Dimension: Date\n- Metrics: Impressions, Interactions, Website Clicks, Call Clicks, Direction Requests, all Impression breakdowns\n- Row Limit: All\n`;
    }

    // ── README ────────────────────────────────────────────────────────────
    const readme = `# ${clientName} Analytics Dashboard

Generated by ${agency} Dashboard Generator

## Quick Start

\`\`\`bash
npm install
node server.js
\`\`\`

Open: http://localhost:3000

## Vercel Deployment

1. Push this folder to a new GitHub repo
2. Import repo in Vercel — Framework: **Other**
3. Add all environment variables from \`.env.example\`
4. Deploy

## Data Sources
${useGA4 ? `- ✅ Google Analytics 4 (Property: ${ga4PropertyId})` : '- ❌ GA4 not enabled'}
${useGSC ? `- ✅ Search Console (${gscSiteUrl})` : '- ❌ GSC not enabled'}
${useWC ? `- ✅ WhatConverts (Profile: ${wcProfileId})` : '- ❌ WhatConverts not enabled'}
${useSheets ? `- ✅ Google Sheets (Tab: ${sheetTab})` : '- ❌ Google Sheets not enabled'}
${useGMB ? '- ✅ Google Business Profile (via Sheets gmb_data tab)' : '- ❌ GBP not enabled'}
${useDocs ? '- ✅ Document Review Portal' : '- ❌ Document Review not enabled'}
${useDashboardLogin ? '- ✅ Dashboard Login (email/password)' : '- ❌ No dashboard login (public)'}
${sheetGuide}
## Service Account Access

Grant \`GOOGLE_SERVICE_ACCOUNT_EMAIL\` access to:
- GA4: Admin → Account Access Management → Viewer
- GSC: Settings → Users and permissions → Full
- Google Sheet: Share → Viewer

---
Generated by ${agency} · ${new Date().toLocaleDateString()}
`;

    const gitignore = `# Environment & secrets
.env
private-key.pem
*-service-account*.json
node_modules/
layout.json
`;

    res.json({
      ok: true,
      slug,
      files: {
        'server.js': serverJs,
        'public/index.html': indexHtml,
        'package.json': packageJson,
        'vercel.json': vercelJson,
        '.env.example': envExample,
        '.gitignore': gitignore,
        'supabase-setup.sql': (useDashboardLogin || useDocs) ? supabaseSql : null,
        'README.md': readme
      }
    });

  } catch (e) {
    console.error('Generate error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hexToRgb(hex) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1],16), g: parseInt(r[2],16), b: parseInt(r[3],16) } : null;
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`\n✅ Generator running at http://localhost:${PORT}\n`));
module.exports = app;
