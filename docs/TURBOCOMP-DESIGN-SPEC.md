# Turbocomp — Design Specification

> Rebrand of TCG Toolkit → **Turbocomp**
> Inventory, register, and trade-ins for trading card shops.

---

## Brand overview

Turbocomp is a multi-tenant SaaS platform for trading card game stores. The rebrand replaces every instance of "TCG Toolkit" throughout the application with "Turbocomp" while introducing a new icon (speed gauge) and refined color palette.

The name "Turbocomp" combines **turbo** (speed, performance) with **comp** (competitive, comprehensive). The speed gauge icon reinforces this — the needle pushed into the orange "redline" zone communicates maximum performance.

---

## Logo and icon

### Icon concept

A speed gauge / speedometer with:

- An arc that transitions from **dark green → green → orange** (left to right)
- A **needle** angled into the orange "hot zone" (upper right)
- A **center hub** with green accent
- **Rounded square** container with dark card background

### Icon files

All icons are in the `icons/` directory:

| File | Size | Usage |
|------|------|-------|
| `turbocomp-icon.svg` | Scalable | Source vector — full detail |
| `turbocomp-favicon.svg` | Scalable | Simplified vector for small renders |
| `favicon-16.png` | 16×16 | Browser favicon |
| `favicon-32.png` | 32×32 | Browser favicon @2x |
| `icon-48.png` | 48×48 | Standard UI icon |
| `icon-64.png` | 64×64 | Sidebar / nav header |
| `icon-80.png` | 80×80 | Marketing materials |
| `icon-120.png` | 120×120 | Hero / feature sections |
| `icon-180.png` | 180×180 | Apple touch icon |
| `icon-192.png` | 192×192 | Android / PWA manifest |
| `icon-256.png` | 256×256 | High-res UI |
| `icon-512.png` | 512×512 | PWA manifest / app store |
| `social-card-bg.png` | 592×592 | Social / OG image base |
| `color-palette.png` | 600×200 | Color reference swatch |

### Scaling rules

- **16–32px**: Use simplified favicon SVG. Only two arc segments (green + orange), thicker strokes, no tick marks. Hub is a solid green dot.
- **48–64px**: Use full icon SVG. Two-tone hub (outline + center dot), cleaner arc segments.
- **80px+**: Full detail with tick marks, three-segment arc (dark green → green → orange), detailed hub.

---

## Color palette

### Primary colors

| Token | Hex | RGB | Usage |
|-------|-----|-----|-------|
| `--color-navy-bg` | `#0B1120` | `rgb(11, 17, 32)` | Page background, app shell |
| `--color-card-bg` | `#1A2332` | `rgb(26, 35, 50)` | Cards, sidebar, icon backgrounds |
| `--color-track` | `#1E2A3A` | `rgb(30, 42, 58)` | Borders, inactive elements, input backgrounds |

### Accent colors

| Token | Hex | RGB | Usage |
|-------|-----|-----|-------|
| `--color-green-dark` | `#1D9E75` | `rgb(29, 158, 117)` | Secondary green, gauge start |
| `--color-green` | `#2DD4A8` | `rgb(45, 212, 168)` | **Primary accent** — buttons, active states, links, gauge main arc |
| `--color-orange-mid` | `#EF9F27` | `rgb(239, 159, 39)` | Transitional orange, warnings |
| `--color-orange` | `#E8773A` | `rgb(232, 119, 58)` | **Contrast accent** — needle, highlights, profit indicators, gauge hot zone |

### Text colors

| Token | Hex | RGB | Usage |
|-------|-----|-----|-------|
| `--color-text` | `#E2E8F0` | `rgb(226, 232, 240)` | Primary text (headings, body) |
| `--color-text-muted` | `#64748B` | `rgb(100, 116, 139)` | Secondary text, labels, hints |
| `--color-text-dim` | `#475569` | `rgb(71, 85, 105)` | Tertiary text, footer, disabled |

### Semantic colors

| Token | Hex | Mapped from | Usage |
|-------|-----|-------------|-------|
| `--color-success` | `#2DD4A8` | Green | Positive actions, confirmations |
| `--color-warning` | `#EF9F27` | Orange Mid | Warnings, attention needed |
| `--color-danger` | `#E8773A` | Orange | Errors, destructive actions |

### Color application rules

1. **Green** (`#2DD4A8`) is the primary interactive color. All buttons, active nav items, links, and CTA elements use this.
2. **Orange** (`#E8773A`) is the contrast/highlight color. Use for: profit potential indicators, the gauge needle, hover accents, and secondary emphasis.
3. **Never use orange for primary CTAs.** Green is always the primary action color.
4. **Stat labels** in dashboard cards use green for neutral metrics (market value, cost basis) and orange for performance metrics (profit potential).
5. **Text on dark backgrounds** uses `#E2E8F0` for primary and `#64748B` for secondary. Never use pure white (`#FFFFFF`).

![Color palette reference](icons/color-palette.png)

---

## Typography

The app uses the system font stack. No custom web fonts are required.

```css
--font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
--font-mono: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace;
```

### Scale

