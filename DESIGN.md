# Cravio design direction (v2: white)

Status: adopted. v1 ("Service-grade Swiss": dark rail, ember blocks) was
reviewed by an independent critique on 2026-11-12. It scored between 0.5 and
4 out of 10 per surface against Toast, Square, Lightspeed, SevenRooms,
Linear, Stripe and Polaris. v2 replaces it. Page bodies remain placeholders,
but every placeholder is now a designed page frame.

## 1. Users and scenes

| Person | Surface | Scene | Needs |
| --- | --- | --- | --- |
| Owner / manager | `/owner` desktop and tablet | Back office; tablet at the pass in service | Find any area in one click, read state at a glance |
| Cravio team | `/admin` desktop | Office, long sessions | Dense, calm, unmistakably an internal tool |
| Waiter | `/waiter` phone | On the floor, one hand, dim rooms | Big targets, obvious current tab |
| Guest | `/guest-menu` phone | At the table after scanning a QR code | The restaurant's brand and food, not Cravio's |
| Prospect | `/` | Evaluating the product | What it is, what it looks like, how to get in |

## 2. Critique: what drove v2

The critique's top findings and our response:

| # | Finding | Response in v2 |
| --- | --- | --- |
| 1 | Placeholder words shown as content ("Name / Status · Location") | Missing place data renders as skeleton bars, never field names |
| 2 | Every page is the same empty box | Each page gets a designed frame: header, purpose line, toolbar skeleton, content skeleton shaped like its future data, and an honest "layout preview" note |
| 3 | The ember blocks read as missing images | Removed. Ember is used only at logo size and for unread or live dots |
| 4 | Photographs unused | Sign-in is a card over the dining-room photo. The landing page is image-led. Guest menu has a cover photo |
| 5 | Landing can't explain the product | Image-led hero, three role sections with photography, a photo band, and a real footer |
| 6 | Dark rail vs the white-theme request | White sidebar and top bar on a `#F7F7F5` ground |
| 7 | Active nav item invisible (1.12:1) | Filled active row, bold ink label and icon |
| 8 | Sign-in errors in a toast on the seam | Inline error above the button, with fields marked invalid |
| 9 | Contrast and tap targets | Input border at 3.3:1; nav rows 40px; badge text 11px |
| 10 | No system: 15 font sizes, 9 radii | 7 sizes (12/13/14/16/20/24/32) plus display; radii 6/8/12/round |

Also adopted:
- Toasts sit bottom-right on desktop and bottom-centre on phones.
- The Cravio admin gets a permanent "Cravio internal" strip.
- Labels use sentence case.
- The role pill is removed.
- The profile menu gets an identity header.
- "Log out" is neutral ink, not red.
- Notification popover: actions move to the header and the redundant close button is removed.
- The waiter tab bar uses an iOS-style active state, not a Material pill.
- Waiter placeholders are shaped like tables, service rows and menu rows.
- Icons are redrawn: tables, products, guest menu (QR), help.

Deferred, because each needs data or new functionality that this pass
doesn't add:
- location switcher
- global search / ⌘K
- service-status chip
- SSO buttons
- show-password toggle and "remember device"
- seeded sample notifications
- removing the refresh control
- collapsed tablet rail
- "Book a demo" flow and legal pages

The "Login successful" toast stays because it is existing, tested behaviour.
It is the obvious next candidate for removal.

## 3. System

**Palette** (`frontend/src/index.css`)

| Role | Token | Value |
| --- | --- | --- |
| Ground | `--paper` | `#F7F7F5` |
| Surface | `--surface` | `#FFFFFF` |
| Ink / secondary / muted | `--ink` `--ink-2` `--muted` | `#111110` `#45423C` `#6F6B63` (4.9:1 on ground) |
| Lines | `--line` `--line-strong` `--field` | `#E7E5E0` `#D6D3CC` `#8F8A80` (inputs, 3.3:1) |
| Hover / selected | `--hover` `--selected` | `#F2F1EE` `#ECEBE7` |
| Skeleton | `--skeleton` | `#EEEDE9` |
| Signal | `--ember` | `#D9431E`: logo square, unread, live, focus ring |
| State | `--success` `--warning` `--danger` | `#17734A` `#9A6408` `#B42318` |

