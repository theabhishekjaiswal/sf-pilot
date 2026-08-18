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
// Cache of sObject lists — keyed by Org ID to avoid duplicate entries for Classic/Lightning/VF domains
const objectsCache = new Map();
// Org ID cache (Classic hostname → orgId), to avoid repeat lookups


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
  const tabUrl = sender.tab && sender.tab.url && !isExt ? sender.tab.url : null;
  const rawUrl = tabUrl || msg.baseUrl;
  
  const session = await resolveApiSession(rawUrl);
  if (!session) throw new Error("Could not resolve Salesforce API session for this domain.");
  
  const apiBase = session.apiBase;
  const sid = session.sid;

  const headers = { Accept: 'application/json' };
  if (sid) headers['Authorization'] = `Bearer ${sid}`;

  // Use Org ID as the cache key so Classic/Lightning/VF pages all share one cache entry
  const orgId = session.orgId;
  const cacheKey = orgId ? `sf_objects_org_${orgId}` : `sf_objects_${new URL(apiBase).hostname}`;

  if (!msg.forceRefresh) {
    if (objectsCache.has(cacheKey)) {
      return objectsCache.get(cacheKey);
    }

    // Check persistent cache to avoid 8-12s API load time
    try {
      const stored = await chrome.storage.local.get([cacheKey, `${cacheKey}_time`]);
      const now = Date.now();
      // Use cache if it's less than 24 hours old
      if (stored[cacheKey] && stored[`${cacheKey}_time`] && (now - stored[`${cacheKey}_time`] < 24 * 60 * 60 * 1000)) {
        objectsCache.set(cacheKey, stored[cacheKey]);
        return stored[cacheKey];
      }
    } catch (e) {
      console.warn('[SF Pilot] Cache read failed:', e);
    }
  }

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

  // 12. Fetch Static Resources (Parallel)
  const staticResourcesPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/query?q=SELECT+Id,Name+FROM+StaticResource+WHERE+NamespacePrefix=null`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({
          label: r.Name,
          name: r.Name,
          type: 'StaticResource',
          setupId: r.Id
        }));
      }
    } catch (e) {
      console.warn('[SF Pilot] Static Resources fetch failed:', e.message);
    }
    return [];
  })();

  // 13. Fetch Active Salesforce Licensed Users (Parallel)
  const usersPromise = (async () => {
    try {
      const qUrl = `${apiBase}/services/data/${ver}/query?q=SELECT+Id,Name,Username+FROM+User+WHERE+IsActive=true+AND+Profile.UserLicense.Name='Salesforce'`;
      const resp = await fetch(qUrl, { headers, signal: controller.signal });
      if (resp.ok) {
        const d = await resp.json();
        return (d.records || []).map(r => ({
          label: r.Name,
          name: r.Username,
          type: 'User',
          setupId: r.Id
        }));
      }
    } catch (e) {
      console.warn('[SF Pilot] Users fetch failed:', e.message);
    }
    return [];
  })();

  try {
    const [_, data, classes, triggers, pages, labels, settings, flows, tabs, profiles, permissionSets, staticResources, users] = await Promise.all([
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
      permissionSetsPromise,
      staticResourcesPromise,
      usersPromise
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

    // Add Classes, Triggers, Pages, Labels, Settings, Flows, Tabs, Profiles, PermSets, StaticResources
    unifiedList.push(...classes);
    unifiedList.push(...triggers);
    unifiedList.push(...pages);
    unifiedList.push(...labels);
    unifiedList.push(...settings);
    unifiedList.push(...flows);
    unifiedList.push(...tabs);
    unifiedList.push(...profiles);
    unifiedList.push(...permissionSets);
    unifiedList.push(...staticResources);
    unifiedList.push(...users);

    // Sort alphabetically by label name
    unifiedList.sort((a, b) => a.label.localeCompare(b.label));

    objectsCache.set(cacheKey, unifiedList);

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
  const tabUrl = sender.tab && sender.tab.url ? sender.tab.url : null;
  const rawUrl = tabUrl || msg.baseUrl;
  const session = await resolveApiSession(rawUrl);
  return session ? session.sid : null;
}

// ─── Domain normalization ─────────────────────────────────────────────────────

/**
 * Reliably finds the Salesforce API session cookie and base URL for ANY Salesforce tab,
 * without relying on brittle domain regexes (which break on complex sandbox/builder domains).
 * 
 * Strategy:
 * 1. Read the 'sid' cookie for the current tab's exact URL (e.g. VF or Builder).
 * 2. Extract the Org ID from that sid (first 15 chars before the !).
 * 3. Search ALL cookies to find the master API session (.salesforce.com) for that Org ID.
 * 4. Fallback: Extract the tenant prefix from the URL and fuzzy-match the cookie domain.
 */
async function resolveApiSession(rawUrl) {
  if (!rawUrl) return null;
  const urlObj = new URL(rawUrl);
  
  let localSid = null;
  let orgId = null;
  try {
    const localCookie = await chrome.cookies.get({ url: rawUrl, name: 'sid' });
    if (localCookie && localCookie.value) {
      localSid = localCookie.value;
      orgId = localSid.split('!')[0];
    }
  } catch (e) {}

  const allSids = await chrome.cookies.getAll({ name: 'sid' });
  
  // 1. Exact match by Org ID (Bulletproof)
  if (orgId && orgId.startsWith('00D')) {
    for (const cookie of allSids) {
      if (cookie.value.startsWith(orgId) && cookie.domain.includes('salesforce.com')) {
        return {
          apiBase: `https://${cookie.domain.replace(/^\./, '')}`,
          sid: cookie.value,
          orgId: orgId
        };
      }
    }
  }

  // 2. Fuzzy match by tenant prefix
  // "orgfarm-dev.develop.my.site.com" -> "orgfarm-dev"
  // "org--c.vf.force.com" -> "org"
  const firstSegment = urlObj.hostname.split('.')[0];
  const tenant = firstSegment.split('--')[0]; 
  
  if (tenant && tenant.length > 2) {
    const matchingCookies = allSids.filter(c => 
      c.domain.includes('salesforce.com') && 
      (c.domain.startsWith(tenant) || c.domain.startsWith('.' + tenant))
    );
    
    if (matchingCookies.length > 0) {
      // Prefer .my.salesforce.com if multiple match
      const bestMatch = matchingCookies.find(c => c.domain.includes('.my.salesforce.com')) || matchingCookies[0];
      return {
        apiBase: `https://${bestMatch.domain.replace(/^\./, '')}`,
        sid: bestMatch.value,
        orgId: bestMatch.value.split('!')[0]
      };
    }
  }

  // 3. Absolute fallback
  return {
    apiBase: urlObj.origin,
    sid: localSid,
    orgId: localSid ? localSid.split('!')[0] : null
  };
}




