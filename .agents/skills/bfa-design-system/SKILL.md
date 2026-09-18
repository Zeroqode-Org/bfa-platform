---
name: bfa-design-system
description: Visual design tokens and component patterns for bfa-platform, extracted from the client-approved click-through prototype (role picker, Super Admin, Water Purveyor dashboard, Certifier wizard). Load before writing or reviewing any UI — new screens, components in packages/ui, or Tailwind theme changes — so the real Next.js app matches what the client has already seen and approved.
user-invocable: false
---

# bfa-platform Design System

Source: the client-approved HTML prototype (layout/components) plus the client's pixel-verified theme sheet, which set the final colour palette (cyan-blue primary, cool blue-grey neutrals). Full writeup with rationale lives at `apps/fumadocs/content/docs/design-system.mdx` — this is the compact version for coding.

## Colors

- Primary: `#1588C1` (hover `#11719E`), contrast text `#FFFFFF`, tint `#D9F0FC` with `#0E5A81` text.
- Text: primary `#1B242D`, secondary `#687A8D`, tertiary `#9AA7B2`.
- Borders: strong `#E1E6EA`, soft `#EEF1F4`, input `#D5DBE1`, row divider `#EEF1F4`.
- Surfaces: page bg `#F5F8FA`, card/sidebar/modal `#FFFFFF`.
- Status pairs (text / tint bg): success `#29A36A` / `#E1F4EA`, danger `#DD2C3B` / `#FBE4E6`, warning `#F3A216` / `#FDEFD5`, secondary accent `#0D9488` / `#CCFBF1`, purple (AG rate) `#7C3AED` / `#EDE9FE`.
- Impersonation banner: `#FEF3C7` bg / `#92400E` text.
- Rule: every accent is saturated text on a pale tint background — never a solid-fill badge or card.

## Typography

- Two families, split by role not by section: **Inter** for everything (nav, card/section titles, body, table, buttons, badges, inputs); **Sora** only for the page-level H1 title. A card title directly under the page title still renders in Inter.
- Load both via `next/font/google` in the app shell.
- Body/UI 13–14.5px; section/card headings (Inter) 15.5–20px/weight 700; page title (Sora) 22–28px/weight 700; input labels 12px `#687A8D`; badges 11px/weight 600.

## Spacing / radius

- Cards, tables, modals: radius 10–12px. Buttons, inputs: radius 8px. Badges/pills: radius 6px.
- Card border `1px solid #E1E6EA` + shadow `0 1px 2px rgba(27,36,45,0.05)` — never heavier.
- Card padding 16–24px; table cells `11px 16px`; inputs `10px 12px`.

## Layout

- Certifier: mobile-first, bottom tab bar under 780px; switches to the same 216px sidebar as WP/Admin at desktop width. Forms max-width 480px centered. Exception: Profile — left-aligned (not centered), capped 640px, Contact info pairs its fields into a two-column grid.
- WP / Super-Admin: fixed 216px white left sidebar, icon+label nav, active item = `#D9F0FC` bg + `#0E5A81` text/icon. Desktop-oriented.
- Impersonation state: full-width `#FEF3C7` banner, `#92400E` text, always visible (never in a menu) with an "Exit impersonation" link.

## Components

- **Stat card:** white, radius 12px, 3px colored top accent bar, tinted icon chip (32–38px), 12px muted label, 24px/700 number.
- **Table:** header `#EFF3F5` bg + `#E1E6EA` bottom border, 12px/600 muted labels; rows divided by `#EEF1F4`; clickable rows hover `#F4FAFD`.
- **Badge:** pill, 11px/600, `padding:3px 9px`, `radius:6px`, status color pair from above.
- **Buttons:** primary = `#1588C1` fill/white text/radius 8/weight 600, hover `#11719E`. Secondary = white fill + `1px solid #D5DBE1` border, same radius/weight.
- **Inputs:** `1px solid #D5DBE1`, radius 8px, `10px 12px`, 14px text. Read-only/auto-filled fields: flat `#E7EBEF` bg + `#687A8D` text, not a greyed-disabled look.
- **Modal:** centered white card, radius 12px, 24px padding, backdrop `rgba(16,24,40,0.45)`.
- **Wizard progress:** row of 5px rounded segments, filled `#1588C1` through the current step, `opacity:0.5` beyond it; 12px muted step label below.
- **Icons:** Lucide-style stroke icons only, stroke-width 1.6–2.2, 14–26px. Do not mix icon families.

## Layout reference

`reference/prototype-layout.html` (next to this file) has the client-approved prototype's screen-by-screen structure — role picker, Super Admin, Certifier dashboard/wizard/profile, WP dashboard's 7 sections. Use it for composition and step sequence only — its inline colors/fonts are the *original* prototype's and are superseded by the tokens above.

## How to apply

- Map these tokens onto Tailwind theme / CSS variables in `packages/ui/src/styles/globals.css` — do not hardcode hex values in components.
- Reuse shadcn/ui primitives from `packages/ui` (`Button`, `Badge`, `Card`, `Table`, `Dialog`) restyled to these tokens, rather than re-deriving a look per screen.
- Where the prototype and a shadcn default disagree, the prototype wins — it's what the client already approved.
