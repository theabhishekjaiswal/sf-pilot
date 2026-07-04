/**
 * SF Pilot v4.0.0 — Content Script
 *
 * Simpler, Faster, Record-Only Navigation:
 *   - Only runs and displays on Salesforce record pages.
 *   - Completely ignores List Views, Homes, Setup, and Metadata pages.
 *   - No subtree MutationObservers, preventing any screen freezing or page lag.
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

  // ─── Constants ────────────────────────────────────────────────────────────

  const APP_OBJECT = 'genesis__Applications__c';
  const PARTY_OBJECT = 'clcommon__Party__c';
  const TOOLBAR_ID = 'sf-navigator-root';
  const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

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
    const lexMatch = pathname.match(/\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (lexMatch) {
      return {
        objectType: lexMatch[1],
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
    const apexMatch = pathname.match(/\/apex\/([^/?#]+)/i);
    const idParam = searchParams.get('id');
    if (apexMatch && idParam && SF_ID_RE.test(idParam)) {
      const objectType = VF_PAGE_MAP[apexMatch[1].toLowerCase()] || null;
      return {
        objectType,
        recordId: idParam,
        isLightning: onLEX,
        isRecordPage: true,
      };
    }

    // 4. Generic ?id= fallback
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
      const url = `${getApiBaseUrl()}/services/data/v59.0/ui-api/records/${recordId}?fields=Id`;
      const data = await bgFetch(url);
      return (data && data.apiName) || null;
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
        `SELECT Id FROM clcommon__Party__c WHERE genesis__Application__c = '${appId}' LIMIT 1`
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
    classic: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
    lightning: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    nooverride: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
    account: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    contact: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    party: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    openall: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
    logo: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
    spinner: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
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
    sideBtn.title = isMac ? 'SF Pilot Search (Option+Space or click)' : 'SF Pilot Search (Ctrl+Space or click)';
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
        </div>
        <div class="sfp-results-list"></div>
        <div class="sfp-search-footer">
          SF Pilot <span class="sfp-heart">♥</span> Made with love by <a href="https://www.linkedin.com/in/theabhishekjaiswal12/" target="_blank" class="sfp-author">Abhishek Jaiswal</a>
        </div>
      </div>
    `;

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSearchModal();
    });

    const input = modal.querySelector('.sfp-search-input');
    input.addEventListener('input', handleSearchInput);
    input.addEventListener('keydown', handleSearchKeydown);

    document.documentElement.appendChild(modal);
  }

  async function openSearchModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.add('sfp-modal--open');

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
    if (modal) modal.classList.remove('sfp-modal--open');
  }

  function getObjectsList() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'sfGetObjects', baseUrl: getApiBaseUrl() }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp && resp.ok) return resolve(resp.data || []);
        reject(new Error((resp && resp.error) || 'Unknown error'));
      });
    });
  }

  function handleSearchInput(e) {
    const query = e.target.value.toLowerCase().trim();
    activeIndex = -1;

    if (!query) {
      filteredObjects = objectsList.slice(0, 50);
      renderResults();
      return;
    }

    filteredObjects = objectsList.filter(o =>
      o.label.toLowerCase().includes(query) ||
      o.name.toLowerCase().includes(query)
    );

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
        openObjectInClassic(items[activeIndex].getAttribute('data-name'));
      } else if (items.length > 0) {
        openObjectInClassic(items[0].getAttribute('data-name'));
      }
    }
  }

  function renderLoading() {
    const listDiv = document.querySelector(`#${MODAL_ID} .sfp-results-list`);
    if (!listDiv) return;
    listDiv.innerHTML = `
      <div class="sfp-info-text">
        <span class="sfp-spinner-mini">${ICONS.spinner}</span>
        <span>Loading sObjects from metadata...</span>
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
        const tagClass = `sfp-tag--${o.type.toLowerCase()}`;
        return `
          <div class="sfp-result-item" data-index="${idx}" data-name="${o.name}">
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
        openObjectInClassic(item.getAttribute('data-name'));
      });
    });
  }

  function openObjectInClassic(objectName) {
    closeSearchModal();
    const obj = objectsList.find(o => o.name === objectName);

    // Handle static shortcuts — open dynamic URL on the current org's Classic domain
    if (obj && obj.type === 'Shortcut') {
      openClassicUrl(getClassicBase() + obj.setupId);
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
      } else if (obj.type === 'Setting') {
        // Custom Setting setup (durable ID points to standard Custom Object editor)
        if (obj.setupId) {
          const setupId15 = obj.setupId.substring(0, 15);
          destination = `${setupId15}?setupid=CustomObjects`;
        } else {
          destination = 'setup/ui/customsettings.jsp';
        }
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

  // Global Keyboard Shortcut (Option+Space on Mac, Ctrl+Space on Windows to toggle Search Panel)
  window.addEventListener('keydown', (e) => {
    const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);
    const isHotkey = isMac
      ? (e.altKey && e.code === 'Space') // Option + Space on Mac
      : (e.ctrlKey && e.code === 'Space'); // Ctrl + Space on Windows/Linux

    if (isHotkey) {
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
    // 1. Render always-visible Side Panel
    initSidePanel();

    // 2. Parse record page details
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