| Element | Size | Weight | Color |
|---------|------|--------|-------|
| Page title (h1) | 24px | 600 | `--color-text` |
| Section title (h2) | 18px | 500 | `--color-text` |
| Body text | 14px | 400 | `--color-text` |
| Labels / hints | 12px | 400 | `--color-text-muted` |
| Stat labels | 10px | 600 | `--color-green` or `--color-orange` |
| Stat values | 18–24px | 600 | `--color-text` |
| Nav items | 14px | 400 (inactive) / 500 (active) | `--color-text-muted` / dark on green bg |

---

## Component specifications

### Sidebar navigation

```
Width: 170px (fixed)
Background: --color-navy-bg
Border-right: 1px solid --color-track
```

**Header (logo lockup):**
- Icon: 28×28px gauge icon (use turbocomp-icon.svg or icon-64.png scaled)
- Text: "Turbocomp" — 15px, weight 500, `--color-text`
- Gap between icon and text: 8px
- Padding: 16px horizontal, 20px bottom

**Nav items:**
- Height: 36px
- Padding: 8px 14px
- Font: 13px, weight 400
- Inactive: `--color-text-muted`
- Active: `--color-green` background, `--color-navy-bg` text, weight 500
- Active border-radius: 0 8px 8px 0 (right side only)
- Icons: 15px, inline before text, 8px gap

**Nav item order:**
1. Transactions
2. Inventory
3. Analytics
4. Settings

### Primary button (CTA)

```css
background: #2DD4A8;
color: #0B1120;
border: none;
border-radius: 8px;
padding: 12px 32px;
font-size: 14px;
font-weight: 500;
```

### Secondary button

```css
background: #1E2A3A;
color: #E2E8F0;
border: 1px solid #2A3A4A;
border-radius: 8px;
padding: 12px 32px;
font-size: 14px;
font-weight: 400;
```

### Dashboard stat cards

```
Container: 1px solid --color-track, border-radius 8px, padding 10px 12px
Label: 9–10px, uppercase, letter-spacing 1px, weight 600
  - Default label color: --color-green
  - Profit/performance label color: --color-orange
Value: 16–18px, weight 600, --color-text
Hint text: 10px, --color-text-dim
```

### Input fields

```css
background: #1E2A3A;
border: 1px solid #2A3A4A;
border-radius: 6px;
color: #E2E8F0;
padding: 8px 12px;
font-size: 14px;
/* Focus state */
border-color: #2DD4A8;
```

---

## Landing page layout

The landing page is vertically centered on the viewport with the following structure:

1. **Icon** — 48×48px gauge icon, centered
2. **Title** — "Turbocomp" — 28px, weight 600, `--color-text`
3. **Subtitle** — "Inventory, register, and trade-ins for trading card shops." — 14px, `--color-text-muted`
4. **CTA buttons** — "Create a shop" (primary) + "Sign in" (secondary), side by side, 12px gap
5. **Hint text** — "New here? Create a shop to set up your store, locations, and integrations." — 12px, `--color-text-dim`

Background: `--color-navy-bg` full viewport.

---

## Wordmark

When the full wordmark is used (marketing, social, landing hero), the name can be displayed with split coloring:

- **TURBO** in `--color-green` (`#2DD4A8`)
- **COMP** in `--color-orange` (`#E8773A`)

Letter-spacing: 3–4px. Weight: 500.

This split-color treatment is optional and for marketing contexts only. In-app, the sidebar header and page titles use plain `--color-text` for the name.

---

## Refactoring checklist

When renaming TCG Toolkit → Turbocomp across the codebase:

### Text replacements

| Find | Replace with |
|------|-------------|
| `TCG Toolkit` | `Turbocomp` |
| `tcg-toolkit` | `turbocomp` |
| `tcgToolkit` | `turbocomp` |
| `TCG_TOOLKIT` | `TURBOCOMP` |

### File updates

- [ ] `index.html` — `<title>`, meta tags, OG tags, favicon links
- [ ] `manifest.json` / `manifest.webmanifest` — name, short_name, icons array
- [ ] Sidebar component — logo icon + text
- [ ] Landing/login page — icon, title, subtitle
- [ ] Favicon files — replace with new gauge icons
- [ ] Apple touch icon — `icon-180.png`
- [ ] OG image / social card — use `social-card-bg.png` as base
- [ ] Any email templates referencing the old name
- [ ] README.md
- [ ] package.json — name field

### Assets to replace

- [ ] Replace existing favicon with `turbocomp-favicon.svg` or `favicon-32.png`
- [ ] Replace sidebar icon with `turbocomp-icon.svg` or `icon-64.png`
- [ ] Replace landing page icon with `turbocomp-icon.svg` or `icon-48.png`
- [ ] Add `icon-192.png` and `icon-512.png` to PWA manifest
- [ ] Add `icon-180.png` as Apple touch icon

### Color updates (if not already matching)

The existing app already uses a dark navy + green accent palette. Verify these tokens match:

- Page background: `#0B1120`
- Card/sidebar background: `#1A2332`
- Borders: `#1E2A3A`
- Primary accent (buttons, active states): `#2DD4A8`
- Introduce orange accent `#E8773A` for profit indicators and secondary highlights

---

## Brand voice (for reference)

- **Tagline**: "Inventory, register, and trade-ins for trading card shops."
- **Alternative tagline** (marketing): "TCG performance platform"
- **Tone**: Professional but approachable. Built by a vendor, for vendors.
- **Name pronunciation**: TUR-bo-comp (rhymes with "stomp")