**Type.** Geist Variable only.

| Size | Use |
| --- | --- |
| 12 | Group labels, meta |
| 13 | Secondary text |
| 14 | Product body text and UI |
| 16 | Marketing body text |
| 20 | Section titles |
| 24 | Page titles |
| 32 | Auth and marketing headings |

Display sizes are used on the landing page only. Numbers in tables use
tabular figures.

**Shape.**
- Radii are 6px for controls, 8px for rows and menus, 12px for cards, panels and sheets, and fully round for avatars and dots only.
- Elevation is declared once: a hairline for panels, or a soft shadow for floating layers.

**Motion.** 150–220ms with ease-out. The landing page has one entrance.
Skeletons are static, because they are layout previews, not loading
states.

## 4. Surfaces

| Surface | Design |
| --- | --- |
| Landing | Image-led hero: copy and Sign in on the left, a photo mosaic of the dining room, dishes and kitchen on the right. Then "One platform, every role" with three photo cards, a full-width interior photo band with one line of type, and a footer. |
| Sign-in / forgot / reset | Full-bleed dining-room photo with a directional ink gradient. A 440px white card, left of centre on desktop and centred on mobile. Inline errors. A small © line over the photo. |
| Shell | Floating glass sidebar (256px, 12px inset, 22px radius; squircle corners via `corner-shape` where supported) over a softly lit ground. Tabs are squircle rows: the active tab is a raised glass tile with an ink icon tile. The top bar is a glass fade with the actions in a glass pill. Admin gets a 32px ink "Cravio internal" strip. |
| Page frame | Title (24px) and one-line purpose, a toolbar skeleton, then a content skeleton by kind: metrics, table, floor, form or support. A muted "Layout preview" note says data isn't connected yet. |
| Products | A **category rail**: a floating glass column of squircle icon tiles with labels (All products, Starters, Main course, Desserts, Drinks, Promotions), driven by `?category=`. Below it sits a separate dashed **+** circle for adding a category, which shows an info toast until menu data exists. Below 1024px the rail becomes a horizontal pill with the + beside it. The product list has a skeleton table with image squares. |
| Waiter | White 56px header with the restaurant name. Paper ground. Tab-shaped skeletons. iOS-style tab bar with an ink indicator above the active tab. |
| Guest menu | Cover photo, title, category chip skeleton, menu row skeletons, "Powered by Cravio". |

## 5. Round 2 (critique 2026-11-12, scored 45–50%)

Adopted:
- **Global search** (`components/search/GlobalSearch.jsx`, `config/search.js`):
  - opened with ⌘K, Ctrl+K or `/`, or from the profile menu;
  - results grouped once per query, with matched characters highlighted and keyword hits explained ("Matches 'sales'");
  - "Log out" never outranks navigation and needs ↵ twice;
  - Escape clears the query, then closes; Tab or PageUp/PageDown jump between groups;
  - recents include scoped queries;
  - screen readers get a live result count, and descriptions are announced as descriptions, not part of the name;
  - scoped record searches open the page with `?q=`, which shows the query in the page's own search field and an inline "No … match yet" row.
- **One material and one corner scale:**
  - glass on the sidebar and overlays only;
  - content and menus opaque white;
  - flat `#F7F7F5` ground;
  - shell and cards squircle 32/24 (fallback 18/14), rows and controls squircle 16/12 (fallback 10/8);
  - no dashed controls.
- **One "Preview" chip** (top bar and waiter page title) replaces six separate disclaimers.
- **Navigation:**
  - unlabelled top group: Overview, Orders, Tables;
  - Menu: Products, Menu configuration, Guest menu;
  - Analytics: Insights;
  - footer: Settings, Contact Cravio, profile;
  - the breadcrumb is removed (the page title already says where you are);
  - the profile menu gains a Search shortcut.
- **Static UI uses real labels:** toolbar filters, settings sections and fields (with the account's real name and email), the floor-plan legend, the waiter's "My tables / All tables" and "Done".
- **Place card:** "Your restaurant — Add name and location" links to Settings, instead of skeleton bars that never resolve.

Still deferred: a location switcher, real sample data, Book a demo and legal pages, SSO, removing the Refresh control, and removing the "Login successful" toast.