// ─── Core request handler ─────────────────────────────────────────────────────

async function handleRequest(msg, sender) {
  // Derive the tab's origin (most reliable), fall back to message payload
  // Ignore chrome-extension:// origins so our own internal pages can provide their own msg.baseUrl
  const isExt = sender.tab && sender.tab.url && sender.tab.url.startsWith('chrome-extension:');
  const tabUrl = sender.tab && sender.tab.url && !isExt ? sender.tab.url : null;
  const rawUrl = tabUrl || msg.baseUrl;

  // Resolve API Base and Session ID using the robust cookie method
  const session = await resolveApiSession(rawUrl);
  if (!session) throw new Error("Could not resolve Salesforce API session for this domain.");

  const apiBase = session.apiBase;
  const sid = session.sid;

  const headers = { Accept: 'application/json' };
  if (sid) headers['Authorization'] = `Bearer ${sid}`;

  let url;
  if (msg.type === 'sfQuery') {
    const ver = await getApiVersion(apiBase, headers);
    url = `${apiBase}/services/data/${ver}/query?q=${encodeURIComponent(msg.query)}`;
  } else {
    // sfFetch: rewrite the target URL to the master API base
    const parsedTarget = new URL(msg.url);
    url = `${apiBase}${parsedTarget.pathname}${parsedTarget.search}`;
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