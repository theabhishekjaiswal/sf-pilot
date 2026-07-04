/**
 * SF Navigator — Background Service Worker v2.3
 *
 * KEY FIX for INVALID_SESSION_ID in Lightning:
 *   The Salesforce REST API must be called on the my.salesforce.com (Classic)
 *   domain, even when the user is browsing Lightning (lightning.force.com).
 *   The `sid` cookie valid for REST API lives on my.salesforce.com.
 *
 *   So we ALWAYS:
 *     1. Convert the API base URL to my.salesforce.com
 *     2. Read the `sid` cookie from my.salesforce.com
 *     3. Make API requests to my.salesforce.com with Bearer {sid}
 *     4. Background host_permissions bypass CORS — no preflight issues.
 */

'use strict';

// Per-hostname API version cache (keyed by Classic hostname)
const apiVersionCache = new Map();
// Cache of sObject lists per hostname
const objectsCache = new Map();

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'sfQuery' || msg.type === 'sfFetch') {
    handleRequest(msg, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
  if (msg.type === 'sfGetObjects') {
    handleGetObjects(msg, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'sfGetSid') {
    handleGetSid(msg, sender)
      .then((sid) => sendResponse({ ok: true, sid }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ─── sObjects list handler ───────────────────────────────────────────────────

async function handleGetObjects(msg, sender) {
  const tabUrl = sender.tab && sender.tab.url ? new URL(sender.tab.url) : null;
  const rawBase = tabUrl ? `${tabUrl.protocol}//${tabUrl.hostname}` : (msg.baseUrl || '');
  const apiBase = toClassicBase(rawBase);
  const hostname = new URL(apiBase).hostname;

  if (objectsCache.has(hostname)) {
    return objectsCache.get(hostname);
  }

  const sid = await getSid(apiBase);
  const headers = { Accept: 'application/json' };
  if (sid) headers['Authorization'] = `Bearer ${sid}`;

  const ver = await getApiVersion(apiBase, headers);

  const customObjectIds = new Map();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s total timeout

  // 1. Tooling API query for CustomObject 01I Setup IDs (Parallel)
  const toolingPromise = (async () => {
    try {
      const customQueryUrl = `${apiBase}/services/data/${ver}/tooling/query?q=SELECT+Id,DeveloperName,NamespacePrefix+FROM+CustomObject`;
      const qResp = await fetch(customQueryUrl, { headers, signal: controller.signal });
      if (qResp.ok) {
        const qData = await qResp.json();
        if (qData && Array.isArray(qData.records)) {
          for (const r of qData.records) {
            const ns = r.NamespacePrefix ? `${r.NamespacePrefix}__` : '';
            const devName = r.DeveloperName || '';
            const baseApiName = ns + devName;

            // Map both standard custom objects (__c) and custom metadata (__mdt) in lowercase
            customObjectIds.set((baseApiName + '__c').toLowerCase(), r.Id);
            customObjectIds.set((baseApiName + '__mdt').toLowerCase(), r.Id);
          }
        }
      }
    } catch (e) {
      console.warn('[SF Pilot] CustomObject pre-fetch skipped or timed out:', e.message);
    }
  })();

  // 2. Fetch sObjects list (Parallel)
  const sobjectsPromise = (async () => {
    const url = `${apiBase}/services/data/${ver}/sobjects`;
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Failed to fetch objects: HTTP ${resp.status}`);
    }
    return resp.json();
  })();

  // 3. Fetch Apex Classes (Parallel)
  const classesPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/query?q=SELECT+Id,Name+FROM+ApexClass+WHERE+NamespacePrefix=null`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({ label: r.Name, name: r.Name, type: 'Class', setupId: r.Id }));
      }
    } catch (e) {
      console.warn('[SF Pilot] ApexClass fetch failed:', e.message);
    }
    return [];
  })();

  // 4. Fetch Apex Triggers (Parallel)
  const triggersPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/query?q=SELECT+Id,Name+FROM+ApexTrigger+WHERE+NamespacePrefix=null`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({ label: r.Name, name: r.Name, type: 'Trigger', setupId: r.Id }));
      }
    } catch (e) {
      console.warn('[SF Pilot] ApexTrigger fetch failed:', e.message);
    }
    return [];
  })();

  // 5. Fetch Visualforce Pages (Parallel)
  const pagesPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/query?q=SELECT+Id,Name+FROM+ApexPage+WHERE+NamespacePrefix=null`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({ label: r.Name, name: r.Name, type: 'Page', setupId: r.Id }));
      }
    } catch (e) {
      console.warn('[SF Pilot] ApexPage fetch failed:', e.message);
    }
    return [];
  })();

  // 6. Fetch Custom Labels via Tooling API (Parallel)
  const labelsPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/tooling/query?q=SELECT+Id,Name,MasterLabel+FROM+ExternalString+WHERE+NamespacePrefix=null`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({
          label: r.MasterLabel || r.Name,
          name: r.Name,
          type: 'Label',
          setupId: r.Id
        }));
      }
    } catch (e) {
      console.warn('[SF Pilot] Custom Label fetch failed:', e.message);
    }
    return [];
  })();

  // 7. Fetch Custom Settings (Parallel)
  const settingsPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/query?q=SELECT+DurableId,QualifiedApiName,Label+FROM+EntityDefinition+WHERE+IsCustomSetting=true+AND+NamespacePrefix=null`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({
          label: r.Label || r.QualifiedApiName,
          name: r.QualifiedApiName,
          type: 'Setting',
          setupId: r.DurableId
        }));
      }
    } catch (e) {
      console.warn('[SF Pilot] Custom Settings fetch failed:', e.message);
    }
    return [];
  })();

  try {
    const [_, data, classes, triggers, pages, labels, settings] = await Promise.all([
      toolingPromise,
      sobjectsPromise,
      classesPromise,
      triggersPromise,
      pagesPromise,
      labelsPromise,
      settingsPromise
    ]);

    const unifiedList = [];
    const customSettingsNames = new Set(settings.map(s => s.name.toLowerCase()));

    // Add sObjects (filter out Custom Settings to avoid double listing)
    if (data && Array.isArray(data.sobjects)) {
      const sobjects = data.sobjects
        .filter(o => {
          const nameLower = o.name.toLowerCase();
          return o.queryable && (o.layoutable || nameLower.endsWith('__mdt')) && !customSettingsNames.has(nameLower);
        })
        .map(o => {
          let setupId = null;
          if (o.custom) {
            setupId = customObjectIds.get(o.name.toLowerCase()) || null;
          } else {
            setupId = o.name;
          }
          return {
            label: o.label || '',
            name: o.name || '',
            type: 'Object',
            custom: o.custom,
            setupId: setupId
          };
        });
      unifiedList.push(...sobjects);
    }

    // Add Classes, Triggers, Pages, Labels, Settings
    unifiedList.push(...classes, ...triggers, ...pages, ...labels, ...settings);

    // Sort alphabetically by label name
    unifiedList.sort((a, b) => a.label.localeCompare(b.label));

    objectsCache.set(hostname, unifiedList);
    return unifiedList;
  } catch (e) {
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  return [];
}

