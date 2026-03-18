# Schema Planner Design Usage Guide

A **self-contained** reference for building UI that matches the Schema Planner aesthetic. Built on the OneSource design system (originating from `site-next-frontend`, evolved through `OneSource-Randomizer`). Every token value, text style, and pattern is defined inline — you do **not** need access to `theme.ts`, `design-tokens.json`, or any other source file. Copy values directly from this document.

---

## Table of Contents

0. [Chakra UI Primer](#chakra-ui-primer-for-non-chakra-readers)
1. [Core Principle](#core-principle)
2. [Design System Lineage](#design-system-lineage)
3. [Color Token Reference](#color-token-reference)
4. [Backgrounds & Surfaces](#backgrounds--surfaces)
5. [Borders](#borders)
6. [Border Radius](#border-radius)
7. [Text & Color Hierarchy](#text--color-hierarchy)
8. [Typography](#typography)
9. [Font Loading](#font-loading)
10. [Buttons](#buttons)
11. [Inputs & Form Fields](#inputs--form-fields)
12. [Checkbox & Switch](#checkbox--switch)
13. [Toggle Buttons](#toggle-buttons)
14. [Modals & Dialogs](#modals--dialogs)
15. [Drawers](#drawers)
16. [Badges & Indicators](#badges--indicators)
17. [Branch Selector & Dropdowns](#branch-selector--dropdowns)
18. [Tooltips](#tooltips)
19. [App Layout & Grid](#app-layout--grid)
20. [Schema Tree](#schema-tree)
21. [Field Editor Drawer](#field-editor-drawer)
22. [Type Editor Drawer](#type-editor-drawer)
23. [Query Sandbox & CodeMirror](#query-sandbox--codemirror)
24. [Git Operations](#git-operations)
25. [Shadows & Glow](#shadows--glow)
26. [Glass / Backdrop Blur](#glass--backdrop-blur)
27. [Hover & State Patterns](#hover--state-patterns)
28. [Transitions & Animation](#transitions--animation)
29. [Spacing & Layout](#spacing--layout)
30. [Scrollable Regions](#scrollable-regions)
31. [Loading States](#loading-states)
32. [Error States](#error-states)
33. [Icons & SVG](#icons--svg)
34. [Layer Style Presets](#layer-style-presets)
35. [Theme Recipes](#theme-recipes-pre-built-component-styles)
36. [Z-Index Scale](#z-index-scale)
37. [Quick Checklist](#quick-checklist)

---

## Chakra UI Primer (for non-Chakra readers)

This doc uses **Chakra UI v3** JSX syntax throughout. If you're building in a different framework (Tailwind, plain CSS, styled-components, etc.), here's how to translate:

### Component mapping
| Chakra Component | HTML/CSS Equivalent |
|---|---|
| `<Box>` | `<div>` |
| `<Flex>` | `<div style="display: flex">` |
| `<VStack gap={3}>` | `<div style="display: flex; flex-direction: column; gap: 12px">` |
| `<HStack gap={3}>` | `<div style="display: flex; flex-direction: row; gap: 12px">` |
| `<Grid templateColumns="2fr 3fr">` | `<div style="display: grid; grid-template-columns: 2fr 3fr">` |
| `<GridItem colSpan={3}>` | `<div style="grid-column: span 3">` |
| `<Text>` | `<p>` or `<span>` |
| `<Heading size="md">` | `<h2>` (see size mappings below) |
| `<Button>` | `<button>` |
| `<Input>` | `<input>` |
| `<Textarea>` | `<textarea>` |
| `<Badge>` | `<span>` styled as an inline label |
| `<Spinner>` | A CSS loading spinner animation |
| `<IconButton>` | `<button>` containing only an icon |

### Prop mapping
| Chakra Prop | CSS Property |
|---|---|
| `bg="deepGreen"` | `background-color: #281508` (resolve token to hex from color tables) |
| `color="white75"` | `color: rgba(255,255,255,0.75)` |
| `borderColor="dataGreen25"` | `border-color: rgba(204,82,0,0.25)` |
| `borderWidth="1px"` | `border-width: 1px` |
| `borderRadius="md"` | `border-radius: 6px` (see radius table) |
| `px={3}` | `padding-left: 12px; padding-right: 12px` (token 3 = 12px) |
| `py={2}` | `padding-top: 8px; padding-bottom: 8px` (token 2 = 8px) |
| `p={4}` | `padding: 16px` |
| `gap={3}` | `gap: 12px` |
| `w="full"` | `width: 100%` |
| `h="100vh"` | `height: 100vh` |
| `flexShrink={0}` | `flex-shrink: 0` |
| `zIndex={1000}` | `z-index: 1000` |
| `fontFamily="mono"` | `font-family: var(--font-monaspace), monospace` |
| `fontSize="sm"` | `font-size: 14px` |
| `fontWeight="medium"` | `font-weight: 500` |
| `fontWeight="semibold"` | `font-weight: 600` |
| `textTransform="uppercase"` | `text-transform: uppercase` |
| `letterSpacing="wider"` | `letter-spacing: 0.05em` |
| `opacity={0.5}` | `opacity: 0.5` |
| `cursor="pointer"` | `cursor: pointer` |
| `transition="all 0.2s"` | `transition: all 0.2s` |
| `css={object}` | `style={object}` (raw inline CSS — bypasses Chakra token resolution) |

### Pseudo-prop mapping
| Chakra Pseudo | CSS Equivalent |
|---|---|
| `_hover={{ bg: 'dataGreen10' }}` | `:hover { background-color: rgba(204,82,0,0.1) }` |
| `_focus={{ borderColor: 'dataGreen' }}` | `:focus { border-color: #CC5200 }` |
| `_disabled={{ opacity: 0.5 }}` | `:disabled { opacity: 0.5 }` |
| `_placeholder={{ color: 'white50' }}` | `::placeholder { color: rgba(255,255,255,0.5) }` |
| `_groupHover={{ opacity: 1 }}` | `.group:hover & { opacity: 1 }` (parent has `className="group"`) |
| `_checked={{ bg: 'dataGreen' }}` | `:checked { background-color: #CC5200 }` (or `[data-state="checked"]` for custom checkboxes) |

### Responsive syntax
```tsx
// Chakra responsive object:
padding={{ base: 2, md: 16 }}
// Equivalent CSS:
padding: 8px;
@media (min-width: 768px) { padding: 64px; }
```
`base` = no breakpoint (mobile-first default). See the Breakpoints table in the Spacing section for all breakpoint values.

---

## Core Principle

Dark-only, monochrome amber terminal aesthetic. One accent color (`dataGreen` / `#CC5200`) does all the work. Everything else is dark amber surfaces + white text at varying opacities. No light mode. No grays. No neutral palette. This is a **developer tool** — the design is sparse, information-dense, and keyboard-friendly.

---

## Design System Lineage

The Schema Planner inherits its visual language from the OneSource design system:

| Project | Role | Framework |
|---|---|---|
| `site-next-frontend` | **Original blueprint** — canonical token definitions, font stack, layer styles | Chakra UI v2 (`extendTheme`) |
| `OneSource-Randomizer` | **Evolved reference** — manual refinements, richer component patterns | Chakra UI v3 (`createSystem`) |
| `schema-planner` (this project) | **Focused application** — subset of tokens, tool-specific components | Chakra UI v3 (`createSystem`) |

All three projects share the same `generate-design-tokens` pipeline and `design-tokens.json` output. **You do not need access to those other repos** — every token value and pattern needed to build consistent UI is documented in this file. The lineage is noted here for historical context only.

---

## Color Token Reference

### Primary ambers (darkest → brightest)

| Token | Hex | Role |
|---|---|---|
| `nightGreenDark` | `#120904` | Darkest background (body gradient start) |
| `darkGreen` | `#1D1007` | Tertiary surface, body gradient end |
| `deepGreen` | `#281508` | Secondary surface (inputs, drawers, nested panels) |
| `midnightGreen` | `#451D00` | Primary surface (cards, modals, nav) |
| `nightGreen` | `#5D2300` | Mid-tone accent surface (rare) |
| `dataGreen25OnDarkGreen` | `#722800` | Solid equivalent of 25% amber on dark bg (non-transparent) |
| `midDataGreen` | `#A73D00` | Mid amber (between accent and bright) |
| `dataGreen` | `#CC5200` | **The accent** — borders, text, fills, everything interactive |
| `dataGreenBright` | `#E76E00` | Hover/active accent (brighter variant) |
| `dataGreenLight` | `#FFDFC2` | Very light tint (rare, light-context only) |

### dataGreen opacity variants

| Token | Value | Use |
|---|---|---|
| `dataGreen05` | `rgba(204,82,0,0.05)` | Row hover backgrounds (schema tree, field explorer) |
| `dataGreen10` | `rgba(204,82,0,0.1)` | Ghost button hover, active nav backgrounds |
| `dataGreen15` | `rgba(204,82,0,0.15)` | Badge backgrounds, active branch row |
| `dataGreen25` | `rgba(204,82,0,0.25)` | **Standard border color** — the most-used token |
| `dataGreen30` | `rgba(204,82,0,0.3)` | Checkbox borders |

### darkGreen opacity variants

| Token | Value | Use |
|---|---|---|
| `darkGreen25` | `rgba(29,16,7,0.25)` | **Modal/dialog backdrop overlay** (`bg="darkGreen25"` + `backdropFilter`) |
| `darkGreen30` | `rgba(29,16,7,0.3)` | Heavier overlay (rare) |
| `darkGreen50` | `rgba(29,16,7,0.5)` | Semi-opaque dark overlay |
| `darkGreen60` | `rgba(29,16,7,0.6)` | Dark input backgrounds (contact forms) |
| `darkGreen80` | `rgba(29,16,7,0.8)` | Near-opaque dark overlay |
| `darkGreen90` | `rgba(29,16,7,0.9)` | Almost-solid dark overlay |

### midnightGreen opacity variants

| Token | Value | Use |
|---|---|---|
| `midnightGreen50` | `rgba(69,29,0,0.5)` | Placeholder text in email inputs |
| `midnightGreen25` | `rgba(69,29,0,0.25)` | Faint midnightGreen tint |

### White opacity scale

| Token | Value | Use |
|---|---|---|
| `white` | `#FFFFFF` | Primary headings, important labels |
| `white90` | `rgba(255,255,255,0.9)` | Near-primary (rare) |
| `white75` | `rgba(255,255,255,0.75)` | **Default body text**, form labels, ghost button text |
| `white50` | `rgba(255,255,255,0.5)` | Muted — placeholders, timestamps, metadata, secondary text |
| `white25` | `rgba(255,255,255,0.25)` | Very faint — disabled text, separator lines, fine print |

### Utility colors

| Token | Hex | Use |
|---|---|---|
| `coolGray` | `#808A89` | Hover background in `subtleFloatBackground` layer style preset |

### Semantic colors

| Token | Hex | Use |
|---|---|---|
| `persimmon` | `#C63131` | Error text, error borders, destructive buttons, DEL badges |

**Rule:** Never use raw hex in components — always use token names.

---

## Backgrounds & Surfaces

| Context | Value |
|---|---|
| Page body | Set globally: `linear-gradient(150deg, #120904, #1D1007)`, `background-attachment: fixed`, `min-height: 100vh`, `color: white` |
| Primary surface (modals, dialog cards) | `css={glowBoxStyles}` — see below |
| Secondary surface (inputs, drawers, nested panels) | `bg="deepGreen"` (`#281508`) |
| Tertiary / inset areas (preview boxes, diff summaries, code blocks) | `bg="midnightGreen"` (`#451D00`) |

### glowBoxStyles — the signature surface

The most-used surface style for dialog cards. Apply as a raw `css` or `style` object — not via Chakra's `bg=` or `bgGradient=` props, because the transparent-color gradient doesn't work reliably through those. The 135deg angle starts top-left with a faint amber tint and fades to `midnightGreen` (`#451D00`).

```ts
// Copy this object and apply via css={glowBoxStyles} or style={glowBoxStyles}
const glowBoxStyles = {
  background: 'linear-gradient(135deg, rgba(204,82,0, 0.05) 0%, #451D00 100%)',
  boxShadow: 'rgba(204,82,0, 0.1) 0px 0px 60px',
}
```

**Resolved values:** The gradient goes from `rgba(204,82,0,0.05)` (nearly transparent amber) to `#451D00` (midnightGreen solid). The box shadow is a 60px diffused amber glow at 10% opacity.

---

## Borders

### Width
**Default is `1px`**. Use `borderWidth="1px"` or `border="1px solid"`. Exception: checkboxes use `2px solid` for their control border (see Checkbox section).

### Color
| Context | Token |
|---|---|
| Default border | `borderColor="dataGreen25"` — cards, panels, inputs, dividers, drawers |
| Hover/focus border | `borderColor="dataGreen"` — full opacity amber |
| Subtle dividers | `borderColor="white25"` — horizontal rules between sections |
| Error border | `borderColor="persimmon"` |

### Rule of thumb
If it has a visible boundary → `borderWidth="1px" borderColor="dataGreen25"`. On hover/focus → brighten to `dataGreen`.

---

## Border Radius

| Element type | Token | Pixels | Example |
|---|---|---|---|
| Small interactive | `"2"` or `"8px"` | 8px | Type preview box, code blocks, argument rows |
| Row hover states | `"sm"` | ~4px | Schema tree field rows, field explorer rows |
| Medium inputs | `"md"` | ~6px | Branch selector trigger, icon buttons |
| Large containers | `{ base: '4', md: '8' }` | 16→32px | Dialog cards (responsive) |
| Pills (primary CTA) | `"99px"` | pill | Primary action buttons, login button |
| Circles | `"full"` | 50% | Avatars, badge pills |

### Responsive radius on dialog cards
```tsx
borderRadius={{ base: '4', md: '8' }}
// = 16px → 32px as viewport grows
```

### Token-to-pixel mapping

**Numeric tokens** (custom — used by this design system):

`radii.2` = 8px, `radii.4` = 16px, `radii.6` = 24px, `radii.8` = 32px.

**Named tokens** (Chakra v3 defaults — used in code snippets):

| Token | Pixels |
|---|---|
| `sm` | 4px |
| `md` | 6px |
| `lg` | 8px |
| `xl` | 12px |
| `2xl` | 16px |
| `full` | 50% (circle) |

### Rule of thumb
Smaller elements → smaller radius. Inner element radius is always smaller than outer container.

---

## Text & Color Hierarchy

**Default body text** inherits `body1Medium`: Figtree, weight 500, 19px (base) → 20px (md+), line-height 140%, color `white75`.

Headings: `white`. Metadata/secondary: `white50`. Interactive/active: `dataGreen`. Error: `persimmon`. Section headings: `white50` + uppercase.

### Mono labels (section headers in tree)
```tsx
<Heading as="h3" size="xs" color="white50" textTransform="uppercase" letterSpacing="wider" mb={1}>
  Section Title
</Heading>
```

---

## Typography

### Font assignment
| Font | Token | When to use |
|---|---|---|
| Mabry Medium Pro | `fontFamily="heading"` | App title, section headings, dialog titles |
| Figtree | `fontFamily="body"` (default) | Everything else — body text, buttons, labels, form fields |
| Monaspace Neon | `fontFamily="mono"` | Branch names, type names, field names, GraphQL code |

### Size patterns
| Context | Size |
|---|---|
| App title | `size="md"` (Heading) — ~20px |
| Dialog titles | `size="md"` or `size="lg"` (Heading) — 20px / 24px |
| Section headings | `size="xs"` (Heading) — ~14px + `textTransform="uppercase"` |
| Body text | `fontSize="sm"` to `"md"` |
| Button label | `fontSize="sm"` to `"md"` |
| Metadata / captions | `fontSize="xs"` (12px) or `"2xs"` |
| Mono labels (tree) | `fontSize="sm"` with `fontFamily="mono"` |

### Font size scale (token → pixels)

| Token | Pixels |
|---|---|
| `2xs` | 10px |
| `xs` | 12px |
| `sm` | 14px |
| `md` | 16px |
| `lg` | 20px |
| `xl` | 37px |
| `2xl` | 48px |
| `3xl` | 56px |

### Text styles (preferred)

Use `textStyle` when possible — they handle responsive sizing automatically. Here are the full resolved definitions:

#### Body text styles
| Style | Font | Weight | Size (base → md) | Line Height |
|---|---|---|---|---|
| `body1Medium` | Figtree (body) | 500 | 19px → 20px | 140% |
| `body1Semibold` | Figtree (body) | 600 | 19px → 20px | 140% |
| `body2Medium` | Figtree (body) | 500 | 17px | 130% |
| `body2Semibold` | Figtree (body) | 600 | 17px | 130% |
| `body3Medium` | Figtree (body) | 500 | 15px | 120% | + `letterSpacing: 0.15px` |
| `body3Semibold` | Figtree (body) | 600 | 15px | 150% |
| `body3Thin` | Figtree (body) | 300 | 15px → 17px | 150% |
| `bodyXs` | Figtree (body) | 500 | 12px → 14px | 150% → 120% |

#### Heading text styles
| Style | Font | Weight | Size (base → md) | Line Height |
|---|---|---|---|---|
| `headline1` | Mabry Medium Pro (heading) | 500 | 26px → 36px | 100% |
| `headline2` | Mabry Medium Pro (heading) | 500 | 24px → 30px | 110% |
| `headline3` | Mabry Medium Pro (heading) | 500 | 20px → 24px | 110% |
| `headline4` | Mabry Medium Pro (heading) | 500 | 20px | 130% |

#### Monospace text styles
All mono styles use **uppercase** `textTransform` by default.

| Style | Font | Weight | Size | Line Height | Letter Spacing |
|---|---|---|---|---|---|
| `mono1Medium` | Monaspace Neon (mono) | 500 | 12px | 120% | 0.24px → 0.36px |
| `mono1Semibold` | Monaspace Neon (mono) | 600 | 12px | 120% | 0.4px |
| `mono2Medium` | Monaspace Neon (mono) | 500 | 14px | 100% | 0.28px |
| `mono2Semibold` | Monaspace Neon (mono) | 500 (note: despite name, weight is 500 not 600) | 14px | 100% | 0.28px |
| `mono3Medium` | Monaspace Neon (mono) | 500 | 16px | 120% | 0.32px |
| `mono3Semibold` | Monaspace Neon (mono) | 600 | 16px | 120% | 0.32px |

#### Title text styles (large display)
| Style | Font | Size (base → md) | Letter Spacing | Line Height |
|---|---|---|---|---|
| `titleBig` | Mabry (heading) | 60px → 120px | -1.8px → -3.6px | 100% → 95% |
| `title1` | Mabry (heading) | 48px → 76px | -1.44px → -2.28px | 100% |
| `title2` | Mabry (heading) | 42px → 76px | -1.26px → -2.28px | 105% |
| `title3` | Mabry (heading) | 36px → 64px | -1.08px → -1.92px | 100% |
| `title4` | Mabry (heading) | 30px → 48px | -0.9px → -1.44px | 100% |
| `titleLg` | Mabry (heading) | 48px → 96px | -1.44px → -2.28px | 95% |
| `titleXl` | Mabry (heading) | 81px | -3.24px | 95% |

---

## Font Loading

Three custom fonts loaded via `next/font/local` in `layout.tsx`:

| Font | CSS Variable | Weight(s) | Display |
|---|---|---|---|
| Figtree (variable) | `--font-figtree` | 300–600 | swap |
| Monaspace Neon (variable) | `--font-monaspace` | 500–600 | swap |
| Mabry Medium Pro (TTF) | `--font-mabry` | 500 only | swap |

Variables applied to `<html>` via `className`. Use `var(--font-monaspace, monospace)` in raw style objects (e.g., CodeMirror theme).

---

## Buttons

### Primary action (amber fill, pill shape)
Used for: Login, Commit, Create Branch, Save, Validate, View PR, Try Again
```tsx
<Button bg="dataGreen" color="darkGreen" borderRadius="99px"
  _hover={{ bg: 'dataGreenBright' }}
  _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}>
  Do the thing
</Button>
```

### Outline / header action
Used for: New Branch, Open PR
```tsx
<Button size="sm" variant="outline" borderColor="dataGreen25" color="dataGreen"
  _hover={{ borderColor: 'dataGreen' }}>
```

### Ghost / cancel
Used for: Cancel buttons, Sign Out, drawer close
```tsx
<Button variant="ghost" color="white75"
  _hover={{ bg: 'dataGreen10', color: 'dataGreen' }}>
  Cancel
</Button>
```

### Ghost / add action (subtle CTA)
Used for: Add Type, Add Field, Add Argument
```tsx
<Button size="xs" variant="ghost" color="dataGreen"
  _hover={{ bg: 'dataGreen05' }}>
  + Add field
</Button>
```

### Icon button
Used for: Branch selector, field actions
```tsx
<IconButton variant="ghost" color="dataGreen" borderRadius="md"
  border="1px solid" borderColor="dataGreen25"
  _hover={{ borderColor: 'dataGreen', bg: 'dataGreen10' }}>
  <FiChevronDown />
</IconButton>
```

### Destructive (red fill, pill shape)
Used for: Discard Changes, destructive confirmations
```tsx
<Button bg="persimmon" color="white" borderRadius="99px"
  _hover={{ bg: '#a02828' }}>
  Discard Changes
</Button>
```
Hover color `#a02828` is a darkened persimmon — not a named token, just a one-off darker red.

All buttons: `transition="all 0.2s ease-in-out"`.

---

## Inputs & Form Fields

### Standard input
```tsx
<Input
  bg="deepGreen"
  borderColor="dataGreen25"
  color="white"
  _placeholder={{ color: 'white50' }}
  _hover={{ borderColor: 'dataGreen' }}
  _focus={{ borderColor: 'dataGreen', boxShadow: 'none' }}
/>
```

Same pattern for `<Textarea>` and `<Select>`. Always suppress the default focus ring with `boxShadow: 'none'`.

### Form field label convention
```tsx
<VStack gap={2} align="stretch">
  <Text fontSize="sm" fontWeight="medium" color="white75">Field label</Text>
  <Input ... />
  {error && <Text fontSize="xs" color="persimmon" mt={1}>{error}</Text>}
</VStack>
```

Labels: `color="white75"`, `fontSize="sm"`, `fontWeight="medium"`. Error text below field: `color="persimmon"`, `fontSize="xs"`.

---

## Checkbox & Switch

### Checkbox (inline override pattern — used in FieldExplorer)
```tsx
// Control (unchecked): borderColor="dataGreen25"
// Control (checked): bg="dataGreen", borderColor="dataGreen"
// Disabled/circular: borderColor="white25", opacity=0.5, cursor="not-allowed"
```

### Switch (theme recipe)
```tsx
// Control: bg="dataGreen25" (off) → bg="dataGreen" (on)
// Thumb: bg="dataGreen"
// Label: color="white"
```

---

## Toggle Buttons

Active/inactive toggle groups used for NullabilityToggle, ListModifier, and TypeKindSelector:

```tsx
{/* Active */}
<Button bg="dataGreen" color="darkGreen" variant="solid">
  Required
</Button>

{/* Inactive */}
<Button color="white75" variant="outline" borderColor="dataGreen25">
  Nullable
</Button>
```

Helper text below toggle: `fontSize="xs" color="white50" mt={1}`.

---

## Modals & Dialogs

### Full modal pattern (used by all dialogs)
```tsx
{/* Backdrop */}
<Box
  position="fixed" top={0} left={0} right={0} bottom={0}
  bg="darkGreen25"
  backdropFilter="blur(8px)"
  display="flex" alignItems="center" justifyContent="center"
  zIndex={1000}
>
  {/* Dialog card — glowBoxStyles overrides background, so bg prop is a fallback only */}
  <Box
    bg="midnightGreen"
    borderWidth="1px"
    borderColor="dataGreen25"
    borderRadius={{ base: '4', md: '8' }}
    css={glowBoxStyles}
    p={6}
    w="full"
    maxW="md"  {/* sm for confirms, md for forms, lg for commit/PR */}
  >
    <VStack gap={4} align="stretch">
      <Heading size="md">Dialog Title</Heading>
      {/* content */}
      <HStack justify="flex-end" gap={3}>
        <Button variant="ghost" color="white75" ...>Cancel</Button>
        <Button bg="dataGreen" color="darkGreen" borderRadius="99px" ...>Confirm</Button>
      </HStack>
    </VStack>
  </Box>
</Box>
```

### Dialog size guide

Size intent for dialogs (use your framework's equivalent sizing):

| Dialog | Size class | Target width |
|---|---|---|
| ConfirmDialog, BranchSwitchWarning, DiscardChanges | Small | ~384px (`maxW="sm"`) |
| CreateBranchDialog, StaleWarning | Medium | ~448px (`maxW="md"`) |
| CommitDialog, PRDialog | Large | ~512px (`maxW="lg"`) |

In Chakra v3, `maxW="sm"` / `"md"` / `"lg"` resolve to the framework's default sizes scale. If building outside Chakra, use the target widths above. The principle: simple confirmations are narrow, form inputs are medium, dialogs with previews/summaries are wider.

---

## Drawers

### Right-side drawer (FieldEditorDrawer, TypeEditorDrawer)
```tsx
<Box
  position="fixed"
  top={0} right={0} bottom={0}
  width="400px"
  bg="deepGreen"
  borderLeftWidth="1px"
  borderColor="dataGreen25"
  boxShadow="lg"
  zIndex={1000}
  display="flex"
  flexDirection="column"
>
  {/* Header */}
  <Box p={4} borderBottomWidth="1px" borderColor="dataGreen25">
    <Heading size="md">{title}</Heading>
  </Box>

  {/* Scrollable body */}
  <Box flex={1} overflowY="auto" p={4}>
    {children}
  </Box>

  {/* Footer */}
  <Box p={4} borderTopWidth="1px" borderColor="dataGreen25">
    <HStack justify="flex-end" gap={3}>
      <Button variant="ghost" ...>Cancel</Button>
      <Button bg="dataGreen" ...>Save</Button>
    </HStack>
  </Box>
</Box>
```

Key: `bg="deepGreen"` (not `midnightGreen`), separated header/body/footer with `1px dataGreen25` borders.

---

## Badges & Indicators

### Kind badge (type labels in schema tree)
```tsx
<Badge size="sm" bg="dataGreen15" color="dataGreen" variant="subtle"
  fontSize="2xs" fontWeight="medium">
  OBJECT
</Badge>
```

### Editable/read-only status badge (header)
```tsx
{/* Editable */}
<Badge bg="dataGreen15" color="dataGreen" borderRadius="full" fontSize="2xs" px={2} py={0.5}>
  Editable
</Badge>

{/* Read-only */}
<Badge bg="white25" color="white50" borderRadius="full" fontSize="2xs" px={2} py={0.5}>
  Read Only
</Badge>
```

### Diff indicator
| Kind | bg | color | Label |
|---|---|---|---|
| `added` | `dataGreen15` | `dataGreen` | NEW |
| `removed` | `rgba(198,49,49,0.15)` | `persimmon` | DEL |
| `modified` | `rgba(255,255,255,0.1)` | `white75` | MOD |

All: `size="sm" variant="subtle" fontSize="2xs" lineHeight="1"`.

### Count badge (field selector panel)
```tsx
<Badge bg="dataGreen10" color="dataGreen" fontSize="2xs" borderRadius="full" px={2}>
  {count}
</Badge>
```

---

## Branch Selector & Dropdowns

### Trigger button
```tsx
<Button size="sm" bg="deepGreen" color="white" borderColor="dataGreen25"
  borderWidth="1px" borderRadius="md" fontFamily="mono" fontSize="sm" px={3}
  _hover={{ bg: 'midnightGreen' }}>
  proposal/my-branch <FiChevronDown />
</Button>
```

### Dropdown panel
```tsx
<Box
  position="absolute" top="100%" left={0} mt={1}
  minW="280px" maxH="400px" overflowY="auto"
  bg="nightGreenDark"
  borderWidth="1px" borderColor="dataGreen25"
  borderRadius="md"
  boxShadow="lg"
  zIndex={100}
  py={1}
>
  {/* Section header */}
  <Text fontSize="xs" color="white50" textTransform="uppercase"
    fontWeight="medium" letterSpacing="wide" px={3} py={1}>
    Proposals
  </Text>

  {/* Branch row */}
  <Box px={3} py={1.5} fontSize="sm" fontFamily="mono"
    color={isActive ? 'dataGreen' : 'white'}
    bg={isActive ? 'dataGreen10' : 'transparent'}
    _hover={{ bg: 'dataGreen15', color: 'dataGreen' }}
    cursor="pointer">
    branch-name
  </Box>
</Box>
```

---

## Tooltips

```tsx
// Theme recipe (applied automatically):
bg="darkGreen" color="dataGreen" borderColor="dataGreen25"
borderRadius="8px" fontSize="sm" fontWeight="medium"
px="10px" py="4px"
```

Arrow background: `#1D1007` (darkGreen).

---

## App Layout & Grid

### 3-panel layout (`AppLayout.tsx`)
```tsx
<Grid
  templateColumns={`${leftWidth}px 6px 1fr`}
  templateRows="auto 1fr"  {/* or "auto 1fr auto" when bottom bar visible */}
  height="100vh"
  overflow="hidden"
>
  {/* Header — spans all columns */}
  <GridItem colSpan={3} borderBottomWidth="1px" borderColor="dataGreen25" />

  {/* Left panel — schema tree */}
  <GridItem overflowY="auto" />

  {/* Resize divider — 6px column */}
  <GridItem cursor="col-resize">
    <Box width="2px" height="100%"
      bg={isDragging ? 'dataGreen' : 'transparent'}
      _hover={{ bg: 'dataGreen25' }}
      transition="background 0.15s" />
  </GridItem>

  {/* Center panel — editor/sandbox */}
  <GridItem overflow="auto" />

  {/* Bottom bar (conditional) — spans all columns */}
  <GridItem colSpan={3} borderTopWidth="1px" borderColor="dataGreen25" />
</Grid>
```

### Header bar
```tsx
<Flex align="center" justify="space-between" px={4} height="56px" flexShrink={0}
  borderBottomWidth="1px" borderColor="dataGreen25">
  {/* Left: app title + branch selector */}
  {/* Right: status badge + action buttons + user menu */}
</Flex>
```

---

## Schema Tree

### Type node
```tsx
{/* Kind badge + type name */}
<HStack>
  <Badge size="sm" bg="dataGreen15" color="dataGreen" variant="subtle" fontSize="2xs">
    OBJECT
  </Badge>
  <Text fontSize="sm" fontWeight="semibold" fontFamily="mono"
    color={isNavigable ? 'dataGreen' : 'white'}
    cursor={isNavigable ? 'pointer' : 'default'}
    _hover={isNavigable ? { textDecoration: 'underline' } : {}}>
    TypeName
  </Text>
</HStack>
```

### Field node
```tsx
<HStack className="group" gap={2} py={0.5} px={2}
  opacity={isSoftDeleted ? 0.5 : 1}
  _hover={{ bg: 'dataGreen05' }}
  borderRadius="sm">
  {/* Field name — monospace */}
  <Text fontSize="sm" fontFamily="mono"
    textDecoration={isSoftDeleted ? 'line-through' : 'none'}>
    fieldName
  </Text>
  {/* Colon separator */}
  <Text fontSize="xs" color="white50">:</Text>
  {/* Type — amber if navigable */}
  <Text fontSize="xs" fontFamily="mono"
    color={isNavigable ? 'dataGreen' : 'white50'}
    cursor={isNavigable ? 'pointer' : 'default'}
    _hover={isNavigable ? { textDecoration: 'underline' } : {}}>
    String!
  </Text>
  {/* Hover-revealed action buttons */}
  <IconButton size="2xs" variant="ghost" color="dataGreen"
    opacity={0} _groupHover={{ opacity: 1 }}
    _hover={{ bg: 'dataGreen10' }}>
    <FiArrowDown />
  </IconButton>
</HStack>
```

**Notable pattern:** `className="group"` + `_groupHover` reveals action buttons only on row hover.

### Breadcrumbs
```tsx
<HStack gap={1} fontSize="sm" flexWrap="wrap" mb={2}>
  <Text color={isAtRoot ? 'white' : 'dataGreen'} fontWeight={isAtRoot ? 'bold' : 'normal'}
    cursor={isAtRoot ? 'default' : 'pointer'}
    _hover={!isAtRoot ? { textDecoration: 'underline' } : {}}>
    Schema
  </Text>
  <Text color="white50">/</Text>
  <Text color="white" fontWeight="bold">CurrentType</Text>
</HStack>
```

### Enum values
```tsx
<Text fontSize="sm" fontFamily="mono" color="white50" py={0.5} px={2}>
  ENUM_VALUE
</Text>
```

---

## Field Editor Drawer

Follows the [Drawers](#drawers) shell pattern. Contains these inner components:

### FieldNameInput / TypeSelector
Standard [form field](#inputs--form-fields) pattern with validation error text.

### NullabilityToggle / ListModifier
[Toggle button](#toggle-buttons) pattern — two buttons side-by-side.

### DescriptionInput
```tsx
<Textarea bg="deepGreen" borderColor="dataGreen25" rows={2}
  _hover={{ borderColor: 'dataGreen' }}
  _focus={{ borderColor: 'dataGreen', boxShadow: 'none' }} />
```

### ArgumentsEditor
Existing arguments displayed in rows:
```tsx
<HStack gap={2} p={2} bg="midnightGreen" borderRadius="sm">
  <Text fontSize="xs" fontFamily="mono">{argName}</Text>
  <Text fontSize="xs" fontFamily="mono" color="dataGreen">{argType}</Text>
  <Text fontSize="xs" color="white50">{defaultValue}</Text>
  <Button size="xs" variant="ghost" color="persimmon">Remove</Button>
</HStack>
```

New argument form wrapped in:
```tsx
<VStack p={2} borderWidth="1px" borderColor="dataGreen25" borderRadius="sm">
  {/* inputs */}
</VStack>
```

### OpenSearchSuggestions
```tsx
{/* Suggestion row */}
<HStack p={1} borderRadius="sm" _hover={{ bg: 'dataGreen05' }} cursor="pointer">
  <Badge size="sm" bg="dataGreen15" color="dataGreen" variant="subtle">{type}</Badge>
  <Text fontSize="sm" fontFamily="mono">{fieldName}</Text>
  <Button size="xs" variant="ghost" color="dataGreen">+ Add</Button>
</HStack>

{/* Unavailable notice */}
<Box p={2} borderWidth="1px" borderColor="dataGreen25" borderRadius="md" bg="dataGreen05">
  <Text fontSize="sm" color="white50">Suggestions unavailable</Text>
</Box>
```

---

## Type Editor Drawer

Same drawer shell as Field Editor. Contains:

### TypeKindSelector
[Toggle button](#toggle-buttons) pattern with options for `type`, `input`, `enum`, `interface`, `union`.

### EnumValuesEditor
Existing values:
```tsx
<Box px={2} py={1} bg="midnightGreen" borderRadius="sm">
  <Text fontSize="sm" fontFamily="mono">{enumValue}</Text>
</Box>
```

---

## Query Sandbox & CodeMirror

### Two-panel layout
```tsx
<Grid templateColumns="2fr 3fr" gap={3} h="100%">
  {/* Left: field selector */}
  <GridItem borderWidth="1px" borderColor="dataGreen25" borderRadius="md"
    bg="deepGreen" overflow="hidden" />
  {/* Right: editor + validation */}
  <GridItem as={VStack} gap={4} align="stretch" />
</Grid>
```

### CodeMirror theme (raw CSS — not Chakra tokens)

Applied via CodeMirror's `EditorView.theme()` API. Each key is a CSS selector, each value is a style object:

```javascript
// EditorView.theme({ ... })
{
  '&': {
    border: '1px solid rgba(204,82,0,0.25)',    // dataGreen25
    borderRadius: '6px',
    backgroundColor: '#281508',                    // deepGreen
  },
  '&.cm-focused': {
    outline: '2px solid #CC5200',                  // dataGreen
  },
  '.cm-content': {
    fontFamily: 'var(--font-monaspace, monospace)',
    color: '#ffffff',
    caretColor: '#CC5200',                         // dataGreen
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(204,82,0,0.15)',      // dataGreen15
  },
  '.cm-gutters': {
    backgroundColor: '#001F23',                    // custom dark (close to nightGreenDark #120904)
    color: 'rgba(255,255,255,0.25)',               // white25
    borderRight: '1px solid rgba(204,82,0,0.25)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(204,82,0,0.05)',      // dataGreen05
  },
}
```

### Field selector panel header
```tsx
<HStack px={3} py={2} borderBottom="1px solid" borderColor="dataGreen15">
  <Text fontSize="xs" color="white50" textTransform="uppercase" fontWeight="medium">
    {operationType}
  </Text>
  <Text fontSize="sm" color="dataGreen" fontFamily="mono" fontWeight="medium">
    {operationName}
  </Text>
  <Badge bg="dataGreen10" color="dataGreen" fontSize="2xs" borderRadius="full" px={2}>
    {selectedCount}
  </Badge>
</HStack>
```

### Field explorer tree (checkbox-based)
```tsx
<HStack py={1} px={2} gap={2} cursor="pointer" borderRadius="sm"
  _hover={{ bg: 'dataGreen05' }}
  pl={depth * 4}>
  {/* Expand arrow */}
  <Box color="white50" w="16px">{arrowIcon}</Box>
  {/* Checkbox for selectable scalars */}
  <Checkbox borderColor="dataGreen25" _checked={{ bg: 'dataGreen', borderColor: 'dataGreen' }} />
  {/* Field name */}
  <Text fontFamily="mono" fontSize="sm"
    color={isSelected ? 'dataGreen' : 'white'}
    fontWeight={isSelected ? 'medium' : 'normal'}>
    {fieldName}
  </Text>
  {/* Type */}
  <Text fontSize="xs" color="white25" fontFamily="mono">{typeName}</Text>
</HStack>

{/* Nested children — indented with left border */}
<Box ml={4} pl={2} borderLeft="1px solid" borderColor="dataGreen15">
  {children}
</Box>
```

### Validation results
```tsx
{/* Not validated */}
<Box p={3} borderRadius="md">
  <Text fontSize="sm" color="white50">Run validation to check your query</Text>
</Box>

{/* Valid */}
<Box p={3} borderRadius="md" bg="dataGreen05">
  <Text fontSize="sm" color="dataGreen">Query is valid</Text>
</Box>

{/* Invalid */}
<Box p={3} borderRadius="md" bg="rgba(198,49,49,0.1)">
  <Text fontSize="sm" color="persimmon" fontFamily="mono">{errorMessage}</Text>
</Box>
```

---

## Git Operations

### ChangeSummaryBar (fixed bottom bar)
```tsx
<Box position="fixed" bottom={0} left={0} right={0}
  bg="deepGreen" borderTopWidth="1px" borderColor="dataGreen25"
  px={4} py={2} zIndex={100}>
  <HStack justify="space-between">
    <Text fontSize="sm" color="white50">{summaryText}</Text>
    <HStack gap={3}>
      <Button variant="ghost" color="white75" ...>Discard</Button>
      <Button bg="dataGreen" color="darkGreen" borderRadius="99px" ...>Commit Changes</Button>
    </HStack>
  </HStack>
</Box>
```

### CommitDialog
Uses [modal shell](#modals--dialogs) with `maxW="lg"`. Changes summary:
```tsx
<Box p={3} bg="midnightGreen" borderRadius="2">
  <Text fontSize="xs" fontFamily="mono">{changeSummary}</Text>
</Box>
```

### PRDialog
Same modal shell. Success state shows amber confirmation:
```tsx
<Text fontSize="sm" color="dataGreen">Pull request created successfully</Text>
<Button bg="dataGreen" color="darkGreen" borderRadius="99px" ...>View PR</Button>
```

---

## Shadows & Glow

### Shadow scale (token → CSS)

| Token | Value |
|---|---|
| `sm` | `0 1px 2px 0 rgb(0 0 0 / 0.05)` |
| `base` | `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` |
| `md` | `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)` |
| `lg` | `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)` |
| `xl` | `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)` |
| `2xl` | `0 25px 50px -12px rgb(0 0 0 / 0.25)` |

### Where shadows are used

| Context | Shadow |
|---|---|
| Dialog cards | `glowBoxStyles`: `rgba(204,82,0,0.1) 0px 0px 60px` |
| Drawers | `lg`: `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)` |
| Branch selector dropdown | `lg` (same as above) |
| Fixed bottom bar | none (uses border only) |

**Rule:** black rgba for structural depth, `dataGreen` rgba for interactive glow. Never use neutral grays.

---

## Glass / Backdrop Blur

Only on elements that float over page content:

| Element | Style |
|---|---|
| Modal backdrop | `bg="darkGreen25"` + `backdropFilter="blur(8px)"` |

Never use backdrop blur on inline cards or sections — only fixed/absolute overlays.

---

## Hover & State Patterns

### Hover — background tint (ghost buttons, nav items)
```tsx
_hover={{ bg: 'dataGreen10', color: 'dataGreen' }}
```

### Hover — row highlight (schema tree, field explorer)
```tsx
_hover={{ bg: 'dataGreen05' }}
```

### Hover — border brighten (inputs, cards, branch selector)
```tsx
_hover={{ borderColor: 'dataGreen' }}
```

### Focus (inputs)
```tsx
_focus={{ borderColor: 'dataGreen', boxShadow: 'none' }}
```

### Disabled
```tsx
_disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
```

### Selected / Active (branch, nav, field)
```tsx
bg={isActive ? 'dataGreen10' : 'transparent'}
color={isActive ? 'dataGreen' : 'white75'}
fontWeight={isActive ? 600 : 400}
```

### Color inversion on amber backgrounds
When an element sits on a `dataGreen` background (active toggle, filled badge), invert token usage:
- Text: `darkGreen` instead of `white`
- Accents: `darkGreen25` instead of `dataGreen25`

### Group hover reveal (field action buttons)
```tsx
<HStack className="group" ...>
  {/* Always visible content */}
  <IconButton opacity={0} _groupHover={{ opacity: 1 }} ... />
</HStack>
```

---

## Transitions & Animation

### Transition speeds

| Speed | Use |
|---|---|
| `0.15s` | Micro — resize divider bg, toggle switch |
| `0.2s ease-in-out` | **Standard** — buttons, border color, text color, all interactive |

Default: `transition="all 0.2s"` on any interactive element.

### Global form element transition
Set in `theme.ts` globalCss:
```css
input, textarea, select {
  transition: border-color 0.2s ease-in-out, box-shadow 0.2s ease-in-out;
}
```

The design system is deliberately **transition-first** — no keyframe animations are used. Everything uses CSS `transition`.

---

## Spacing & Layout

### Space scale (token → pixels)

| Token | Pixels | | Token | Pixels |
|---|---|---|---|---|
| `0` | 0px | | `8` | 32px |
| `0.5` | 0.5px | | `10` | 40px |
| `1` | 4px | | `12` | 48px |
| `2` | 8px | | `13` | 56px |
| `3` | 12px | | `16` | 64px |
| `4` | 16px | | `20` | 80px |
| `5` | 20px | | `24` | 96px |
| `6` | 24px | | `28` | 120px |

This design system uses **numeric spacing tokens** (e.g., `p={4}` = 16px, `gap={3}` = 12px). All spacing values in this doc use this numeric scale. When translating to plain CSS, just look up the token number in the table above.

### Breakpoints

Responsive values like `{{ base: 2, md: 16 }}` use these breakpoints:

| Token | Width |
|---|---|
| `xs` | 25em (400px) |
| `sm` | 30em (480px) |
| `sm2` | 40em (640px) |
| `md` | 48em (768px) |
| `lg` | 62em (992px) |
| `xl` | 80em (1280px) |
| `2xl` | 96em (1536px) |

`base` = no breakpoint (mobile-first default). Most responsive values in this system only use `base` and `md`.

### Global body padding
```tsx
padding={{ base: 2, md: 16 }}  // 8px → 64px
```

### Section gaps
| Context | Gap |
|---|---|
| Between major sections | `gap={4}` (16px) |
| Within a section | `gap={3}` (12px) |
| Button groups | `gap={3}` (12px) |
| Tight pairs | `gap={2}` (8px) |
| Tiny elements (badges) | `gap={1}` (4px) |

### Header height
Fixed at `56px` (`height="56px" flexShrink={0}`).

### Drawer width
Fixed at `400px`.

### Panel divider
Fixed at `6px` wide column.

---

## Scrollable Regions

- Always use `overflowY="auto"` (never `"scroll"`)
- No custom scrollbar styling — browser-native
- Common max heights: `400px` (branch selector), `90vh` (modal content)
- The left panel and center panel in `AppLayout` use `overflowY="auto"` for independent scrolling

```tsx
<Box maxH="400px" overflowY="auto">
  {content}
</Box>
```

---

## Loading States

- `<Spinner color="dataGreen" />` — no skeleton loaders
- Full-page: wrap in flex center container with `minH="100vh"`
- Loading message: `<Text fontSize="sm" color="white50">{message}</Text>`

```tsx
<VStack justify="center" align="center" minH="200px">
  <Spinner size="xl" color="dataGreen" />
  <Text fontSize="sm" color="white50">Loading schema...</Text>
</VStack>
```

---

## Error States

### Inline error text (form validation)
```tsx
<Text fontSize="xs" color="persimmon" mt={1}>{error}</Text>
```

### Error boundary
```tsx
<VStack p={8} gap={3}>
  <Heading size="md" color="persimmon">Something went wrong</Heading>
  <Text fontSize="sm" color="white50">{errorMessage}</Text>
  <Button bg="dataGreen" color="darkGreen" borderRadius="99px"
    _hover={{ bg: 'dataGreenBright' }}>
    Try Again
  </Button>
</VStack>
```

### Error on login page
```tsx
<Text color="persimmon" fontSize="sm">{error}</Text>
```

---

## Icons & SVG

### Icon library
Use `react-icons/fi` (Feather) as the primary icon set. Fallback to `react-icons/lu` (Lucide) for icons Feather doesn't have. Size icons with the `size` prop (pixels). Color with `color="dataGreen"` or `color="white75"`.

### Icons in use
| Icon | Source | Context |
|---|---|---|
| `FaGithub` | `react-icons/fa` | Login button |
| `FiChevronDown/Up` | `react-icons/fi` | Branch selector, expand/collapse |
| `FiArrowDown` | `react-icons/fi` | Insert field button |
| `FiX` | `react-icons/fi` | Close/remove buttons |
| `LuRepeat` | `react-icons/lu` | Circular reference indicator |

### Custom inline SVG
When no library icon fits, match Feather style:
```tsx
<svg width="18" height="18" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" strokeWidth="2"
  strokeLinecap="round" strokeLinejoin="round">
  <path d="..." />
</svg>
```

Always: `fill="none"`, `stroke="currentColor"`, `strokeWidth="2"`, `strokeLinecap="round"`, `strokeLinejoin="round"`.

---

## Layer Style Presets

Use via `layerStyle="..."` in Chakra, or apply the equivalent CSS properties directly. Full resolved values below.

### Border-only presets
| Preset | Border | Radius |
|---|---|---|
| `mutedLgRadBorder` | 1px `dataGreen25` | 6 (24px) |
| `mutedXlRadBorder` | 1px `dataGreen25` | 8 (32px) |
| `brightXlRadBorder` | 1px full `dataGreen` | 8 (32px) |

### Fill presets
| Preset | Background | Border |
|---|---|---|
| `brightMdRadNoBorder` / `brightLgRadNoBorder` | solid `dataGreen` | none |
| `mutedXlRadNoBorder` | `midnightGreen` | none |
| `mutedFillLgRadBorder` / `mutedFillXlRadBorder` | `midnightGreen` | 1px `dataGreen25` |

### Circle presets
| Preset | Background | Border |
|---|---|---|
| `mutedCircleBorder` | `midnightGreen` | muted border, 100% radius |
| `mutedCircleBorderNoBg` | transparent | muted border, 100% radius |

### Hover animation presets
| Preset | Effect |
|---|---|
| `subtleFloat` | `translateY(-2px) scale(1.005)` on hover + `boxShadow: 0 4px 10px rgba(49,29,25,0.03)` elevation. Transition: `transform 0.3s ease, box-shadow 0.3s ease` |
| `subtleFloatBackground` | Same transform + `backgroundColor: coolGray` (`#808A89`) on hover. Transition adds `background-color 0.3s ease` |

---

## Theme Recipes (Pre-built Component Styles)

If you are building within a Chakra v3 project that has this theme installed, these variants are available automatically. If not, use the values below to replicate them.

### Button variants (via `variant="..."`)

| Variant | Properties |
|---|---|
| `primary` | `bg: dataGreen`, `color: darkGreen`, `borderRadius: 99px`, `px: 18px`, `py: 13px`, hover: `bg: dataGreenBright` |
| `primarySq` | Same as `primary` but `borderRadius: 6px` |
| `formSubmit` | `bg: dataGreen`, `color: darkGreen`, `borderRadius: 10.67px`, fixed `32px × 32px`, hover: `bg: dataGreenBright` |
| `icon` | `bg: transparent`, `border: 1px solid dataGreen25`, `color: dataGreen`, `borderRadius: md`, hover/focus: `borderColor: dataGreen` |
| `secondarySq` | `bg: white`, `color: darkGreen`, `borderRadius: 6px`, hover: `bg: dataGreenLight` |

All buttons inherit: `textStyle: body2Medium` (Figtree 17px/500), `transition: background-color 0.2s ease-in-out`.

### Heading recipe
All `<Heading>` components: `fontFamily: heading` (Mabry Medium Pro), `color: white`.

### Code recipe
All `<Code>` / `<code>` styled elements: `fontFamily: mono`, `borderRadius: 8px`, `bg: deepGreen` (`#281508`), `color: dataGreen` (`#CC5200`), `border: 1px solid dataGreen25`.

### Link variants (via `variant="..."`)

| Variant | Properties |
|---|---|
| `button` | `border: 1px solid dataGreen25`, `borderRadius: 40px`, `color: dataGreen`, hover: `borderColor: dataGreen` |
| `buttonDark` | `border: 1px solid dataGreen25`, `borderRadius: 40px`, `color: dataGreen`, hover: `borderColor: dataGreenBright`, `color: dataGreenBright` |
| `buttonPrimary` | `bg: dataGreen`, `color: darkGreen`, `borderRadius: 40px`, hover: `bg: dataGreenBright` |
| `buttonOutline` | `border: 1px solid dataGreen25`, `color: dataGreen`, hover: `borderColor: nightGreen`, `color: nightGreen` |
| `unstyled` | Inherits parent color/style, no hover underline |

### Checkbox recipe (base styles)
- **Control (unchecked):** `borderRadius: 4px`, `border: 2px solid white25`, `bg: transparent`
- **Control (checked):** `bg: dataGreen`, `borderColor: dataGreen`, check mark `color: nightGreen`
- **Control (disabled):** `bg: gray.100` (`#f2f2f2`), `borderColor: gray.200` (`#e5e5e5`)
- **Label:** `color: white75`, `fontSize: 12px`, `lineHeight: 120%`, `fontWeight: 300`
- **Variant `contactDark`:** unchecked `borderColor: dataGreen30`, checked same as base, label `color: dataGreenLight`

### Switch recipe (base styles)
- **Control (off):** `bg: dataGreen25` (`rgba(204,82,0,0.25)`)
- **Control (on):** `bg: dataGreen` (`#CC5200`)
- **Thumb:** `bg: dataGreen`
- **Label:** `color: white` (`#FFFFFF`)

### Tooltip recipe (base styles)
- **Content:** `bg: darkGreen` (`#1D1007`), `color: dataGreen`, `border: 1px solid dataGreen25`, `borderRadius: 8px`, `fontSize: sm` (14px), `fontWeight: medium`, `px: 10px`, `py: 4px`
- **Arrow background:** `#1D1007` (darkGreen)

---

## Z-Index Scale

| Layer | z-index | Elements |
|---|---|---|
| Base content | `auto` (0) | Schema tree, editor panels, inline content |
| Floating menus | `100` | Branch selector dropdown, fixed bottom bar |
| Overlays | `1000` | Modals, drawers, dialog backdrops |

Rule: modals/drawers always render above dropdowns/bars. No intermediate values are used. If you need a tooltip over a modal, use `1100`.

---

## Quick Checklist

Before shipping any component, verify:

- [ ] Borders are `1px` + `dataGreen25` (not gray, not 2px)
- [ ] Border radius follows size hierarchy (sm/md for small → `{ base: '4', md: '8' }` for dialogs)
- [ ] Inner elements have smaller radius than outer container
- [ ] Text uses opacity tokens (`white75`, `white50`) not raw rgba
- [ ] No focus ring — use `boxShadow: 'none'` on `_focus`
- [ ] Hover states use `dataGreen05` (rows) or `dataGreen10` (buttons) bg tint
- [ ] Background is a token (`deepGreen`, `midnightGreen`) not a hex string
- [ ] `transition="all 0.2s"` on interactive elements
- [ ] Headings use `fontFamily="heading"`, code/schema uses `fontFamily="mono"`
- [ ] No light mode references, no `_dark` / `_light` conditionals
- [ ] Colors invert on green backgrounds (use `darkGreen` instead of `white`)
- [ ] Buttons have `_disabled={{ opacity: 0.5, cursor: 'not-allowed' }}`
- [ ] Modals use `glowBoxStyles` + responsive radius + backdrop blur
- [ ] Drawers use `bg="deepGreen"` (not `midnightGreen`) + `borderLeftWidth="1px"`
- [ ] Form inputs follow the standard pattern (deepGreen bg, dataGreen25 border, dataGreen focus)
- [ ] Ghost action buttons use `_groupHover` reveal pattern where appropriate
- [ ] Branch names and type names use `fontFamily="mono"`
