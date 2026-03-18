# UI Palette Plan — Replace the Design System Colors

## Context

The design guide (DESIGN_USAGE_GUIDE_V2.md) defines a complete dark-mode color system built around **teal/cyan surfaces (~184° hue) + a green-cyan accent (#19DFAE at ~165°)**. The goal is to swap the entire hue family to a new one, keeping the same structure, brightness levels, and saturation so that every token maps 1:1 to its replacement.

Everything else in the design guide (typography, spacing, radius, borders, shadows, component patterns) stays exactly as-is.

---

## Current Palette — HSL Fingerprint

This is the data you need to match in a replacement palette.

### Surface colors (backgrounds / panels)

| Token | Hex | H | S | L | Role |
|---|---|---|---|---|---|
| `nightGreenDark` | `#001A1C` | 184° | 100% | 5.5% | Darkest bg, gradient start |
| `darkGreen` | `#071F21` | 184° | 65% | 7.8% | Tertiary surface, gradient end |
| `deepGreen` | `#00272C` | 187° | 100% | 8.6% | Secondary surface (inputs, drawers) |
| `midnightGreen` | `#003235` | 184° | 100% | 10.4% | Primary surface (cards, modals) |
| `nightGreen` | `#034C51` | 184° | 93% | 16.5% | Mid-tone accent surface (rare) |

**Pattern:** All surfaces cluster around 183–187°, fully or near-fully saturated, lightness 5–16%. They step up in 1.5–6% L increments.

### Accent colors (the "one color that does everything")

| Token | Hex | H | S | L | Role |
|---|---|---|---|---|---|
| `dataGreen25OnDarkGreen` | `#0b4f45` | 169° | 64% | 18% | Solid equivalent of 25% accent on dark bg |
| `midDataGreen` | `#2AD19F` | 162° | 66% | 49% | Mid accent (between main and bright) |
| `dataGreen` | `#19DFAE` | 165° | 80% | 49% | **The accent** — all interactive elements |
| `dataGreenBright` | `#5FF6CC` | 163° | 89% | 67% | Hover/active brighter variant |
| `dataGreenLight` | `#E8FAF5` | 158° | 67% | 94% | Very light tint (rare) |

**Pattern:** Accent hue ~165°, roughly 20° offset from surface hue (~184°). Main accent is ~49% L / 80% S. Bright variant is same hue, ~67% L. Light tint is ~94% L.

### Opacity variants (derived — follow automatically)

The opacity tokens (`dataGreen05`, `dataGreen25`, `darkGreen50`, etc.) are just rgba() of the base hexes. When you replace the base hex, update the rgba values using the same opacity levels. No separate matching needed.

### Utility / semantic

| Token | Hex | Notes |
|---|---|---|
| `coolGray` | `#808A89` | Neutral hover bg. Can keep or adjust slightly toward new hue. |
| `persimmon` | `#C63131` | Error red. **Keep as-is** — semantic error color, not part of the hue theme. |

### White scale
`white`, `white90`, `white75`, `white50`, `white25` — **keep as-is**. Text colors are always white opacity variants.

---

## Replacement Strategy

### The constraint
A replacement palette must preserve the **same relative brightness steps** between surfaces and the same **accent brightness/saturation**. The hue can change completely, but the HSL geometry must mirror the original.

### What to match per-slot

| Slot | Must match | Can differ |
|---|---|---|
| Surface 1–5 | L within ±2%, S within ±10% | H freely |
| Accent main | L ~49%, S ~80% | H freely |
| Accent bright | L ~67%, S ~89% | H freely |
| Accent light | L ~94% | H freely |
| Solid equivalent | L ~18%, S ~60% | H freely |
| Surface/accent hue gap | ~20° offset between surface hue and accent hue | Gap direction can vary |

### Structural note
The `glowBoxStyles` gradient in the design guide uses `rgba(25, 223, 174, 0.05)` — this hardcodes the accent RGB. When replacing, update the rgba values in that gradient to match the new accent hex.

---

## Palette Generation Tools

For generating and validating the replacement palette:

| Tool | URL | Best for |
|---|---|---|
| **Realtime Colors** | realtimecolors.com | Visualize palette on real UI components — start here |
| **ColorBox by Lyft** | colorbox.io | Parametric HSL curve control for building exact scales |
| **OKLCH.fyi** | oklch.fyi | Perceptually uniform brightness across hues (recommended for matching L) |
| **Atmos** | atmos.style/playground | OKLCH palette builder + shade generation |
| **Radix Colors** | radix-ui.com/colors | Pre-built 12-step dark/light scales, custom palette generator |
| **Coolors** | coolors.co | Quick exploration, press spacebar to iterate |
| **tints.dev** | tints.dev | HSL-controlled scales, useful for accent shade series |

**Recommended flow:**
1. Pick a target hue in **OKLCH.fyi** — adjust L to match the surface slots (5%, 8%, 10%, 16%) and check they look right perceptually
2. Use **ColorBox** to fine-tune the accent scale (mid → main → bright → light tint)
3. Drop the full palette into **Realtime Colors** to see it on actual UI before committing

---

## Swap Execution Plan

Once a palette is chosen, replacing it in the design guide is a direct find-and-replace operation — every hex value appears with its token name. The steps:

### Step 1 — Build the mapping table

Create a table with every old hex → new hex:

```
#001A1C → ?   (nightGreenDark)
#071F21 → ?   (darkGreen)
#00272C → ?   (deepGreen)
#003235 → ?   (midnightGreen)
#034C51 → ?   (nightGreen)
#0b4f45 → ?   (dataGreen25OnDarkGreen)
#2AD19F → ?   (midDataGreen)
#19DFAE → ?   (dataGreen)
#5FF6CC → ?   (dataGreenBright)
#E8FAF5 → ?   (dataGreenLight)
#808A89 → ?   (coolGray — optional)
```

Also derive the new rgba() values for all opacity variants using the new base hexes.

### Step 2 — Update DESIGN_USAGE_GUIDE_V2.md

For each token:
- Replace hex value in the Color Token Reference tables
- Replace all rgba() values in opacity variant tables (recalculate from new base hex)
- Update the `glowBoxStyles` gradient rgba values
- Update the gradient in the body background section
- Update any inline hex values in code examples

### Step 3 — Update token names (optional)

If the new hue is, say, purple — `dataGreen`, `deepGreen`, `midnightGreen` etc. will be misleading names. Decide whether to:
- **Rename** all tokens to match the new hue (e.g., `dataViolet`, `deepPurple`) — cleaner but more churn
- **Keep the names** and note in the doc that they refer to the new hue — simpler swap, less confusion for builders later

This is a judgment call. Renaming is recommended if this system will be used for a long time.

---

## Order of Work

1. **[Tarantoga]** Generate candidate palettes using the tools above
2. **[Review]** Check each candidate against the HSL fingerprint table — surface L steps and accent S/L must match
3. **[Decision]** Pick one palette; write the hex mapping table
4. **[Implementation]** Update DESIGN_USAGE_GUIDE_V2.md using the mapping
5. **[Validation]** Visual check — paste the updated glowBoxStyles and surface colors into a preview to confirm the aesthetic holds
6. **[Proceed]** Begin Phase 1 implementation using the new palette
