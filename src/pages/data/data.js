document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const recordId = urlParams.get('recordId');
  let objectType = urlParams.get('objectType');
  const host = urlParams.get('host');

  const titleEl = document.getElementById('sfp-record-title');
  const typeEl = document.getElementById('sfp-object-type');
  const searchInput = document.getElementById('sfp-search-input');
  const typeFilter = document.getElementById('sfp-type-filter');
  const hideEmptyToggle = document.getElementById('sfp-hide-empty');
  const countEl = document.getElementById('sfp-field-count');
  const tbody = document.getElementById('sfp-table-body');
  const table = document.getElementById('sfp-data-table');
  
  const actionButtons = document.getElementById('sfp-action-buttons');
  const btnSave = document.getElementById('sfp-btn-save');
  const btnCancel = document.getElementById('sfp-btn-cancel');

  const stateLoading = document.getElementById('sfp-loading-state');
  const stateError = document.getElementById('sfp-error-state');
  const errorMsg = document.getElementById('sfp-error-msg');

  if (!recordId || !host) {
    showError('Missing required URL parameters (recordId or host).');
    return;
  }

  typeEl.textContent = objectType || 'Resolving...';
  titleEl.textContent = recordId;

  let allFields = [];
  let pendingEdits = {}; // To store unsaved edits
  let objectPinnedFields = []; // To store pinned field API names

  function updateActionButtons() {
    const editCount = Object.keys(pendingEdits).length;
    if (editCount > 0) {
      actionButtons.style.display = 'flex';
      btnSave.textContent = `Save Changes (${editCount})`;
    } else {
      actionButtons.style.display = 'none';
    }
  }

  function showError(msg) {
    stateLoading.style.display = 'none';
    table.style.display = 'none';
    stateError.style.display = 'flex';
    errorMsg.textContent = msg;
  }

  async function sfFetch(endpoint, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'sfFetch', url: endpoint, baseUrl: host, method, body },
        (resp) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (!resp.ok) {
            return reject(new Error(resp.error || 'Unknown error'));
          }
          resolve(resp.data);
        }
      );
    });
  }

  async function loadData() {
    try {
      const apiVer = 'v60.0';
      
      // Resolve objectType if missing
      if (!objectType) {
        const prefix = recordId.substring(0, 3);
        const query = `SELECT QualifiedApiName FROM EntityDefinition WHERE KeyPrefix = '${prefix}' LIMIT 1`;
        
        const resolveData = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: 'sfQuery', query: query, baseUrl: host },
            (resp) => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              if (!resp.ok) return reject(new Error(resp.error || 'Unknown error'));
              resolve(resp.data);
            }
          );
        });

        if (resolveData && resolveData.records && resolveData.records.length > 0) {
          objectType = resolveData.records[0].QualifiedApiName;
          typeEl.textContent = objectType;
        } else {
          throw new Error('Could not resolve object type for this record ID.');
        }
      }

      const describeUrl = `${host}/services/data/${apiVer}/sobjects/${objectType}/describe`;
      const recordUrl = `${host}/services/data/${apiVer}/sobjects/${objectType}/${recordId}`;

      // Fetch in parallel
      const [describeData, recordData] = await Promise.all([
        sfFetch(describeUrl),
        sfFetch(recordUrl)
      ]);

      if (!describeData || !describeData.fields) {
        throw new Error('Failed to load object metadata.');
      }

      // Map describe metadata to record values
      allFields = describeData.fields.map(f => {
        return {
          label: f.label,
          name: f.name,
          type: f.type,
          value: recordData[f.name],
          originalValue: recordData[f.name],
          picklistValues: f.picklistValues || []
        };
      });

      // Load Pinned Fields from Storage
      const storageKey = `sfp_pinned_${objectType}`;
      const savedPins = await new Promise(res => chrome.storage.sync.get(storageKey, res));
      objectPinnedFields = savedPins[storageKey] || [];

      // Sort alphabetically, but pinned fields bubble to top and maintain exact order
      allFields.sort((a, b) => {
        const aIndex = objectPinnedFields.indexOf(a.name);
        const bIndex = objectPinnedFields.indexOf(b.name);
        if (aIndex !== -1 && bIndex === -1) return -1;
        if (aIndex === -1 && bIndex !== -1) return 1;
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        return a.label.localeCompare(b.label);
      });

      // Populate Type Filter dropdown
      typeFilter.innerHTML = '<option value="all">All Types</option>';
      const uniqueTypes = [...new Set(allFields.map(f => f.type.toLowerCase()))].sort();
      uniqueTypes.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.text = t.charAt(0).toUpperCase() + t.slice(1);
        typeFilter.appendChild(opt);
      });

      applyFilters();
      
      stateLoading.style.display = 'none';
      table.style.display = 'table';
      searchInput.focus();

    } catch (e) {
      showError(e.message);
    }
  }

  function getTypeIcon(type) {
    const t = type.toLowerCase();
    if (t === 'datetime' || t === 'date') return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;
    if (t === 'reference') return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;
    if (t === 'boolean') return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>`;
    if (t === 'int' || t === 'double' || t === 'currency' || t === 'percent') return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>`;
    if (t === 'string' || t === 'textarea' || t === 'url') return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>`;
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
  }

  function renderTable(fieldsToRender) {
    countEl.textContent = `${fieldsToRender.length} field${fieldsToRender.length !== 1 ? 's' : ''}`;
    
    if (fieldsToRender.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 32px;">No fields match your search.</td></tr>`;
      return;
    }

    const rows = fieldsToRender.map(f => {
      let valHtml = '';
      
      if (f.value === null || f.value === undefined || f.value === '') {
        const isStringType = ['string', 'textarea', 'url', 'phone', 'email', 'picklist'].includes(f.type.toLowerCase());
        const displayWord = (f.value === '' || isStringType) ? '[blank]' : '[null]';
        valHtml = `<span class="val-null">${displayWord}</span>`;
      } else if (f.type === 'boolean') {
        const isTrue = f.value === true;
        const icon = isTrue 
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        valHtml = `<div class="val-bool ${isTrue}"><span title="${isTrue}">${icon}</span></div>`;
      } else if (typeof f.value === 'object') {
        // Includes nested attributes like { type: 'Account', url: '...' }
        valHtml = `<pre class="val-json">${JSON.stringify(f.value, null, 2)}</pre>`;
      } else if (f.type === 'reference' && typeof f.value === 'string' && f.value.length >= 15) {
        const sfUrl = `${host}/${f.value}`;
        valHtml = `<a href="${sfUrl}" target="_blank" class="val-link">${f.value}</a>`;
      } else if (f.type === 'datetime' || f.type === 'date') {
        const rawDate = String(f.value);
        let formatted = rawDate;
        try {
          const d = new Date(rawDate);
          if (!isNaN(d)) {
            if (f.type === 'date') {
              formatted = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
            } else {
              formatted = d.toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            }
          }
        } catch(e) {}
        valHtml = `<span class="val-date" data-formatted="${escapeHtml(formatted)}" style="border-bottom: 1px dotted rgba(255,255,255,0.4); cursor: pointer;">${escapeHtml(rawDate)}</span>`;
      } else {
        valHtml = escapeHtml(String(f.value));
      }

      let isEditable = true;

      // Some fields shouldn't be edited easily via this simple UI (e.g. complex JSON)
      if (typeof f.value === 'object' && f.value !== null) {
        isEditable = false;
      }

      const isEdited = pendingEdits.hasOwnProperty(f.name);
      let cellClasses = 'col-value';
      if (isEditable) cellClasses += ' editable';
      if (isEdited) cellClasses += ' is-edited';

      const origValStr = f.originalValue === null || f.originalValue === undefined ? '' : String(f.originalValue);

      const isPinned = objectPinnedFields.includes(f.name);
      const starClass = isPinned ? 'pin-star is-pinned' : 'pin-star';
      const starIcon = `<svg class="${starClass}" data-field-name="${escapeHtml(f.name)}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
      
      const gripIcon = isPinned ? `<div class="drag-grip" title="Drag to reorder"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg></div>` : `<div style="width: 14px"></div>`;
      
      let rowAttrs = '';
      if (isPinned) {
        rowAttrs = `class="draggable-row" data-field-name="${escapeHtml(f.name)}"`;
      }
      
      return `
        <tr ${rowAttrs}>
          <td class="col-label" title="${escapeHtml(f.label)}"><div style="display: flex; align-items: center; gap: 6px;">${gripIcon} ${starIcon} <span>${escapeHtml(f.label)}</span></div></td>
          <td class="col-name">${escapeHtml(f.name)}</td>
          <td class="col-type">${getTypeIcon(f.type)} ${escapeHtml(f.type)}</td>
          <td class="${cellClasses}" data-field-name="${escapeHtml(f.name)}" data-original-value="${escapeHtml(origValStr)}" data-field-type="${escapeHtml(f.type)}">
            ${valHtml}
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = rows.join('');
  }

  function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
  }

  // Handle Multi-Criteria Filtering
  function applyFilters() {
    const term = searchInput.value.toLowerCase().trim();
    const type = typeFilter.value;
    const hideEmpty = hideEmptyToggle.checked;

    const filtered = allFields.filter(f => {
      let matchSearch = true;
      if (term) {
        const matchLabel = f.label.toLowerCase().includes(term);
        const matchName = f.name.toLowerCase().includes(term);
        const valStr = f.value !== null && f.value !== undefined ? String(f.value).toLowerCase() : '';
        const matchValue = valStr.includes(term);
        matchSearch = matchLabel || matchName || matchValue;
      }

      const matchType = type === 'all' || f.type.toLowerCase() === type;
      
      let matchEmpty = true;
      if (hideEmpty) {
        if (f.value === null || f.value === undefined || f.value === '') {
          matchEmpty = false;
        }
      }

      return matchSearch && matchType && matchEmpty;
    });

    renderTable(filtered);
  }

  searchInput.addEventListener('input', applyFilters);
  typeFilter.addEventListener('change', applyFilters);
  hideEmptyToggle.addEventListener('change', applyFilters);

  // Handle Inline Editing
  tbody.addEventListener('dblclick', (e) => {
    const td = e.target.closest('.col-value.editable');
    if (!td || td.querySelector('input')) return;

    const fieldName = td.dataset.fieldName;
    const fieldType = td.dataset.fieldType;
    
    // If it was already edited, use the pending value as original, otherwise use true original
    let originalValueStr = td.dataset.originalValue;
    if (pendingEdits.hasOwnProperty(fieldName)) {
      const pVal = pendingEdits[fieldName];
      originalValueStr = pVal === null ? '' : String(pVal);
    }

    let input;
    if (fieldType.toLowerCase() === 'picklist') {
      input = document.createElement('select');
      input.className = 'inline-edit-input sfp-select';
      
      const fieldObj = allFields.find(f => f.name === fieldName);
      
      const nullOpt = document.createElement('option');
      nullOpt.value = '';
      nullOpt.text = '--None--';
      input.appendChild(nullOpt);

      if (fieldObj && fieldObj.picklistValues) {
        fieldObj.picklistValues.forEach(pv => {
          if (pv.active) {
            const opt = document.createElement('option');
            opt.value = pv.value;
            opt.text = pv.label;
            if (pv.value === originalValueStr) opt.selected = true;
            input.appendChild(opt);
          }
        });
      }
      
      if (originalValueStr && !Array.from(input.options).some(o => o.value === originalValueStr)) {
        const opt = document.createElement('option');
        opt.value = originalValueStr;
        opt.text = originalValueStr;
        opt.selected = true;
        input.appendChild(opt);
      }
    } else if (fieldType.toLowerCase() === 'boolean') {
      input = document.createElement('select');
      input.className = 'inline-edit-input sfp-select';
      
      const nullOpt = document.createElement('option');
      nullOpt.value = '';
      nullOpt.text = '--None--';
      
      const trueOpt = document.createElement('option');
      trueOpt.value = 'true';
      trueOpt.text = 'True';
      
      const falseOpt = document.createElement('option');
      falseOpt.value = 'false';
      falseOpt.text = 'False';

      if (originalValueStr === 'true') trueOpt.selected = true;
      else if (originalValueStr === 'false') falseOpt.selected = true;
      else nullOpt.selected = true;

      input.appendChild(nullOpt);
      input.appendChild(trueOpt);
      input.appendChild(falseOpt);
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'inline-edit-input';
      input.value = originalValueStr;
    }
    
    const originalContent = td.innerHTML;
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();

    function stageField() {
      const newValueStr = input.value.trim();
      
      let payloadValue = newValueStr;
      const forceNullTypes = ['int', 'double', 'currency', 'percent', 'date', 'datetime', 'reference', 'boolean'];
      
      if (payloadValue === '' && forceNullTypes.includes(fieldType)) {
        payloadValue = null;
      } else if (fieldType === 'boolean') {
        payloadValue = payloadValue.toLowerCase() === 'true';
      } else if (payloadValue !== '' && (fieldType === 'int' || fieldType === 'double' || fieldType === 'currency' || fieldType === 'percent')) {
        payloadValue = Number(payloadValue);
      }

      // Check if it's different from the original base value
      const baseOriginal = td.dataset.originalValue;
      let baseOriginalPayload = baseOriginal;
      
      if (baseOriginal === '' && forceNullTypes.includes(fieldType)) {
        baseOriginalPayload = null;
      } else if (fieldType === 'boolean') {
        baseOriginalPayload = baseOriginal.toLowerCase() === 'true';
      } else if (baseOriginal !== '' && (fieldType === 'int' || fieldType === 'double' || fieldType === 'currency' || fieldType === 'percent')) {
        baseOriginalPayload = Number(baseOriginal);
      }

      // If the original was actually null (from dataset it becomes ''), and they entered '', treat as unchanged
      if (baseOriginal === '' && payloadValue === '') {
        payloadValue = baseOriginalPayload; 
      }

      if (payloadValue === baseOriginalPayload) {
        // Reverted to original, remove from pending
        delete pendingEdits[fieldName];
        td.classList.remove('is-edited');
      } else {
        // Staged new value
        pendingEdits[fieldName] = payloadValue;
        td.classList.add('is-edited');
      }

      // Update local state temporarily so renderTable shows it
      const fieldObj = allFields.find(f => f.name === fieldName);
      if (fieldObj) {
        fieldObj.value = payloadValue === undefined ? baseOriginalPayload : payloadValue;
      }

      updateActionButtons();
      searchInput.dispatchEvent(new Event('input')); // re-renders table
    }

    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        stageField();
      } else if (evt.key === 'Escape') {
        td.innerHTML = originalContent;
      }
    });

    input.addEventListener('blur', () => {
      stageField();
    });
  });

  btnCancel.addEventListener('click', () => {
    pendingEdits = {};
    updateActionButtons();
    loadData(); // Reload to original state
  });

  btnSave.addEventListener('click', async () => {
    if (Object.keys(pendingEdits).length === 0) return;

    btnSave.disabled = true;
    btnCancel.disabled = true;
    const originalText = btnSave.textContent;
    btnSave.textContent = 'Saving...';

    try {
      const updateUrl = `${host}/services/data/v60.0/sobjects/${objectType}/${recordId}`;
      await sfFetch(updateUrl, 'PATCH', pendingEdits);
      
      // Success: commit edits
      pendingEdits = {};
      updateActionButtons();
      
      // Update original values in allFields
      allFields = allFields.map(f => {
        return {
          ...f,
          originalValue: f.value // Make current value the new original
        }
      });
      
      // Re-render to clear is-edited classes (handled dynamically by not having pendingEdits anymore, wait, is-edited is added in stageField, we should just reload data)
      await loadData();
      
    } catch (err) {
      alert(`Failed to save changes:\n${err.message}`);
      // Revert the UI to ensure it matches the actual state in Salesforce
      pendingEdits = {};
      updateActionButtons();
      loadData();
    } finally {
      btnSave.disabled = false;
      btnCancel.disabled = false;
      btnSave.textContent = originalText;
    }
  });

  // --- Relationship Tooltip Logic ---
  const tooltip = document.createElement('div');
  tooltip.className = 'sfp-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  let tooltipTimer = null;
  let prefixCache = {};
  let nameCache = {};

  tbody.addEventListener('mouseover', async (e) => {
    if (e.target.classList.contains('val-date')) {
      const rect = e.target.getBoundingClientRect();
      tooltip.style.left = `${rect.right + 10}px`;
      tooltip.style.top = `${rect.top + rect.height/2}px`;
      tooltip.style.display = 'block';
      tooltip.textContent = e.target.dataset.formatted;
      return;
    }

    if (e.target.classList.contains('val-link')) {
      const refId = e.target.textContent;
      if (!refId || refId.length < 3) return;

      tooltipTimer = setTimeout(async () => {
        const rect = e.target.getBoundingClientRect();
        tooltip.style.left = `${rect.right + 10}px`;
        tooltip.style.top = `${rect.top + rect.height/2}px`;
        tooltip.style.display = 'block';
        tooltip.textContent = 'Resolving...';

        try {
          // 1. Resolve Prefix -> Object Name
          const prefix = refId.substring(0, 3);
          let targetObj = prefixCache[prefix];
          
          if (!targetObj) {
            const query = `SELECT QualifiedApiName FROM EntityDefinition WHERE KeyPrefix = '${prefix}' LIMIT 1`;
            const resp = await new Promise((res, rej) => chrome.runtime.sendMessage({ type: 'sfQuery', query: query, baseUrl: host }, res));
            if (resp && resp.ok && resp.data.records.length > 0) {
              targetObj = resp.data.records[0].QualifiedApiName;
              prefixCache[prefix] = targetObj;
            } else {
              tooltip.textContent = 'Unknown Object';
              return;
            }
          }

          // 2. Resolve Id -> Name
          if (nameCache[refId]) {
            tooltip.textContent = `${targetObj}: ${nameCache[refId]}`;
            return;
          }

          // We'll try to fetch Name, but some objects don't have Name. Let's gracefully handle errors.
          const nameQuery = `SELECT Name FROM ${targetObj} WHERE Id = '${refId}'`;
          const resp2 = await new Promise((res, rej) => chrome.runtime.sendMessage({ type: 'sfQuery', query: nameQuery, baseUrl: host }, res));
          
          if (resp2 && resp2.ok && resp2.data.records.length > 0) {
            const nameVal = resp2.data.records[0].Name || refId;
            nameCache[refId] = nameVal;
            tooltip.textContent = `${targetObj}: ${nameVal}`;
          } else {
            nameCache[refId] = 'No Name Field';
            tooltip.textContent = `${targetObj} (No Name)`;
          }

        } catch (err) {
          tooltip.textContent = 'Error loading related record';
        }

      }, 400); // 400ms debounce
    }
  });

  tbody.addEventListener('mouseout', (e) => {
    if (e.target.classList.contains('val-link') || e.target.classList.contains('val-date')) {
      clearTimeout(tooltipTimer);
      tooltip.style.display = 'none';
      tooltip.textContent = '';
    }
  });

  // Handle Pin Star Clicks
  tbody.addEventListener('click', (e) => {
    const star = e.target.closest('.pin-star');
    if (star) {
      const fieldName = star.dataset.fieldName;
      if (objectPinnedFields.includes(fieldName)) {
        objectPinnedFields = objectPinnedFields.filter(f => f !== fieldName);
      } else {
        objectPinnedFields.push(fieldName);
      }
      
      const storageKey = `sfp_pinned_${objectType}`;
      chrome.storage.sync.set({ [storageKey]: objectPinnedFields });
      
      // Re-sort and render
      allFields.sort((a, b) => {
        const aIndex = objectPinnedFields.indexOf(a.name);
        const bIndex = objectPinnedFields.indexOf(b.name);
        if (aIndex !== -1 && bIndex === -1) return -1;
        if (aIndex === -1 && bIndex !== -1) return 1;
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        return a.label.localeCompare(b.label);
      });
      
      applyFilters();
    }
  });

  // --- Drag and Drop for Pinned Fields ---
  let draggedField = null;

  // Only allow dragging if they grabbed the grip handle
  tbody.addEventListener('mousedown', (e) => {
    const grip = e.target.closest('.drag-grip');
    if (grip) {
      const row = grip.closest('.draggable-row');
      if (row) {
        row.setAttribute('draggable', 'true');
      }
    }
  });

  tbody.addEventListener('mouseup', (e) => {
    // Clean up draggable attribute if they just clicked the grip but didn't drag
    const grip = e.target.closest('.drag-grip');
    if (grip) {
      const row = grip.closest('.draggable-row');
      if (row) {
        row.removeAttribute('draggable');
      }
    }
  });

  tbody.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.draggable-row');
    if (!row) return;
    draggedField = row.dataset.fieldName;
    row.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedField);
  });

  tbody.addEventListener('dragend', (e) => {
    const row = e.target.closest('.draggable-row');
    if (row) {
      row.removeAttribute('draggable');
      row.classList.remove('is-dragging');
    }
  });

  tbody.addEventListener('dragover', (e) => {
    e.preventDefault();
    const row = e.target.closest('.draggable-row');
    if (!row || !draggedField || row.dataset.fieldName === draggedField) return;
    
    const rect = row.getBoundingClientRect();
    const offset = e.clientY - rect.top;
    
    document.querySelectorAll('.draggable-row').forEach(r => {
      r.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    
    if (offset < rect.height / 2) {
      row.classList.add('drag-over-top');
    } else {
      row.classList.add('drag-over-bottom');
    }
    e.dataTransfer.dropEffect = 'move';
  });

  tbody.addEventListener('dragleave', (e) => {
    const row = e.target.closest('.draggable-row');
    if (row) {
      row.classList.remove('drag-over-top', 'drag-over-bottom');
    }
  });

  tbody.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggedField) return;
    
    const row = e.target.closest('.draggable-row');
    if (!row || row.dataset.fieldName === draggedField) return;
    
    const targetField = row.dataset.fieldName;
    
    const draggedIdx = objectPinnedFields.indexOf(draggedField);
    let targetIdx = objectPinnedFields.indexOf(targetField);
    
    if (draggedIdx !== -1 && targetIdx !== -1) {
      objectPinnedFields.splice(draggedIdx, 1);
      
      if (row.classList.contains('drag-over-bottom')) {
        targetIdx = objectPinnedFields.indexOf(targetField) + 1;
      } else {
        targetIdx = objectPinnedFields.indexOf(targetField);
      }
      
      objectPinnedFields.splice(targetIdx, 0, draggedField);
      
      const storageKey = `sfp_pinned_${objectType}`;
      chrome.storage.sync.set({ [storageKey]: objectPinnedFields });
      
      allFields.sort((a, b) => {
        const aIndex = objectPinnedFields.indexOf(a.name);
        const bIndex = objectPinnedFields.indexOf(b.name);
        if (aIndex !== -1 && bIndex === -1) return -1;
        if (aIndex === -1 && bIndex !== -1) return 1;
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        return a.label.localeCompare(b.label);
      });
      applyFilters();
    }
    
    document.querySelectorAll('.draggable-row').forEach(r => {
      r.classList.remove('drag-over-top', 'drag-over-bottom');
    });
  });

  tbody.addEventListener('dragend', (e) => {
    const row = e.target.closest('.draggable-row');
    if (row) {
      row.classList.remove('is-dragging', 'drag-over-top', 'drag-over-bottom');
    }
    draggedField = null;
    document.querySelectorAll('.draggable-row').forEach(r => {
      r.classList.remove('drag-over-top', 'drag-over-bottom');
    });
  });

  // Start Loading
  loadData();
});