async function handleGetSid(msg, sender) {
  const tabUrl = sender.tab && sender.tab.url ? new URL(sender.tab.url) : null;
  const rawBase = tabUrl ? `${tabUrl.protocol}//${tabUrl.hostname}` : (msg.baseUrl || '');
  const apiBase = toClassicBase(rawBase);
  return await getSid(apiBase);
}

// ─── Domain normalization ─────────────────────────────────────────────────────

/**
 * Always resolve to the Classic (my.salesforce.com) base URL for API calls.
 * The Salesforce REST API session cookie lives on the Classic domain.
 *
 *   myorg.lightning.force.com           → myorg.my.salesforce.com
 *   myorg.my.salesforce.com             → unchanged
 *   myorg--uat.sandbox.lightning.force.com → myorg--uat.sandbox.my.salesforce.com
 */
function toClassicBase(urlOrString) {
  const u = typeof urlOrString === 'string' ? new URL(urlOrString) : urlOrString;
  let hostname = u.hostname;
  if (hostname.includes('.lightning.force.com')) {
    hostname = hostname.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
  } else if (hostname.includes('.salesforce-setup.com')) {
    hostname = hostname.replace(/\.salesforce-setup\.com$/, '.salesforce.com');
  }
  return `${u.protocol}//${hostname}`;
}

// ─── Core request handler ─────────────────────────────────────────────────────

async function handleRequest(msg, sender) {
  // Derive the tab's origin (most reliable), fall back to message payload
  const tabUrl = sender.tab && sender.tab.url ? new URL(sender.tab.url) : null;
  const rawBase = tabUrl
    ? `${tabUrl.protocol}//${tabUrl.hostname}`
    : (msg.baseUrl || '');

  // ALWAYS use the Classic/My-Domain base for API calls regardless of which
  // domain the tab is currently on (Lightning or Classic).
  const apiBase = toClassicBase(rawBase);

  // Get session ID from the Classic domain cookie
  const sid = await getSid(apiBase);

  const headers = { Accept: 'application/json' };
  if (sid) headers['Authorization'] = `Bearer ${sid}`;

  let url;
  if (msg.type === 'sfQuery') {
    const ver = await getApiVersion(apiBase, headers);
    url = `${apiBase}/services/data/${ver}/query?q=${encodeURIComponent(msg.query)}`;
  } else {
    // sfFetch: use the URL from content.js but rewrite to Classic domain
    url = toClassicBase(msg.url).replace(/\/\/$/, '') + new URL(msg.url).pathname + new URL(msg.url).search;
  }

  const resp = await fetch(url, { headers });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  return resp.json();
}

// ─── Session ID helper ────────────────────────────────────────────────────────

/**
 * Read the Salesforce session cookie (`sid`) for the given origin.
 * chrome.cookies API can read HttpOnly cookies — content scripts cannot.
 * The sid value IS the OAuth Bearer token for the REST API.
 */
async function getSid(baseUrl) {
  try {
    // 1. Try to get sid from Classic base
    let cookie = await chrome.cookies.get({ url: baseUrl, name: 'sid' });
    if (cookie && cookie.value) return cookie.value;

    // 2. Try to get sid from Lightning base (fallback)
    const lightningBase = baseUrl.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
    cookie = await chrome.cookies.get({ url: lightningBase, name: 'sid' });
    if (cookie && cookie.value) return cookie.value;
  } catch { }
  return null;
}

// ─── API version discovery ────────────────────────────────────────────────────

/**
 * Discover the highest available REST API version for this org.
 * Cached per Classic hostname.
 */
async function getApiVersion(apiBase, headers) {
  const hostname = new URL(apiBase).hostname;
  if (apiVersionCache.has(hostname)) return apiVersionCache.get(hostname);

  try {
    const resp = await fetch(`${apiBase}/services/data/`, { headers });
    if (resp.ok) {
      const list = await resp.json();
      if (Array.isArray(list) && list.length > 0) {
        const raw = list[list.length - 1].version;
        const ver = raw.startsWith('v') ? raw : `v${raw}`;
        apiVersionCache.set(hostname, ver);
        return ver;
      }
    }
  } catch { }

  return 'v59.0';
}