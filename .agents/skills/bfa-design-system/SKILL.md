---
name: bfa-design-system
description: Visual design tokens and component patterns for bfa-platform, extracted from the client-approved click-through prototype (role picker, Super Admin, Water Purveyor dashboard, Certifier wizard). Load before writing or reviewing any UI — new screens, components in packages/ui, or Tailwind theme changes — so the real Next.js app matches what the client has already seen and approved.
user-invocable: false
---

# bfa-platform Design System

Source: the client-approved HTML prototype. Full writeup with rationale lives at `apps/fumadocs/content/docs/design-system.mdx` — this is the compact version for coding.

## Colors

- Primary: `#2F6FED` (hover `#2A63D4`), tint `#EAF1FE`.
- Text: primary `#1D2129`, secondary `#6B7280`, tertiary `#9AA1AC`.
- Borders: strong `#E4E7EC`, soft `#EDEFF2`, input `#D9DDE3`, row divider `#F1F2F4`.
- Surfaces: page bg `#F4F5F7`, card/sidebar/modal `#FFFFFF`.
- Status pairs (text / bg): success `#16A34A` / `#DCFCE7`, danger `#DC2626` / `#FEE2E2`, warning `#D97706` / `#FEF3C7`, secondary accent `#0D9488` / `#CCFBF1`, purple (AG rate) `#7C3AED` / `#EDE9FE`.
- Rule: every accent is saturated text on a pale tint background — never a solid-fill badge or card.

## Typography

- Font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif` — no webfont.
- Body/UI 13–14.5px; page headings 15.5–20px/weight 700; input labels 12px `#6B7280`; badges 11px/weight 600.

## Spacing / radius

- Cards, tables, modals: radius 10–12px. Buttons, inputs: radius 8px. Badges/pills: radius 6px.
- Card border `1px solid #E4E7EC` + shadow `0 1px 2px rgba(16,24,40,0.04)` — never heavier.
- Card padding 16–24px; table cells `11px 16px`; inputs `10px 12px`.

## Layout

- Certifier: mobile-first, bottom tab bar under 780px; switches to the same 216px sidebar as WP/Admin at desktop width. Forms max-width 480px centered.
- WP / Super-Admin: fixed 216px white left sidebar, icon+label nav, active item = `#EAF1FE` bg + `#2F6FED` text/icon. Desktop-oriented.
- Impersonation state: full-width `#FEF3C7` banner, `#92400E` text, always visible (never in a menu) with an "Exit impersonation" link.

## Components

- **Stat card:** white, radius 12px, 3px colored top accent bar, tinted icon chip (32–38px), 12px muted label, 24px/700 number.
- **Table:** header `#FAFBFC` bg + `#E4E7EC` bottom border, 12px/600 muted labels; rows divided by `#F1F2F4`; clickable rows hover `#FAFBFF`.
- **Badge:** pill, 11px/600, `padding:3px 9px`, `radius:6px`, status color pair from above.
- **Buttons:** primary = `#2F6FED` fill/white text/radius 8/weight 600, hover `#2A63D4`. Secondary = white fill + `1px solid #D9DDE3` border, same radius/weight.
- **Inputs:** `1px solid #D9DDE3`, radius 8px, `10px 12px`, 14px text. Read-only/auto-filled fields: flat `#F1F2F4` bg + `#6B7280` text, not a greyed-disabled look.
- **Modal:** centered white card, radius 12px, 24px padding, backdrop `rgba(16,24,40,0.45)`.
- **Wizard progress:** row of 5px rounded segments, filled `#2F6FED` through the current step, `opacity:0.5` beyond it; 12px muted step label below.
- **Icons:** Lucide-style stroke icons only, stroke-width 1.6–2.2, 14–26px. Do not mix icon families.

## How to apply

- Map these tokens onto Tailwind theme / CSS variables in `packages/ui/src/styles/globals.css` — do not hardcode hex values in components.
- Reuse shadcn/ui primitives from `packages/ui` (`Button`, `Badge`, `Card`, `Table`, `Dialog`) restyled to these tokens, rather than re-deriving a look per screen.
- Where the prototype and a shadcn default disagree, the prototype wins — it's what the client already approved.
