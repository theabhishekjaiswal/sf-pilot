# SF Navigator — Project Requirements

## What We're Building

**SF Navigator** is a premium Chrome Extension (Manifest V3) for Salesforce power users. It injects a floating, glassmorphism-styled toolbar at the top of any Salesforce record page, giving one-click navigation between Classic and Lightning views, and — for `genesis__Applications__c` records specifically — quick access to related Account, Contact, and Party records.

It is built with **vanilla HTML, CSS, and JavaScript only** — no frameworks, no build tools, no external libraries.

---

## 1. Technology Constraints

- Plain HTML, CSS, and Vanilla JavaScript only.
- **Not allowed:** React, Angular, Vue, TypeScript, Tailwind, Bootstrap, jQuery, build tools, or any external libraries.
- Must be lightweight, clean, fast, and easy to maintain.
- Chrome Extension using **Manifest V3**.

---

## 2. UI / Design Requirements

- Completely new, premium UI — should feel like a modern SaaS product, not a typical Salesforce utility bar.
- **Floating toolbar** positioned at the **top center** of the page.
- **Glassmorphism-inspired** design (frosted blur, translucency).
- Modern, layered shadows.
- Smooth hover and active-state animations.
- **Rounded, pill-shaped** layout.
- Premium, Salesforce-like styling and color palette.
- Responsive layout (adapts to narrow viewports).
- Compact but elegant — no clutter, no outdated button styles.
- Excellent spacing, typography, and iconography.
- Should look and feel like a polished, commercial-grade extension — good enough for daily use by Salesforce admins, business analysts, and loan-processing teams.

### Button Requirements

Every button must have:
- Hover animation
- Active (pressed) animation
- Tooltip on hover
- Icon + text label
- A loading state when data is being fetched

---

## 3. Visibility Rules

| Page Type | Buttons Shown |
|---|---|
| Any Salesforce record page | Classic, Lightning |
| `genesis__Applications__c` record page | Classic, Lightning, No Override, Party, Account, Contact, Open All |
| Non-record page | Toolbar does not appear |

---

## 4. Core Navigation Buttons

### Classic
- Opens the **current record** in Salesforce Classic.
- Opens in a **new tab**.
- Must work on **any** Salesforce record page (not just Applications).

### Lightning
- Opens the **current record** in Salesforce Lightning.
- Opens in a **new tab**.
- Must work on **any** Salesforce record page.

---

## 5. Application Record Logic (`genesis__Applications__c` only)

When the current record is a `genesis__Applications__c`, the extension must retrieve:
- Account Id
- Contact Id
- Party Id

### Account & Contact Lookup

Account and Contact are lookup fields directly on the Application object.

```sql
SELECT genesis__Account__c, genesis__Contact__c
FROM genesis__Applications__c
WHERE Id = '${appId}'
```

### Party Lookup

Party is **not** a direct lookup field — it must be queried from a related object.

```sql
SELECT Id
FROM clcommon__Party__c
WHERE genesis__Application__c = '${appId}'
LIMIT 1
```

---

## 6. Application-Specific Buttons

### No Override
- Visible only on `genesis__Applications__c` records.
- On click: opens the **current** Application record in a **new tab**.
- Appends `?nooverride=1` to the URL and remove `?sfdc.override=1` or any other override parameters.
- If override parameters already exist in the URL, they should be updated appropriately rather than duplicated.

### Account
- Opens the related Account record in a **new tab**.
- Always opens in **Classic** view, regardless of current view.

### Contact
- Opens the related Contact record in a **new tab**.
- Always opens in **Classic** view, regardless of current view.

### Party
- Opens the related Party record in a **new tab**.
- Always opens in **Classic** view, regardless of current view.

### Open All
- Opens all related records in separate tabs, immediately, in this order:
  1. No Override (current Application record)
  2. Account
  3. Contact
  4. Party

---

## 7. View Preference Rules

- The **preferred/default view is Classic** for related records.
- Account, Contact, and Party buttons must **always** open in Classic — never Lightning.
- The Classic and Lightning buttons must **explicitly force** the selected view, regardless of what view the user is currently in (Classic or Lightning).

---

## 8. Salesforce Access & Authentication

- Use the **currently authenticated Salesforce session** in the browser.
- Do **not** prompt the user for:
  - Username
  - Password
  - OAuth login
- Do **not** store credentials.
- Do **not** store access tokens.
- All data access goes through Salesforce REST APIs, riding on the existing authenticated browser session (`credentials: 'include'`).

---

## 9. Engineering Principles

- Keep the implementation simple.
- Avoid over-engineering, unnecessary abstractions, unnecessary modules, and unnecessary observers.
- Avoid excessive state management or complex architecture.
- Prioritize reliability and maintainability over cleverness.

### Final Result Should Be:
- Visually outstanding
- Extremely simple internally
- Fast
- Easy to debug
- Suitable for Salesforce Sandbox usage
- Production-quality user experience

---

## 10. Known Edge Cases (from real-world testing)

- **Visualforce / Apex pages:** Some Application records are viewed via custom VF pages (e.g. `/apex/ApplicationDetails?id=...`) rather than standard Lightning/Classic record URLs. The extension must detect these via a `VF_PAGE_OBJECT_MAP` lookup of known page names to object types.
- **Sandbox Classic navigation:** Lightning sandbox domains (`*.lightning.force.com`) must be correctly rewritten to their My Domain Classic equivalent (`*.my.salesforce.com`) so the Classic button and all "always open in Classic" buttons (Account, Contact, Party) work correctly inside sandboxes — not just production orgs.