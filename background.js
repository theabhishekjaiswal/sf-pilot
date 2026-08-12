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
  const isExt = sender.tab && sender.tab.url && sender.tab.url.startsWith('chrome-extension:');
  const tabUrl = sender.tab && sender.tab.url && !isExt ? new URL(sender.tab.url) : null;
  const rawBase = tabUrl ? `${tabUrl.protocol}//${tabUrl.hostname}` : (msg.baseUrl || '');
  const apiBase = toClassicBase(rawBase);
  const hostname = new URL(apiBase).hostname;
  const cacheKey = `sf_objects_${hostname}`;

  if (!msg.forceRefresh) {
    if (objectsCache.has(hostname)) {
      return objectsCache.get(hostname);
    }

    // Check persistent cache to avoid 8-12s API load time
    try {
      const stored = await chrome.storage.local.get([cacheKey, `${cacheKey}_time`]);
      const now = Date.now();
      // Use cache if it's less than 24 hours old
      if (stored[cacheKey] && stored[`${cacheKey}_time`] && (now - stored[`${cacheKey}_time`] < 24 * 60 * 60 * 1000)) {
        objectsCache.set(hostname, stored[cacheKey]);
        return stored[cacheKey];
      }
    } catch (e) {
      console.warn('[SF Pilot] Cache read failed:', e);
    }
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

            // Map custom objects (__c), custom metadata (__mdt) and platform events (__e)
            customObjectIds.set((baseApiName + '__c').toLowerCase(), r.Id);
            customObjectIds.set((baseApiName + '__mdt').toLowerCase(), r.Id);
            customObjectIds.set((baseApiName + '__e').toLowerCase(), r.Id);
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

  // 8. Fetch Flows via Tooling API (Parallel)
  const flowsPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/tooling/query?q=SELECT+Id,DeveloperName,MasterLabel+FROM+FlowDefinition+WHERE+NamespacePrefix=null`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({
          label: r.MasterLabel || r.DeveloperName,
          name: r.DeveloperName,
          type: 'Flow',
          setupId: r.Id  // FlowDefinition ID (300xxx) — opens Flow Detail page in Classic
        }));
      }
    } catch (e) {
      console.warn('[SF Pilot] Flow fetch failed:', e.message);
    }
    return [];
  })();

  // 9. Fetch Tabs via reliable REST API (Parallel)
  const tabsPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/tabs`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const tabsArr = await resp.json();
        const customTabs = [];
        for (const tab of tabsArr) {
          if (tab.custom) {
            customTabs.push({
              label: tab.label,
              name: tab.name,
              type: 'Tab',
              sobjectName: tab.sobjectName || null,
              setupId: tab.name, // fallback identifier
              tabUrl: tab.url || null
            });
          }
        }
        return customTabs;
      } else {
        console.warn('[SF Pilot] Tabs REST API returned status:', resp.status);
      }
    } catch (e) {
      console.warn('[SF Pilot] Tabs fetch failed:', e.message);
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

  // 10. Fetch Profiles via Tooling/REST (Parallel)
  const profilesPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/query?q=SELECT+Id,Name+FROM+Profile`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({
          label: r.Name,
          name: r.Name,
          type: 'Profile',
          setupId: r.Id
        }));
      }
    } catch (e) {
      console.warn('[SF Pilot] Profiles fetch failed:', e.message);
    }
    return [];
  })();

  // 11. Fetch Permission Sets via Tooling/REST (Parallel)
  const permissionSetsPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/query?q=SELECT+Id,Name,Label+FROM+PermissionSet+WHERE+IsOwnedByProfile=false`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({
          label: r.Label || r.Name,
          name: r.Name,
          type: 'Permission Set',
          setupId: r.Id
        }));
      }
    } catch (e) {
      console.warn('[SF Pilot] Permission Sets fetch failed:', e.message);
    }
    return [];
  })();

  try {
    const [_, data, classes, triggers, pages, labels, settings, flows, tabs, profiles, permissionSets] = await Promise.all([
      toolingPromise,
      sobjectsPromise,
      classesPromise,
      triggersPromise,
      pagesPromise,
      labelsPromise,
      settingsPromise,
      flowsPromise,
      tabsPromise,
      profilesPromise,
      permissionSetsPromise
    ]);

    const unifiedList = [];
    const customSettingsNames = new Set(settings.map(s => s.name.toLowerCase()));

    // Add sObjects (filter out Custom Settings to avoid double listing)
    // Also include Platform Events (__e) which may not be layoutable
    if (data && Array.isArray(data.sobjects)) {
      const sobjects = data.sobjects
        .filter(o => {
          const nameLower = o.name.toLowerCase();
          const isPlatformEvent = nameLower.endsWith('__e');
          if (isPlatformEvent) return true; // always include platform events
          return o.queryable && (o.layoutable || nameLower.endsWith('__mdt')) && !customSettingsNames.has(nameLower);
        })
        .map(o => {
          const nameLower = o.name.toLowerCase();
          const isPlatformEvent = nameLower.endsWith('__e');
          let setupId = null;
          if (o.custom) {
            setupId = customObjectIds.get(nameLower) || null;
          } else {
            setupId = o.name;
          }
          return {
            label: o.label || '',
            name: o.name || '',
            type: isPlatformEvent ? 'PlatformEvent' : 'Object',
            custom: o.custom,
            setupId: setupId
          };
        });
      unifiedList.push(...sobjects);
    }

    // Add Classes, Triggers, Pages, Labels, Settings, Flows, Tabs
    unifiedList.push(...classes);
    unifiedList.push(...triggers);
    unifiedList.push(...pages);
    unifiedList.push(...labels);
    unifiedList.push(...settings);
    unifiedList.push(...flows);
    unifiedList.push(...tabs);
    unifiedList.push(...profiles);
    unifiedList.push(...permissionSets);

    // Sort alphabetically by label name
    unifiedList.sort((a, b) => a.label.localeCompare(b.label));

    objectsCache.set(hostname, unifiedList);
    
    // Save to persistent cache
    try {
      await chrome.storage.local.set({ 
        [cacheKey]: unifiedList, 
        [`${cacheKey}_time`]: Date.now() 
      });
    } catch (e) {
      console.warn('[SF Pilot] Cache save failed:', e);
    }
    
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
  // Ignore chrome-extension:// origins so our own internal pages can provide their own msg.baseUrl
  const isExt = sender.tab && sender.tab.url && sender.tab.url.startsWith('chrome-extension:');
  const tabUrl = sender.tab && sender.tab.url && !isExt ? new URL(sender.tab.url) : null;
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

  const fetchOptions = {
    method: msg.method || 'GET',
    headers
  };
  if (msg.body) {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(msg.body);
  }

  const resp = await fetch(url, fetchOptions);

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  const text = await resp.text().catch(() => '');
  return text ? JSON.parse(text) : {};
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