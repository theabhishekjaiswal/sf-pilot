/**
 * SF Pilot v3.1.0 — Content Script
 *
 * Improvements in 3.1.0:
 *   - initSidePanel() always runs on every Salesforce page (not just record pages).
 *   - Ctrl+K / Cmd+K also opens Metadata Search (in addition to Ctrl+Space / Option+Space).
 *   - Broader VF page detection: any /apex/ URL with a valid ?id= is treated as a record page.
 *   - Static Resource added to Metadata Search filter.
 *   - Filter dropdown replaced with a clean native <select>.
 */

(function () {
  'use strict';

  // ─── Guard: skip public portals, logins, and API paths ───────────────────

  const hostname = window.location.hostname.toLowerCase();
  const publicSalesforceDomains = [
    'developer.salesforce.com',
    'trailhead.salesforce.com',
    'help.salesforce.com',
    'trust.salesforce.com',
    'appexchange.salesforce.com',
    'login.salesforce.com',
    'test.salesforce.com',
    'success.salesforce.com',
    'compliance.salesforce.com',
    'status.salesforce.com',
    'www.salesforce.com'
  ];

  if (publicSalesforceDomains.includes(hostname) || /^\/(secur\/|login|services\/|oauth2\/|setup\/secur)/i.test(window.location.pathname)) {
    return;
  }

  // ─── Guard: skip customer-facing Experience Cloud portals ─────────────────
  // On my.site.com and salesforce-experience.com we only activate inside the
  // Experience Builder / Community Setup admin context — NOT on customer portals.
  const isExperienceDomain = hostname.endsWith('.my.site.com') || hostname.endsWith('.salesforce-experience.com');
  if (isExperienceDomain) {
    const path = window.location.pathname + window.location.hash;
    const isBuilderContext = /communitySetup|cwApp|picasso|commeditor|sfsites\/picasso/i.test(path);
    if (!isBuilderContext) {
      return; // Customer-facing portal — do not inject
    }
  }

  // ─── Constants ────────────────────────────────────────────────────────────

  const APP_OBJECT = 'genesis__Applications__c';
  const PARTY_OBJECT = 'clcommon__Party__c';
  const TOOLBAR_ID = 'sf-navigator-root';
  const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

  // Per-page-load hide flag — reset to false on every full page refresh
  // (module-level variables reset when content script re-executes on refresh)
  let toolbarHiddenThisLoad = false;

  // ─── Key prefix → object type (for Classic record IDs) ───────────────────

  const KEY_PREFIX = {
    '001': 'Account',
    '003': 'Contact',
    '006': 'Opportunity',
    '00Q': 'Lead',
    '500': 'Case',
    '00T': 'Task',
    '00U': 'Event',
    '01Z': 'Report',
    '00D': 'Organization',
  };

  // ─── VF page name → SObject type ─────────────────────────────────────────

  const VF_PAGE_MAP = {
    'applicationdetails': APP_OBJECT,
    'application_details': APP_OBJECT,
    'applicationdetail': APP_OBJECT,
    'genesisapplication': APP_OBJECT,
    'applicationform': APP_OBJECT,
    'genesis_application': APP_OBJECT,
  };

  // ─── Domain helpers ───────────────────────────────────────────────────────

  function getApiBaseUrl() {
    return `${window.location.protocol}//${window.location.hostname}`;
  }

  function isOnLightningDomain() {
    return window.location.hostname.includes('.lightning.force.com');
  }

  function getClassicBase() {
    const { protocol, hostname } = window.location;
    let h = hostname;
    if (h.includes('.lightning.force.com')) {
      h = h.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
    } else if (h.includes('.salesforce-setup.com')) {
      h = h.replace(/\.salesforce-setup\.com$/, '.salesforce.com');
    }
    return `${protocol}//${h}`;
  }

  function getLightningBase() {
    const { protocol, hostname } = window.location;
    if (hostname.includes('.lightning.force.com')) return `${protocol}//${hostname}`;
    let h = hostname;
    if (h.includes('.salesforce-setup.com')) {
      h = h.replace(/\.salesforce-setup\.com$/, '.salesforce.com');
    }
    h = h.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
    return `${protocol}//${h}`;
  }

  // ─── Background API bridge ────────────────────────────────────────────────

  function bgQuery(query) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'sfQuery', baseUrl: getApiBaseUrl(), query },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (resp && resp.ok) return resolve(resp.data);
          reject(new Error((resp && resp.error) || 'Unknown error'));
        }
      );
    });
  }

  function bgFetch(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'sfFetch', url, baseUrl: getApiBaseUrl() },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (resp && resp.ok) return resolve(resp.data);
          reject(new Error((resp && resp.error) || 'Unknown error'));
        }
      );
    });
  }

  // ─── Page / record detection ──────────────────────────────────────────────

  function objectTypeFromId(id) {
    return (id && id.length >= 3) ? (KEY_PREFIX[id.substring(0, 3)] || null) : null;
  }

  /**
   * Parse current page context. Returns { objectType, recordId, isLightning, isRecordPage }
   * Returns null if the current page is not a record page.
   */
  function parsePage() {
    const { pathname, searchParams } = new URL(window.location.href);
    const onLEX = isOnLightningDomain();

    // 1. Lightning record:  /lightning/r/{ObjectApiName}/{RecordId}/...
    // The ObjectApiName is sometimes omitted (e.g. /lightning/r/001.../view)
    const lexMatch = pathname.match(/\/lightning\/r\/(?:([^/]+)\/)?([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (lexMatch) {
      return {
        objectType: lexMatch[1] || null,
        recordId: lexMatch[2],
        isLightning: true,
        isRecordPage: true,
      };
    }

    // 2. Classic record path:  /{RecordId}
    const classicMatch = pathname.match(/^\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (classicMatch) {
      const id = classicMatch[1];
      if (/^(setup|lightning|apex|visualforce|servlet|secur|partners)/i.test(id)) {
        return null;
      }
      // Skip setup/metadata ID prefixes
      if (/^(01I|01M|01p|01q|01s|01u|0A2|0to|04G|02a)/.test(id)) {
        return null;
      }
      return {
        objectType: objectTypeFromId(id),
        recordId: id,
        isLightning: false,
        isRecordPage: true,
      };
    }

    // 3. Apex / Visualforce:  /apex/{PageName}?id={RecordId}
    //    Simplified: any VF page with a valid Salesforce ID in ?id= / ?recordId= is treated as a
    //    record page. objectType is resolved dynamically if not found in VF_PAGE_MAP.
    const apexMatch = pathname.match(/\/apex\/([^/?#]+)/i);
    const idParam = searchParams.get('id') || searchParams.get('recordId') || searchParams.get('c__recordId');
    if (apexMatch && idParam && SF_ID_RE.test(idParam)) {
      // Skip metadata/setup record IDs on VF pages
      if (/^(01I|01M|01p|01q|01s|01u|0A2|0to|04G|02a)/.test(idParam)) {
        return null;
      }
      // Look up objectType from map first, fall back to key-prefix lookup, then API resolve
      const objectType = VF_PAGE_MAP[apexMatch[1].toLowerCase()] || objectTypeFromId(idParam) || null;
      return {
        objectType,
        recordId: idParam,
        isLightning: onLEX,
        isRecordPage: true,
      };
    }

    // 4. Generic ?id= fallback (any page with a valid SF ID, not just /apex/)
    if (idParam && SF_ID_RE.test(idParam)) {
      if (/^(01I|01M|01p|01q|01s|01u|0A2|0to|04G|02a)/.test(idParam)) {
        return null;
      }
      return {
        objectType: objectTypeFromId(idParam),
        recordId: idParam,
        isLightning: onLEX,
        isRecordPage: true,
      };
    }

    return null;
  }

  // ─── Object type resolver ─────────────────────────────────────────────────

  async function resolveObjectType(recordId) {
    try {
      const prefix = recordId.substring(0, 3);
      const query = `SELECT QualifiedApiName FROM EntityDefinition WHERE KeyPrefix = '${prefix}' LIMIT 1`;

      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'sfQuery', query: query, baseUrl: getApiBaseUrl() }, resolve);
      });

      if (resp && resp.ok && resp.data && resp.data.records && resp.data.records.length > 0) {
        return resp.data.records[0].QualifiedApiName;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ─── URL builders ─────────────────────────────────────────────────────────

  function noOverrideUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('sfdc.override');
    url.searchParams.delete('sfdc_override');
    url.searchParams.set('nooverride', '1');
    return url.toString();
  }

  function switchToClassicUrl(page) {
    const classicBase = getClassicBase();
    if (page && page.recordId) {
      return `${classicBase}/${page.recordId}`;
    }
    return classicBase;
  }

  function switchToLightningUrl(page) {
    const lightningBase = getLightningBase();
    if (page && page.recordId) {
      if (page.objectType) {
        return `${lightningBase}/lightning/r/${page.objectType}/${page.recordId}/view`;
      }
      return `${lightningBase}/one/one.app#/sObject/${page.recordId}/view`;
    }
    return lightningBase;
  }

  function relatedRecordUrl(id, inLightning, objectType) {
    if (!id) return null;
    if (inLightning) {
      if (objectType) {
        return `${getLightningBase()}/lightning/r/${objectType}/${id}/view`;
      }
      return `${getLightningBase()}/one/one.app#/sObject/${id}/view`;
    }
    return `${getClassicBase()}/${id}`;
  }

  function openClassicUrl(targetUrl) {
    window.open(targetUrl, '_blank');
  }

  function openLightningUrl(targetUrl) {
    window.open(targetUrl, '_blank');
  }

  // ─── Application data fetcher ─────────────────────────────────────────────

  async function fetchAppData(appId) {
    const result = { accountId: null, contactId: null, partyId: null, error: false };

    try {
      const data = await bgQuery(
        `SELECT genesis__Account__c, genesis__Contact__c FROM genesis__Applications__c WHERE Id = '${appId}'`
      );
      if (data.records && data.records.length > 0) {
        result.accountId = data.records[0].genesis__Account__c || null;
        result.contactId = data.records[0].genesis__Contact__c || null;
      }
    } catch (e) {
      console.warn('[SF Navigator] Account/Contact query failed:', e.message);
      result.error = true;
    }

    try {
      const data = await bgQuery(
        `SELECT Id FROM clcommon__Party__c WHERE genesis__Application__c = '${appId}' AND clcommon__Type__r.Name ='BORROWER' LIMIT 1`
      );
      if (data.records && data.records.length > 0) {
        result.partyId = data.records[0].Id || null;
      }
    } catch (e) {
      console.warn('[SF Navigator] Party query failed:', e.message);
    }

    return result;
  }

  // ─── SVG Icons ────────────────────────────────────────────────────────────

  const ICONS = {
    refresh: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21v-5h5"/></svg>`,
    classic: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
    lightning: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    nooverride: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
    account: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    database: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`,
    database: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`,
    contact: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    party: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    openall: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
    logo: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    spinner: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
    hide: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    gear: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  };

  // ─── DOM utilities ────────────────────────────────────────────────────────

  function makeButton({ id, icon, label, tooltip, variant, active, disabled, onClick }) {
    const btn = document.createElement('button');
    btn.id = `sfn-btn-${id}`;
    btn.className = `sfn-btn sfn-btn--${variant}${active ? ' sfn-btn--active' : ''}`;
    btn.setAttribute('data-tooltip', tooltip);
    btn.innerHTML = `<span class="sfn-btn-icon">${icon}</span><span class="sfn-btn-label">${label}</span>`;
    if (disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', onClick);
    }
    return btn;
  }

  function setLoading(btn, on) {
    if (on) {
      btn._origIcon = btn.querySelector('.sfn-btn-icon').innerHTML;
      btn.classList.add('sfn-loading');
      btn.querySelector('.sfn-btn-icon').innerHTML = ICONS.spinner;
    } else {
      btn.classList.remove('sfn-loading');
      if (btn._origIcon) btn.querySelector('.sfn-btn-icon').innerHTML = btn._origIcon;
    }
  }

  function markDisabled(btn, tooltip) {
    btn.disabled = true;
    if (tooltip) btn.setAttribute('data-tooltip', tooltip);
  }

  function createDivider() {
    const d = document.createElement('div');
    d.className = 'sfn-divider';
    return d;
  }

  // ─── Toolbar builder ──────────────────────────────────────────────────────

  function buildToolbar(page, appData, isLoading) {
    const isApp = page && page.objectType === APP_OBJECT;
    const onLEX = page ? page.isLightning : isOnLightningDomain();

    const root = document.createElement('div');
    root.id = TOOLBAR_ID;

    const toolbar = document.createElement('div');
    toolbar.id = 'sf-navigator-toolbar';

    // Logo
    const logo = document.createElement('div');
    logo.className = 'sfn-logo';
    logo.title = 'SF Pilot — Made with ❤️ by Abhishek Jaiswal';
    logo.innerHTML = `<div class="sfn-logo-icon">${ICONS.logo}</div><span class="sfn-logo-text">SF Pilot</span>`;
    toolbar.appendChild(logo);

    // Classic button
    toolbar.appendChild(makeButton({
      id: 'classic',
      icon: ICONS.classic,
      label: 'Classic',
      tooltip: onLEX ? 'Open in Salesforce Classic' : 'Currently in Classic view',
      variant: 'classic',
      active: false,
      disabled: !onLEX,
      onClick: () => openClassicUrl(switchToClassicUrl(page)),
    }));

    // Lightning button
    toolbar.appendChild(makeButton({
      id: 'lightning',
      icon: ICONS.lightning,
      label: 'Lightning',
      tooltip: !onLEX ? 'Open in Lightning Experience' : 'Currently in Lightning view',
      variant: 'lightning',
      active: false,
      disabled: onLEX,
      onClick: () => openLightningUrl(switchToLightningUrl(page)),
    }));

    // Show All Data button (Salesforce Inspector Alternative)
    if (page && page.isRecordPage && page.recordId) {
      toolbar.appendChild(makeButton({
        id: 'showalldata',
        icon: ICONS.database,
        label: 'Data',
        tooltip: 'Show All Data',
        variant: 'party', // Gold variant looks nice for data
        onClick: () => {
          const extUrl = chrome.runtime.getURL(`src/pages/data/data.html?recordId=${page.recordId}&objectType=${page.objectType || ''}&host=${encodeURIComponent(getApiBaseUrl())}`);
          window.open(extUrl, '_blank');
        }
      }));
    }

    // ── Application-specific section ─────────────────────────────────────────
    if (isApp) {
      toolbar.appendChild(createDivider());

      // No Override
      toolbar.appendChild(makeButton({
        id: 'nooverride',
        icon: ICONS.nooverride,
        label: 'No Override',
        tooltip: 'Open with ?nooverride=1 (bypasses Visualforce page override)',
        variant: 'nooverride',
        onClick: () => window.open(noOverrideUrl(), '_blank'),
      }));

      // Account
      const accountBtn = makeButton({
        id: 'account',
        icon: ICONS.account,
        label: 'Account',
        tooltip: 'Open related Account in Classic',
        variant: 'account',
        onClick: () => {
          const url = relatedRecordUrl(appData && appData.accountId, false, 'Account');
          if (url) openClassicUrl(url);
        },
      });
      toolbar.appendChild(accountBtn);

      // Contact
      const contactBtn = makeButton({
        id: 'contact',
        icon: ICONS.contact,
        label: 'Contact',
        tooltip: 'Open related Contact in Classic',
        variant: 'contact',
        onClick: () => {
          const url = relatedRecordUrl(appData && appData.contactId, false, 'Contact');
          if (url) openClassicUrl(url);
        },
      });
      toolbar.appendChild(contactBtn);

      // Party
      const partyBtn = makeButton({
        id: 'party',
        icon: ICONS.party,
        label: 'Party',
        tooltip: 'Open related Party in Classic',
        variant: 'party',
        onClick: () => {
          const url = relatedRecordUrl(appData && appData.partyId, false, PARTY_OBJECT);
          if (url) openClassicUrl(url);
        },
      });
      toolbar.appendChild(partyBtn);

      toolbar.appendChild(createDivider());

      // Open All
      const openAllBtn = makeButton({
        id: 'openall',
        icon: ICONS.openall,
        label: 'Open All',
        tooltip: 'Open No Override + Account + Contact + Party in new tabs',
        variant: 'openall',
        onClick: () => {
          window.open(noOverrideUrl(), '_blank');
          const acc = relatedRecordUrl(appData && appData.accountId, false, 'Account');
          const con = relatedRecordUrl(appData && appData.contactId, false, 'Contact');
          const pty = relatedRecordUrl(appData && appData.partyId, false, PARTY_OBJECT);
          if (acc) openClassicUrl(acc);
          if (con) openClassicUrl(con);
          if (pty) openClassicUrl(pty);
        },
      });
      toolbar.appendChild(openAllBtn);

      // Status dot
      const dot = document.createElement('div');
      dot.id = 'sfn-status-dot';
      dot.className = `sfn-status-dot${isLoading ? ' sfn-status-dot--loading' : ''}`;
      dot.title = isLoading ? 'Loading related records…' : 'Records loaded';
      toolbar.appendChild(dot);

      // Apply loading / disabled states
      if (isLoading) {
        [accountBtn, contactBtn, partyBtn, openAllBtn].forEach((b) => setLoading(b, true));
      } else {
        if (!appData || !appData.accountId) {
          markDisabled(accountBtn, appData && appData.error
            ? 'Account lookup failed — check API Enabled permission'
            : 'No related Account found');
        }
        if (!appData || !appData.contactId) {
          markDisabled(contactBtn, appData && appData.error
            ? 'Contact lookup failed — check API Enabled permission'
            : 'No related Contact found');
        }
        if (!appData || !appData.partyId) {
          markDisabled(partyBtn, 'No related Party found');
        }
        if (appData && appData.error) {
          dot.classList.add('sfn-status-dot--error');
          dot.title = 'API error loading related records';
        }
      }
    }

    // Hide button (×) — hides toolbar for this page load only (resets on refresh)
    const hideBtn = document.createElement('button');
    hideBtn.id = 'sfn-btn-hide';
    hideBtn.className = 'sfn-hide-btn';
    hideBtn.setAttribute('data-tooltip', 'Hide toolbar (reappears on refresh)');
    hideBtn.innerHTML = ICONS.hide;
    hideBtn.addEventListener('click', () => {
      toolbarHiddenThisLoad = true;  // resets to false when page is refreshed
      const el = document.getElementById(TOOLBAR_ID);
      if (el) el.remove();
    });
    toolbar.appendChild(hideBtn);

    root.appendChild(toolbar);
    return root;
  }

  // ─── Rebranding & Side Search Panel (v5.0 Upgrade) ─────────────────────────

  const SIDE_BTN_ID = 'sfp-side-btn';
  const MODAL_ID = 'sfp-search-modal';

  // ─── Static shortcuts (always prepended to search results) ───────────────
  // Paths are appended to the current org's Classic base URL at runtime.

  const SHORTCUTS = [
    {
      label: 'Debug Logs',
      name: '__shortcut_debug_logs',
      type: 'Shortcut',
      setupId: '/setup/ui/listApexTraces.apexp?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DMonitoring&setupid=ApexDebugLogs'
    },
    {
      label: 'Developer Console',
      name: '__shortcut_developer_console',
      type: 'Shortcut',
      setupId: '/_ui/common/apex/debug/ApexCSIPage'
    },
    {
      label: 'Digital Experience',
      name: '__shortcut_digital_experience',
      type: 'Shortcut',
      setupId: '/_ui/networks/setup/SetupNetworksPage?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DNetworks&setupid=SetupNetworks'
    },
    {
      label: 'Apex Jobs',
      name: '__shortcut_apex_jobs',
      type: 'Shortcut',
      setupId: '/apexpages/setup/listAsyncApexJobs.apexp?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DMonitoring&setupid=AsyncApexJobs'
    },
    {
      label: 'Users',
      name: '__shortcut_users',
      type: 'Shortcut',
      setupId: '/005?isUserEntityOverride=1&retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DUsers&setupid=ManageUsers'
    },
    {
      label: 'Profiles',
      name: '__shortcut_profiles',
      type: 'Shortcut',
      setupId: '/00e?setupid=EnhancedProfiles&retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DUsers'
    },
    {
      label: 'Permission Sets',
      name: '__shortcut_permission_sets',
      type: 'Shortcut',
      setupId: '/_ui/perms/ui/setup/PermissionSetLightningPage?setupid=PermissionSetListView&retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DUsers'
    },
    {
      label: 'Permission Set Groups',
      name: '__shortcut_permission_set_groups',
      type: 'Shortcut',
      setupId: '/_ui/perms/ui/setup/PermSetGroupsPage?setupid=PermSetGroups&retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DUsers'
    },
    {
      label: 'Connected Apps',
      name: '__shortcut_connected_apps',
      type: 'Shortcut',
      setupId: '/app/mgmt/forceconnectedapps/forceInstalledConnectedAppList.apexp?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DManageApps&setupid=ConnectedApplication'
    },
    {
      label: 'Queues',
      name: '__shortcut_queues',
      type: 'Shortcut',
      setupId: '/p/own/OrgQueuesPage/d?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DUsers&setupid=Queues'
    },
    {
      label: 'Objects',
      name: '__shortcut_objects',
      type: 'Shortcut',
      setupId: '/p/setup/custent/CustomObjectsPage?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DDevTools&setupid=CustomObjects'
    },
    {
      label: 'Custom Labels',
      name: '__shortcut_custom_labels',
      type: 'Shortcut',
      setupId: '/101?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DDevTools&setupid=ExternalStrings'
    },
    {
      label: 'Custom Metadatas',
      name: '__shortcut_custom_metadatas',
      type: 'Shortcut',
      setupId: '/_ui/platform/ui/schema/wizard/entity/CustomMetadataTypeListPage?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DDevToolsIntegrate&setupid=CustomMetadata'
    },
    {
      label: 'Custom Settings',
      name: '__shortcut_custom_settings',
      type: 'Shortcut',
      setupId: '/setup/ui/listCustomSettings.apexp?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DDevToolsIntegrate&setupid=CustomSettings'
    },
    {
      label: 'Static Resources',
      name: '__shortcut_static_resources',
      type: 'Shortcut',
      setupId: '/apexpages/setup/listStaticResource.apexp?retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DDevToolsIntegrate&setupid=StaticResources'
    },
    {
      label: 'Flows',
      name: '__shortcut_flows',
      type: 'Shortcut',
      setupId: '/300?setupid=InteractionProcesses&retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DWorkflow'
    },
    {
      label: 'Platform Events',
      name: '__shortcut_platform_events',
      type: 'Shortcut',
      setupId: '/p/setup/custent/EventObjectsPage?setupid=EventObjects&retURL=%2Fui%2Fsetup%2FSetup%3Fsetupid%3DDevToolsIntegrate'
    },
  ];

  let objectsList = [];
  let filteredObjects = [];
  let activeIndex = -1;

  function initSidePanel() {
    if (document.getElementById(SIDE_BTN_ID)) return;
    if (!document.documentElement) return;

    // Check if user is on macOS
    const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);

    // 1. Create Side Faded Button
    const sideBtn = document.createElement('div');
    sideBtn.id = SIDE_BTN_ID;
    sideBtn.title = isMac ? 'SF Pilot Search (⌘K or Option+Space)' : 'SF Pilot Search (Ctrl+K or Ctrl+Space)';
    sideBtn.innerHTML = `<span class="sfp-side-icon">${ICONS.logo}</span>`;
    sideBtn.addEventListener('click', openSearchModal);
    document.documentElement.appendChild(sideBtn);

    // 2. Create Modal Structure
    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="sfp-search-panel">
        <div class="sfp-search-input-wrapper">
          <div class="sfp-search-icon-inside">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </div>
          <input type="text" class="sfp-search-input" placeholder="Search anything..." autocomplete="off">
          <select class="sfp-type-select" id="sfp-type-select">
            <option value="All">All Types</option>
            <option value="Object">Object / Metadata / Setting</option>
            <option value="Tab">Tab</option>
            <option value="Label">Custom Label</option>
            <option value="Page">Visualforce Page</option>
            <option value="Flow">Flow</option>
            <option value="StaticResource">Static Resource</option>
            <option value="Shortcut">Shortcut</option>
            <option value="PlatformEvent">Platform Event</option>
            <option value="Class">Apex Class</option>
            <option value="Trigger">Apex Trigger</option>
            <option value="Profile">Profile</option>
            <option value="Permission Set">Permission Set</option>
          </select>
        </div>
        <div class="sfp-results-list"></div>
        <div class="sfp-settings-panel" id="sfp-settings-panel" style="display:none;">
          <div class="sfp-settings-row">
            <span class="sfp-settings-label">Show Navigation Bar</span>
            <label class="sfp-toggle">
              <input type="checkbox" id="sfp-toggle-navbar" checked>
              <span class="sfp-toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="sfp-search-footer">
          <div class="sfp-footer-brand">
            SF Pilot <span class="sfp-heart">♥</span> Made with love by <a href="https://www.linkedin.com/in/theabhishekjaiswal12/" target="_blank" class="sfp-author">Abhishek Jaiswal</a>
          </div>
          <div class="sfp-footer-actions">
            <button class="sfp-action-btn" id="sfp-refresh-btn" title="Refresh Metadata Cache">${ICONS.refresh}<span class="sfp-gear-label">Refresh</span></button>
            <button class="sfp-action-btn" id="sfp-gear-btn" title="Global Settings">${ICONS.gear}<span class="sfp-gear-label">Settings</span></button>
          </div>
        </div>
      </div>
    `;

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSearchModal();
    });

    const input = modal.querySelector('.sfp-search-input');

    // Native select filter logic
    const typeSelect = modal.querySelector('#sfp-type-select');
    typeSelect.addEventListener('change', () => handleSearchInput({ target: input }));

    input.addEventListener('input', handleSearchInput);
    input.addEventListener('keydown', handleSearchKeydown);

    // Settings gear toggle
    const gearBtn = modal.querySelector('#sfp-gear-btn');
    const refreshBtn = modal.querySelector('#sfp-refresh-btn');
    const settingsPanel = modal.querySelector('#sfp-settings-panel');
    const navbarToggle = modal.querySelector('#sfp-toggle-navbar');

    // Auto-close settings panel when clicking anywhere outside it
    modal.querySelector('.sfp-search-panel').addEventListener('click', (e) => {
      if (settingsPanel.style.display !== 'none') {
        const clickedInsideSettings = settingsPanel.contains(e.target);
        const clickedGear = gearBtn === e.target || gearBtn.contains(e.target);
        if (!clickedInsideSettings && !clickedGear) {
          settingsPanel.style.display = 'none';
        }
      }
    });

    gearBtn.addEventListener('click', async () => {
      const isOpen = settingsPanel.style.display !== 'none';
      if (isOpen) {
        settingsPanel.style.display = 'none';
      } else {
        // Read current value before showing
        const stored = await chrome.storage.local.get(['sfn_toolbar_enabled']);
        navbarToggle.checked = stored.sfn_toolbar_enabled !== false;
        settingsPanel.style.display = 'block';
      }
    });

    refreshBtn.addEventListener('click', async () => {
      if (refreshBtn.disabled) return;
      refreshBtn.disabled = true;
      const originalHtml = refreshBtn.innerHTML;
      refreshBtn.innerHTML = `${ICONS.spinner}<span class="sfp-gear-label">Refreshing...</span>`;

      // Show loading indicator in the main view while fetching
      renderLoading('Refreshing metadata from Salesforce');

      try {
        const list = await getObjectsList(true);
        objectsList = [...SHORTCUTS, ...list];
        // Re-filter using current input
        const inputEl = modal.querySelector('.sfp-search-input');
        if (inputEl) {
          handleSearchInput({ target: inputEl });
        }
      } catch (e) {
        if (e.message && e.message.includes('Extension context invalidated')) {
          renderError('Extension was updated. Auto-reloading page to reconnect...');
          setTimeout(() => window.location.reload(), 1500);
          return;
        }
        renderError('Refresh failed: ' + e.message);
      } finally {
        refreshBtn.innerHTML = originalHtml;
        refreshBtn.disabled = false;
      }
    });

    navbarToggle.addEventListener('change', async () => {
      await chrome.storage.local.set({ sfn_toolbar_enabled: navbarToggle.checked });
      if (!navbarToggle.checked) {
        // Remove toolbar immediately
        const el = document.getElementById(TOOLBAR_ID);
        if (el) el.remove();
      } else {
        // Reinject toolbar — also clear the session hide so it actually shows
        toolbarHiddenThisLoad = false;
        if (!document.getElementById(TOOLBAR_ID)) {
          init();
        }
      }
      // Auto-close settings panel after toggle so user sees the change take effect
      setTimeout(() => { settingsPanel.style.display = 'none'; }, 600);
    });

    document.documentElement.appendChild(modal);
  }

  async function openSearchModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.add('sfp-modal--open');

    // Always reset settings panel to hidden when modal opens
    const sp = modal.querySelector('#sfp-settings-panel');
    if (sp) sp.style.display = 'none';

    // Reset filter select to "All Types"
    const typeSelect = modal.querySelector('#sfp-type-select');
    if (typeSelect) typeSelect.value = 'All';

    const input = modal.querySelector('.sfp-search-input');
    input.value = '';
    input.focus();

    activeIndex = -1;
    filteredObjects = [];

    // Lazy load objects list if not cached locally
    if (objectsList.length === 0) {
      renderLoading();
      try {
        const list = await getObjectsList();
        objectsList = [...SHORTCUTS, ...list];
        filteredObjects = objectsList.slice(0, 50);
        renderResults();
      } catch (e) {
        renderError('Failed to load sObjects list.');
      }
    } else {
      filteredObjects = objectsList.slice(0, 50);
      renderResults();
    }
  }

  function closeSearchModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.remove('sfp-modal--open');
    // Reset settings panel when modal closes
    const sp = modal.querySelector('#sfp-settings-panel');
    if (sp) sp.style.display = 'none';
  }

  function getObjectsList(forceRefresh = false) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'sfGetObjects', baseUrl: getApiBaseUrl(), forceRefresh }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp && resp.ok) return resolve(resp.data || []);
        reject(new Error((resp && resp.error) || 'Unknown error'));
      });
    });
  }

  function handleSearchInput(e) {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    const input = modal.querySelector('.sfp-search-input');
    const typeSelect = modal.querySelector('#sfp-type-select');

    const query = input.value.toLowerCase().trim();
    const typeVal = (typeSelect && typeSelect.value) ? typeSelect.value : 'All';
    activeIndex = -1;

    let filtered = objectsList;

    // 1. Filter by Type
    if (typeVal !== 'All') {
      filtered = filtered.filter(o => {
        if (typeVal === 'Object') return o.type === 'Object' || o.type === 'Setting';
        return o.type === typeVal;
      });
    }


    // 2. Filter by Query (Fuzzy Match)
    if (query) {
      filtered = filtered.filter(o => {
        const lbl = o.label.toLowerCase();
        const nm = o.name.toLowerCase();

        // Exact substring match first for speed
        if (lbl.includes(query) || nm.includes(query)) return true;

        // Fuzzy Subsequence Match
        let pIdx = 0, sIdx = 0, pLen = query.length;

        // Check Label
        let sLen = lbl.length;
        while (pIdx < pLen && sIdx < sLen) {
          if (query.charCodeAt(pIdx) === lbl.charCodeAt(sIdx)) pIdx++;
          sIdx++;
        }
        if (pIdx === pLen) return true;

        // Check API Name
        pIdx = 0; sIdx = 0; sLen = nm.length;
        while (pIdx < pLen && sIdx < sLen) {
          if (query.charCodeAt(pIdx) === nm.charCodeAt(sIdx)) pIdx++;
          sIdx++;
        }
        return pIdx === pLen;
      });
    }

    filteredObjects = filtered.slice(0, 50);
    renderResults();
  }

  function handleSearchKeydown(e) {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    const listDiv = modal.querySelector('.sfp-results-list');
    const items = listDiv.querySelectorAll('.sfp-result-item');

    if (e.key === 'Escape') {
      closeSearchModal();
      e.preventDefault();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length === 0) return;
      if (activeIndex < items.length - 1) {
        if (activeIndex >= 0) items[activeIndex].classList.remove('sfp-item--active');
        activeIndex++;
        items[activeIndex].classList.add('sfp-item--active');
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      if (activeIndex > 0) {
        items[activeIndex].classList.remove('sfp-item--active');
        activeIndex--;
        items[activeIndex].classList.add('sfp-item--active');
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < items.length) {
        openObjectInClassic(items[activeIndex].getAttribute('data-name'), items[activeIndex].getAttribute('data-type'));
      } else if (items.length > 0) {
        openObjectInClassic(items[0].getAttribute('data-name'), items[0].getAttribute('data-type'));
      }
    }
  }

  function renderLoading(msg = 'Loading sObjects from metadata...') {
    const listDiv = document.querySelector(`#${MODAL_ID} .sfp-results-list`);
    if (!listDiv) return;
    listDiv.innerHTML = `
      <div class="sfp-info-text">
        <span class="sfp-spinner-mini">${ICONS.spinner}</span>
        <span>${escapeHtml(msg)}</span>
      </div>
    `;
  }

  function renderError(msg) {
    const listDiv = document.querySelector(`#${MODAL_ID} .sfp-results-list`);
    if (!listDiv) return;
    listDiv.innerHTML = `
      <div class="sfp-info-text" style="color: #ea4335;">
        <span>Error: ${escapeHtml(msg)}</span>
      </div>
    `;
  }

  function renderError(msg) {
    const listDiv = document.querySelector(`#${MODAL_ID} .sfp-results-list`);
    if (!listDiv) return;
    listDiv.innerHTML = `<div class="sfp-info-text" style="color: #ef4444;">${msg}</div>`;
  }

  function renderResults() {
    const listDiv = document.querySelector(`#${MODAL_ID} .sfp-results-list`);
    if (!listDiv) return;

    if (filteredObjects.length === 0) {
      listDiv.innerHTML = `<div class="sfp-info-text">No matching records.</div>`;
      return;
    }

    listDiv.innerHTML = filteredObjects
      .slice(0, 60)
      .map((o, idx) => {
        const tagClass = `sfp-tag--${o.type.toLowerCase().replace(/\s+/g, '')}`;
        return `
          <div class="sfp-result-item" data-index="${idx}" data-name="${o.name}" data-type="${o.type}">
            <div class="sfp-item-left">
              <span class="sfp-item-label">${escapeHtml(o.label)}</span>
              <span class="sfp-item-name">${escapeHtml(o.name)}</span>
            </div>
            <span class="sfp-tag ${tagClass}">${escapeHtml(o.type)}</span>
          </div>
        `;
      }).join('');

    listDiv.querySelectorAll('.sfp-result-item').forEach(item => {
      item.addEventListener('click', () => {
        openObjectInClassic(item.getAttribute('data-name'), item.getAttribute('data-type'));
      });
    });
  }

  function openObjectInClassic(objectName, objectType) {
    closeSearchModal();
    const obj = objectsList.find(o => o.name === objectName && o.type === objectType);

    // Handle static shortcuts
    if (obj && obj.type === 'Shortcut') {
      if (obj.lightningPath) {
        // Some shortcuts have no Classic equivalent — open in Lightning
        window.open(getLightningBase() + obj.lightningPath, '_blank');
      } else {
        openClassicUrl(getClassicBase() + obj.setupId);
      }
      return;
    }

    // Handle Flows — open in Classic using FlowDefinition ID (e.g. /300dM...)
    if (obj && obj.type === 'Flow') {
      const url = `${getClassicBase()}/${obj.setupId}`;
      openClassicUrl(url);
      return;
    }

    // Handle Tabs — open Record List view in Classic
    if (obj && obj.type === 'Tab') {
      let url = `${getClassicBase()}/${obj.setupId}`; // fallback

      // Attempt to find the matching Object to extract its keyPrefix (e.g., "a00")
      let sObj = null;
      if (obj.sobjectName) {
        // Case-insensitive match on API name
        const targetName = obj.sobjectName.toLowerCase();
        sObj = objectsList.find(o => o.type === 'Object' && o.name.toLowerCase() === targetName);
      }

      // Fallback: For Custom Object Tabs, Salesforce TabDefinition DurableId is the 01I setup ID
      if (!sObj && obj.setupId && obj.setupId.startsWith('01I')) {
        const setupId15 = obj.setupId.substring(0, 15);
        sObj = objectsList.find(o => o.type === 'Object' && o.setupId && o.setupId.startsWith(setupId15));
      }

      if (sObj && sObj.keyPrefix) {
        url = `${getClassicBase()}/${sObj.keyPrefix}/o`;
      } else if (obj.tabUrl) {
        url = obj.tabUrl;
      } else if (obj.sobjectName) {
        // Ultimate Fallback: If Salesforce API fails to provide the 3-character keyPrefix for this object,
        // it is impossible to build the Classic URL. We must fallback to the Lightning URL format, 
        // which natively uses the API name instead of the keyPrefix. 
        // Salesforce will automatically redirect back to Classic if the user's settings require it.
        url = `${getLightningBase()}/lightning/o/${obj.sobjectName}/home`;
      }

      openClassicUrl(url);
      return;
    }

    let destination;
    if (obj) {
      if (obj.type === 'Object') {
        if (obj.custom) {
          const nameLower = objectName.toLowerCase();
          const isMetadataType = nameLower.endsWith('__mdt');
          if (obj.setupId) {
            const setupId15 = obj.setupId.substring(0, 15);
            if (isMetadataType) {
              destination = `${setupId15}?setupid=CustomMetadata`;
            } else {
              destination = `${setupId15}?setupid=CustomObjects`;
            }
          } else {
            if (isMetadataType) {
              destination = `01I?setupid=CustomMetadata`;
            } else {
              destination = `01I?setupid=CustomObjects`;
            }
          }
        } else {
          // Standard Object fields setup page
          destination = `p/setup/layout/LayoutFieldList?type=${objectName}`;
        }
      } else if (obj.type === 'PlatformEvent') {
        // Platform Events — open in Classic using the 01I setup entity ID
        // (Classic routes correctly given a real entity ID, same pattern as Flows)
        if (obj.setupId) {
          destination = obj.setupId.substring(0, 15);
        } else {
          // Fallback: open Platform Events list in Lightning Setup
          const url = `${getLightningBase()}/lightning/setup/EventDefinitions/home`;
          window.open(url, '_blank');
          return;
        }
      } else if (obj.type === 'Setting') {
        // Custom Setting setup (durable ID points to standard Custom Object editor)
        if (obj.setupId) {
          const setupId15 = obj.setupId.substring(0, 15);
          destination = `${setupId15}?setupid=CustomSettings`;
        } else {
          destination = 'setup/ui/customsettings.jsp';
        }
      } else if (obj.type === 'StaticResource') {
        // Static Resource — open detail page in Classic Setup
        if (obj.setupId) {
          destination = `${obj.setupId.substring(0, 15)}?setupid=StaticResources`;
        } else {
          destination = 'apexpages/setup/listStaticResource.apexp?setupid=StaticResources';
        }
      } else if (obj.type === 'Shortcut') {
        destination = obj.setupId;
      } else if (obj.type === 'Profile' || obj.type === 'Permission Set') {
        destination = obj.setupId;
      } else {
        // Apex Class, Apex Trigger, Visualforce Page, Custom Label setup detail page
        destination = obj.setupId;
      }
    } else {
      const nameLower = objectName.toLowerCase();
      if (nameLower.endsWith('__mdt')) {
        destination = `01I?setupid=CustomMetadata`;
      } else if (nameLower.endsWith('__c')) {
        destination = `01I?setupid=CustomObjects`;
      } else {
        destination = `p/setup/layout/LayoutFieldList?type=${objectName}`;
      }
    }

    const url = `${getClassicBase()}/${destination}`;
    openClassicUrl(url);
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Global Keyboard Shortcuts:
  //   Mac:     Option+Space  OR  Cmd+K
  //   Win/Lin: Ctrl+Space    OR  Ctrl+K
  window.addEventListener('keydown', (e) => {
    const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);

    const isSpaceHotkey = isMac
      ? (e.altKey && e.code === 'Space')   // Option + Space on Mac
      : (e.ctrlKey && e.code === 'Space'); // Ctrl + Space on Windows/Linux

    const isKHotkey = isMac
      ? (e.metaKey && e.code === 'KeyK')  // Cmd + K on Mac
      : (e.ctrlKey && e.code === 'KeyK'); // Ctrl + K on Windows/Linux

    if (isSpaceHotkey || isKHotkey) {
      e.preventDefault();
      const m = document.getElementById(MODAL_ID);
      if (m && m.classList.contains('sfp-modal--open')) {
        closeSearchModal();
      } else {
        openSearchModal();
      }
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────

  const _resolvedTypes = new Map();

  async function init() {
    // 1. Always render Side Panel (Metadata Search button) on every Salesforce page,
    //    regardless of whether we're on a record page or not.
    initSidePanel();

    // 2. Check global setting — if toolbar is disabled, skip rendering
    try {
      const stored = await chrome.storage.local.get(['sfn_toolbar_enabled']);
      if (stored.sfn_toolbar_enabled === false) {
        // Remove toolbar if it somehow exists
        const el = document.getElementById(TOOLBAR_ID);
        if (el) el.remove();
        return;
      }
    } catch (e) {
      // storage unavailable — continue normally
    }

    // 3. Check per-load hide flag (set when user clicks ×, resets on page refresh)
    if (toolbarHiddenThisLoad) {
      return;
    }

    // 4. Parse record page details — toolbar only appears on record pages
    const page = parsePage();
    if (!page) {
      const el = document.getElementById(TOOLBAR_ID);
      if (el) el.remove();
      return;
    }

    if (document.getElementById(TOOLBAR_ID)) return;
    if (!document.documentElement) return;

    // Render basic record toolbar
    document.documentElement.appendChild(buildToolbar(page, null, false));

    // Resolve object type if unknown
    if (page.recordId && !page.objectType) {
      const prefix = page.recordId.substring(0, 3);
      if (_resolvedTypes.has(prefix)) {
        page.objectType = _resolvedTypes.get(prefix);
      } else {
        const resolved = await resolveObjectType(page.recordId);
        if (resolved) {
          _resolvedTypes.set(prefix, resolved);
          page.objectType = resolved;
        }
      }
    }

    // Upgrade Application records
    if (page.objectType === APP_OBJECT) {
      const existing = document.getElementById(TOOLBAR_ID);
      if (!existing || location.href !== lastUrl) return;
      existing.remove();
      document.documentElement.appendChild(buildToolbar(page, null, true));

      const appData = await fetchAppData(page.recordId);

      const prev = document.getElementById(TOOLBAR_ID);
      if (!prev || location.href !== lastUrl) return;
      prev.remove();
      document.documentElement.appendChild(buildToolbar(page, appData, false));
    }
  }

  // ─── SPA / Lightning navigation ───────────────────────────────────────────

  let lastUrl = location.href;
  let _navTimer = null;
  let isNavigating = false;

  function onUrlChange() {
    const cur = location.href;
    if (cur === lastUrl) return;
    lastUrl = cur;

    isNavigating = true; // Block MutationObserver during SPA transition

    const el = document.getElementById(TOOLBAR_ID);
    if (el) el.remove();

    if (_navTimer) clearTimeout(_navTimer);
    _navTimer = setTimeout(() => {
      _navTimer = null;
      init().then(() => {
        isNavigating = false; // Unblock after init finishes
      }).catch(() => {
        isNavigating = false;
      });
    }, 450);
  }

  ['pushState', 'replaceState'].forEach((method) => {
    const orig = history[method];
    history[method] = function (...args) {
      orig.apply(this, args);
      onUrlChange();
    };
  });

  window.addEventListener('popstate', onUrlChange);

  // ─── MutationObserver: survive layout updates ──────────────────────────────

  let _reinjectTimer = null;

  function scheduleReinject() {
    if (_reinjectTimer) return;
    _reinjectTimer = setTimeout(() => {
      _reinjectTimer = null;
      if (location.href === lastUrl) {
        init();
      }
    }, 300);
  }

  const domObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      onUrlChange();
      return;
    }

    if (isNavigating) return; // Ignore mutations during navigation to prevent race loops

    if (document.getElementById(SIDE_BTN_ID) && document.getElementById(MODAL_ID)) {
      const page = parsePage();
      if (!page && document.getElementById(TOOLBAR_ID)) {
        document.getElementById(TOOLBAR_ID).remove();
        return;
      }
      if (page && !document.getElementById(TOOLBAR_ID)) {
        scheduleReinject();
      }
      return;
    }
    scheduleReinject();
  });

  domObserver.observe(document.documentElement, { childList: true });

  // ─── Periodic URL check ───────────────────────────────────────────────────

  setInterval(() => {
    if (location.href !== lastUrl) {
      onUrlChange();
    }
  }, 250);

  // ─── Boot ─────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();