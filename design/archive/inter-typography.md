---
version: "alpha"
name: "Inter Typography"
description: "Render a 2D isolated text on a solid background. Ideal for apps, dashboards, documentation, digital product needing maximum clarity.. AI-ready template."
colors:
  primary: "#FFFFFF"
  secondary: "#000000"
typography:
  h1:
    fontFamily: Inter
    fontSize: 2.5rem
    fontWeight: 700
  body-md:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: 400
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    padding: 12px
---

## Overview

Render a 2D isolated text on a solid background. Ideal for apps, dashboards, documentation, digital product needing maximum clarity.. AI-ready template. Inter started as a side project by Rasmus Andersson while he was at Figma — a typeface designed explicitly for computer screens. Not print adapted for digital. Not a geometric exercise. A workhorse built from pixel-level constraints upward. The tall x-height, open apertures, and tabular number sets weren't aesthetic choices — they were functional ones. Every decision optimized for legibility at small sizes on low-density displays.

Then something happened. Figma shipped Inter as its default. Vercel adopted it. Next.js made it a one-line import. Suddenly Inter wasn't just a good UI font — it was THE UI font. The new Helvetica of interfaces. You see it on every SaaS landing page, every developer tool, every startup that hasn't thought about typography yet.

Is that a problem? Honestly, not really. Inter is genuinely excellent at what it does. The issue isn't the typeface — it's the laziness of reaching for it without considering alternatives. When everything looks the same, nothing has personality. Inter gives you a perfect neutral baseline. Whether you stay there is a design decision, not a default.

- Density: 8/10 — Dense
- Variance: 4/10 — Moderate
- Motion: 4/10 — Subtle

- **Style:** System, product and UI workhorse
- **Keywords:** Inter, neutral, readable, UI, apps, dashboards, huge weight range
- **Era:** Contemporary Web
- **Light/Dark:** ✗ No / ✓ Full

## Colors

- **#FFFFFF** (#FFFFFF) — Primary surface or dominant color
- **#000000** (#000000) — Extended palette, decorative use


## Typography

- **Display / Hero:** Inter — Weight 700, tight tracking, used for headline impact
- **Body:** Inter — Weight 400, 16px/1.6 line-height, max 72ch per line
- **UI Labels / Captions:** Inter — 0.875rem, weight 500, slight letter-spacing
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

Tight tracking (-6%), 90% leading

- **Physics:** Ease-out curves, 200-300ms duration. Smooth and predictable.
- **Entry animations:** Fade + translate-Y (16px → 0) over 420ms ease-out. Staggered cascades for lists: 80ms between items.
- **Hover states:** Subtle color shift + shadow adjustment over 200ms.
- **Page transitions:** Fade only (200ms).
- **Performance:** Only transform and opacity animated. No layout-triggering properties.


## Shapes

Base corner radius: 8px. See rounded tokens in front matter for the full scale.


## Components

- **Primary Button:** Subtly rounded (0.5rem) shape. Accent color fill. Hover: 8% darken + subtle lift shadow. Active: -1px translate tactile press. Font weight 600. No outer glows.
- **Secondary / Ghost Button:** Outline variant. 1.5px border in muted color. Text in primary color. Hover: subtle background fill.
- **Cards:** Subtly rounded (0.5rem) corners. Surface background. Subtle shadow (0 2px 12px rgba(0,0,0,0.06)). 1px border stroke.
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

- Do Inter Font
- Do Color: #FFFFFF
- Do Tracking -6%
- Do Background #000000


## Use Case

Apps, Dashboards, documentation, digital product needing maximum clarity.

<!-- Source: https://designmd.app/library/inter-typography · designmd.app -->
