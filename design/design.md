---
version: "alpha"
name: "Lovable Cream Humanist"
description: "Lovable-inspired warm landing page. Ideal for ai builders, ferramentas no-code, plataformas amigáveis, dev tools approachable. AI-ready template."
colors:
  primary: "#f7f4ed"
  secondary: "#1c1c1c"
  tertiary: "#fcfbf8"
  neutral: "#eceae4"
  surface: "#5f5f5d"
  accent: "#3b82f6"
typography:
  h1:
    fontFamily: system-ui
    fontSize: 2.25rem
    fontWeight: 700
  body-md:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 400
  label-caps:
    fontFamily: system-ui
    fontSize: 0.75rem
    fontWeight: 500
rounded:
  sm: 6px
  md: 12px
  lg: 18px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
    padding: 12px
---

## Overview

Lovable-inspired warm landing page. Ideal for ai builders, ferramentas no-code, plataformas amigáveis, dev tools approachable. AI-ready template. The cream humanist aesthetic didn't emerge from a single moment — it's the quiet rebellion against the cold, clinical interfaces that dominated the 2010s. When every SaaS product looked like a sterile hospital dashboard, designers started reaching back to print traditions: warm off-whites, humanist typefaces with visible pen strokes, and generous whitespace that actually breathes.

The lineage traces through early Mailchimp (before the rebrand flattened it), the original Slack palette, and indie apps like Notion in its softer early days. These products understood something fundamental: people don't want to feel like they're operating machinery. They want to feel like they're using something made by humans, for humans. The cream background isn't just an aesthetic choice — it reduces eye strain and signals 'this space is yours, relax.'

What makes this system distinct from generic 'friendly UI' is its restraint. It's not playful to the point of being unserious. The warmth comes from typography and color temperature, not from illustrations of people high-fiving. It earns trust through craft, not performance.

- Density: 5/10 — Balanced
- Variance: 4/10 — Moderate
- Motion: 4/10 — Subtle

- **Style:** Warm Cream, Humanist Font, Opacity-Driven Colors, Inset Shadows, Pill Icons
- **Keywords:** lovable, cream, humanist, opacity-driven, inset shadows, pill icons, warm borders, Camera Plain, shadcn, approachable
- **Era:** 2024-2026 Approachable Dev Tool
- **Light/Dark:** ✓ Full / ✗ Not Recommended

## Colors

- **Creme** (#f7f4ed) — Primary surface or dominant color
- **Charcoal** (#1c1c1c) — Dark surface, primary background
- **Off-White** (#fcfbf8) — Light surface, card backgrounds
- **Borda Creme** (#eceae4) — Supporting palette color
- **Cinza Muted** (#5f5f5d) — Secondary text, borders, muted elements
- **Ring Blue** (#3b82f6) — Secondary accent
- **Borda Interativa** (rgba(28,28,28,0.4)) — Extended palette, decorative use
- **Tint** (rgba(28,28,28,0.04)) — Extended palette, decorative use


## Typography

- **Display / Hero:** system-ui — Weight 700, tight tracking, used for headline impact
- **Body:** system-ui — Weight 400, 16px/1.6 line-height, max 72ch per line
- **UI Labels / Captions:** system-ui — 0.875rem, weight 500, slight letter-spacing
- **Monospace:** JetBrains Mono — Used for code, metadata, and technical values

Scale:
- Hero: clamp(2.5rem, 5vw, 4rem)
- H1: 2.25rem
- H2: 1.5rem
- Body: 1rem / 1.6
- Small: 0.875rem


## Layout

- **Grid:** CSS Grid primary. Max-width containment: 1280px centered with 1.5rem side padding.
- **Spacing rhythm:** Balanced. Base unit: 0.5rem (8px).
- **Section vertical gaps:** clamp(4rem, 8vw, 8rem).
- **Hero layout:** Split-screen (text left, visual right).
- **Feature sections:** Zig-zag alternating text+image rows. No 3-equal-columns.
- **Mobile collapse:** All multi-column layouts collapse below 768px. No horizontal overflow.
- **z-index contract:** base (0) / sticky-nav (100) / overlay (200) / modal (300) / toast (500).


## Elevation & Depth

Canvas creme quente (#f7f4ed) como caderno premium. Font humanista com terminais arredondados e curvas orgânicas. Sistema de cores baseado em opacidade — todos os cinzas derivados de #1c1c1c em transparências variadas. Inset shadows em botões (rgba(255,255,255,0.2) 0px 0.5px inset + rgba(0,0,0,0.2) 0px 0px 0.5px inset). Bordas quentes (#eceae4). Pill icons (9999px). Variable font com peso 480 intermediário.

- **Physics:** Ease-out curves, 200-300ms duration. Smooth and predictable.
- **Entry animations:** Fade + translate-Y (16px → 0) over 420ms ease-out. Staggered cascades for lists: 80ms between items.
- **Hover states:** Subtle color shift + shadow adjustment over 200ms.
- **Page transitions:** Fade only (200ms).
- **Performance:** Only transform and opacity animated. No layout-triggering properties.


## Shapes

Base corner radius: 6px. See rounded tokens in front matter for the full scale.


## Components

- **Primary Button:** Pill-shaped (9999px) shape. Accent color fill. Hover: 8% darken + subtle lift shadow. Active: -1px translate tactile press. Font weight 600. No outer glows.
- **Secondary / Ghost Button:** Outline variant. 1.5px border in muted color. Text in primary color. Hover: subtle background fill.
- **Cards:** Pill-shaped (9999px) corners. Surface background. Subtle shadow (0 2px 12px rgba(0,0,0,0.06)). 1px border stroke.
- **Inputs:** Label above input. 1px border stroke. Focus ring: 2px accent color offset 2px. Error text below in semantic red. No floating labels.
- **Navigation:** Primary surface background. Active item: accent color indicator. Font weight 500 when active.
- **Skeletons:** Shimmer animation matching component dimensions. No circular spinners.
- **Empty States:** Icon-based composition with descriptive text and action button.


## Do's and Don'ts

- No emojis in UI — use icon system only (Lucide, Heroicons)
- No pure black (#000000) — use off-black or charcoal variants
- No oversaturated accent colors (saturation cap: 80%)
- No 3-column equal-width feature layouts — use zig-zag or asymmetric grid
- No `h-screen` — use `min-h-[100dvh]`
- No AI copywriting clichés: "Elevate", "Seamless", "Unleash", "Next-Gen"
- No broken external image links — use picsum.photos or inline SVG
- No generic lorem ipsum in demos

- Do Fundo creme #f7f4ed
- Do Font humanista
- Do Cores baseadas em opacidade
- Do Inset shadows em botões
- Do Bordas quentes
- Do Pill icons 9999px
- Do Variable font weight 480
- Do Responsivo


## Use Case

AI builders, Tools no-code, Platforms amigáveis, Dev tools approachable

<!-- Source: https://designmd.app/library/lovable-cream-humanist · designmd.app -->
