/**
 * Atelier Design System, THE single source of truth for visual tokens.
 * ---------------------------------------------------------------------------
 * Every page should read its pills, panels, cards, headings, colors, and the
 * chart palette from THIS file (or the primitives in this folder / the shared
 * ui/Select.tsx dropdown). Do not hand-roll new hex values, shadows, radii, or
 * pill/panel class strings, if something's missing here, add it here first.
 *
 * The standard is anchored on the Creative Analysis page (AdAnalysisView.tsx)
 * and ui/Select.tsx, the app's reference surfaces. See dashboard/DESIGN_SYSTEM.md
 * for the full catalog, the deviation table, and the rollout checklist.
 *
 * House rules baked in here (dashboard/DESIGN_BRIEF.md has the full spec):
 *   • Two modes, flat white and flat dark, from ONE set of semantic tokens
 *     (index.css @theme, light-dark()). Class strings below use the semantic
 *     utilities (bg-surface-raised, border-line, text-text-muted, ...) so they
 *     follow the mode; never hard-code bg-white, black alphas or hex for a
 *     surface, line or ink.
 *   • Containers: raised surface, thin grey line, light shadow. Controls
 *     (pills, dropdown triggers) get their own surface, a stronger line and a
 *     tiny shadow, so they never disappear on white. Menus and modals float.
 *   • Rust is the one accent, in ten steps (RUST): 600 for the primary
 *     action, tints for hover / selection / chips, 700+ for text on tints.
 *     Selection is ink on a rust tint; focus is a rust ring.
 *   • ONE chart palette (CHART_PALETTE) for generic multi-series charts.
 *   • Headings use the serif display font (font-display).
 */

/* ── Color tokens ─────────────────────────────────────────────────────── */

export const ACCENT = {
  /** Light brand orange, logos, accents, sankey stage 0. */
  light: '#E87A2D',
  /** Deep brand orange, THE primary accent (lines, active rings, bars). */
  deep: '#B7410E',
  /** Active-state text on an orange-tint pill/option. */
  text: '#b55719',
} as const

export const TEAL = {
  light: '#2D8A8A',
  deep: '#216868',
} as const

/**
 * Rust, the one accent, in ten steps around the brand #B7410E (600). Mirrors
 * --color-rust-* in index.css (Tailwind: bg-rust-50, border-rust-200,
 * text-rust-700, ...). Used the way a single-accent product uses its blues:
 * 50/100 hover and selected tints, 200/300 tint lines and chart fills,
 * 600 the primary action and chart series 0, 700 to 900 text on tints.
 */
export const RUST = {
  50: '#fef4f0',
  100: '#ffe7dd',
  200: '#fdcdba',
  300: '#f6a88d',
  400: '#e67d59',
  500: '#d25b31',
  600: '#b7410e',
  700: '#973814',
  800: '#772d17',
  900: '#561f10',
} as const

/**
 * Warm neutral scale, 50 to 900 (DESIGN_BRIEF.md "Palette"). Mirrors the
 * --color-neutral-* vars in index.css. Tailwind utilities read the same
 * values: bg-neutral-100, border-neutral-300, text-neutral-600, ...
 */
export const NEUTRAL_SCALE = {
  50: '#f9f8f6',
  100: '#f4f2ee',
  200: '#ebe8e2',
  300: '#e2ddd5',
  400: '#d3cdc4',
  500: '#a8a196',
  600: '#6b655e',
  700: '#4b4640',
  800: '#33302b',
  900: '#211e1b',
} as const

/**
 * The ink ladder for text, LIGHT-mode hex (for inline styles and chart props
 * that cannot take a CSS variable). Mirrors the --color-text-* vars in
 * index.css, which also carry the dark values; prefer the Tailwind utilities
 * (text-text-primary / -secondary / -muted) or CSS_VAR below, which follow
 * the mode.
 */
export const NEUTRAL = {
  primary: NEUTRAL_SCALE[900],
  secondary: NEUTRAL_SCALE[700],
  muted: NEUTRAL_SCALE[600],
  /** Placeholders and disabled text only (fails AA on purpose: not content). */
  faint: NEUTRAL_SCALE[500],
} as const

/**
 * Mode-aware colour values as CSS variables, for inline styles (style={{ }})
 * that must follow light and dark. Not for canvas 2D drawing or SVG
 * presentation attributes (use the hex tokens there; index.css restyles the
 * chart chrome per mode).
 */
export const CSS_VAR = {
  canvas: 'var(--color-surface)',
  raised: 'var(--color-surface-raised)',
  recessed: 'var(--color-surface-recessed)',
  overlay: 'var(--color-surface-overlay)',
  control: 'var(--color-surface-control)',
  hover: 'var(--color-hover)',
  line: 'var(--color-line)',
  lineStrong: 'var(--color-line-strong)',
  textPrimary: 'var(--color-text-primary)',
  textSecondary: 'var(--color-text-secondary)',
  textMuted: 'var(--color-text-muted)',
  textFaint: 'var(--color-text-faint)',
  accentInk: 'var(--color-accent-ink)',
  select: 'var(--color-select)',
  selectLine: 'var(--color-select-line)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-error)',
  successSolid: 'var(--color-success-solid)',
  warningSolid: 'var(--color-warning-solid)',
  errorSolid: 'var(--color-error-solid)',
  tealInk: 'var(--color-teal-ink)',
  plumInk: 'var(--color-plum-ink)',
  onAccent: 'var(--color-on-accent)',
  onMedia: 'var(--color-on-media)',
} as const

/** Colour tokens tint() can mix (the --color-* name without the prefix). */
export type TintToken =
  | 'success' | 'warning' | 'error' | 'accent-ink' | 'rust-600'
  | 'text-primary' | 'text-secondary' | 'text-muted' | 'teal-ink' | 'plum-ink'

/**
 * A mode-aware tint for inline styles: tint('error', 10) is the error colour
 * at 10% over whatever sits behind it, in light and dark alike. Use it in
 * place of hex-with-alpha strings like `${SEMANTIC.error}1a`.
 */
export const tint = (token: TintToken, pct: number): string =>
  `color-mix(in oklab, var(--color-${token}) ${pct}%, transparent)`

/** Surface levels (light-mode hex mirrors of the tokens; see CSS_VAR). */
export const SURFACES = {
  canvas: '#faf9f7',
  raised: '#ffffff',
  recessed: '#f6f5f2',
  line: '#e7e3dd',
  lineStrong: '#d6d0c7',
} as const

export const SEMANTIC = {
  success: '#2d8a4e',
  warning: '#c47a15',
  error: '#c43a31',
} as const

/**
 * Change chips ("+12.4%"): a tinted pill, never a colored number. `base` is
 * the shape; add one tone. Used by widget cells, Trends, Reach and P&L.
 */
export const DELTA_CHIP = {
  base: 'text-[10px] tabular-nums px-1.5 py-0.5 rounded-full whitespace-nowrap ody-delta',
  good: 'bg-success/10 text-success',
  bad: 'bg-error/10 text-error',
  neutral: 'bg-hover text-text-muted',
} as const

/**
 * Connection-status dots (Meta/Google/Shopify tiles, etc.). Tailwind class
 * fragments for the small `w-2 h-2 rounded-full` indicator, palette-mapped to
 * SEMANTIC so status colors stay congruent. `off` is the neutral hairline.
 */
export const STATUS_INDICATOR = {
  ok: 'bg-success',
  pending: 'bg-warning',
  off: 'bg-line-strong',
} as const

/** Soft glow ring (boxShadow) matching a STATUS_INDICATOR color. */
export const STATUS_GLOW = {
  ok: { boxShadow: '0 0 0 4px rgba(45, 138, 78, 0.18)' },
  pending: { boxShadow: '0 0 0 4px rgba(196, 122, 21, 0.18)' },
} as const

/**
 * THE canonical chart palette. Use for generic multi-series charts (lines,
 * bars, areas, slices) where colors are just "series 1..N". A muted, organic
 * set built from the app's own tokens: clay (the #B7410E accent) leads, then
 * teal, dusty plum, sage, rose, ochre, slate, sandstone, pine.
 *
 * Validated (dataviz six-checks, light mode, on the tile surface #f7f6f4):
 * every hue sits in the OKLCH lightness band with chroma >= 0.10, every mark
 * clears 3:1 contrast, adjacent slots stay apart under protan/deutan
 * simulation (worst Delta E 9.1) and for full-color vision (worst 18.2), and
 * the first three slots pass all-pairs (safe for scatter plots).
 *
 * Slot meaning other code relies on: 0 clay, 1 teal, 2 plum, 4 rose,
 * 5 ochre, 6 slate (a cool blue), 9 = the neutral stone for "Other" /
 * unknown buckets and compare-period marks. Assign series in order; past
 * nine series, fold the tail into "Other" rather than cycling.
 *
 * NOTE: platform-semantic colors (Meta blue, Google blue, etc.) are a SEPARATE
 * concern, see components/mmm/types.ts CHANNEL_COLORS. Don't fold those in here.
 */
export const CHART_PALETTE = [
  '#B7410E', // 0 clay
  '#199693', // 1 teal
  '#855390', // 2 dusty plum
  '#728f48', // 3 sage
  '#b45b87', // 4 rose
  '#ab811e', // 5 ochre
  '#3e71a7', // 6 slate
  '#ba8247', // 7 sandstone
  '#127247', // 8 pine
  '#a8a29e', // 9 stone (neutral)
] as const

/** Neutral slot: "Other" buckets, unknown segments, compare-period marks. */
export const CHART_NEUTRAL = CHART_PALETTE[9]

/** Convenience: nth series color. Cycles only across the nine hue slots. */
export const seriesColor = (i: number): string => CHART_PALETTE[((i % 9) + 9) % 9]

/* ── Pills (toolbar filter chips) ─────────────────────────────────────── */

// The `ody-*` names on these constants are hooks for the Odylic look
// (ui/odylic/odylic.css). They style nothing outside a page ground.

/** Default pill trigger. `glass glass-hover`, charcoal text. */
export const PILL =
  'h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors glass glass-hover text-text-secondary ody-pill'

/**
 * Active pill (filter applied). Selection is ONE treatment everywhere: ink
 * text on a rust tint with a rust tint line (15:1 in light mode, 12:1 in
 * dark). Swap in place of the glass tail.
 */
export const PILL_ACTIVE =
  'h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors bg-select border border-select-line text-text-primary ody-pill ody-pill-on'

/** Compact pill for dense rows. */
export const PILL_COMPACT =
  'h-6 px-2 rounded-full text-[10.5px] flex items-center gap-1.5 transition-colors glass glass-hover text-text-secondary ody-pill'

export const PILL_COMPACT_ACTIVE =
  'h-6 px-2 rounded-full text-[10.5px] flex items-center gap-1.5 transition-colors bg-select border border-select-line text-text-primary ody-pill ody-pill-on'

/** Just the active (rust-tint) fragment, for conditional `${active ? ... : ...}` use. */
export const PILL_TINT = 'bg-select border border-select-line text-text-primary ody-pill ody-pill-on'
export const PILL_GLASS = 'glass glass-hover text-text-secondary ody-pill'

/**
 * Small static status badge (not a height-fixed filter pill): a rust chip,
 * uppercase eyebrow scale, rust-700 text on the tint (6.7:1). Use for inline
 * "Ready to launch"-style markers.
 */
export const BADGE_ACCENT =
  'px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-[0.06em] bg-select border border-select-line text-accent-ink ody-badge'

/** Error chip (PILL pattern, semantic-error tint), upload failures, etc. */
export const CHIP_ERROR =
  'h-6 px-2 rounded-full text-[11px] flex items-center gap-1 bg-error/10 border border-error/30 text-error'

/* ── Panels / popovers / dropdown menus ───────────────────────────────── */

/**
 * THE menu/popover surface: the solid overlay surface, rounded-xl, the
 * popover shadow, a thin line, py-1. Used by ui/Select, App header dropdowns,
 * any floating menu. Never add backdrop-blur to this.
 */
export const PANEL =
  'bg-surface-overlay rounded-xl shadow-popover border border-line py-1'

/**
 * Modal backdrop: a veil in the canvas colour, not a dark scrim, so the page
 * stays readable behind the modal. Pair with MODAL on the dialog itself.
 */
export const SCRIM = 'bg-surface/80 backdrop-blur-[3px] ody-scrim'
/** Modal dialog surface: the raised surface, 16px radius, a thin line, a deep soft shadow. */
export const MODAL =
  'bg-surface-raised rounded-2xl border border-line shadow-modal ody-modal'

/** Larger floating panels (e.g. date picker): same surface as PANEL. */
export const PANEL_LG =
  'bg-surface-overlay rounded-xl shadow-popover border border-line py-1'

/** Standard option row inside a menu. Active = ink label on a rust tint + Check(12). */
export const OPTION_ROW =
  'w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between hover:bg-hover transition-colors'
/** The selected option row's tint (add to OPTION_ROW). */
export const OPTION_ROW_ACTIVE = 'bg-select text-text-primary font-medium hover:bg-select'

/** Multi-select checkbox in an option row: ink, the state color. */
export const CHECKBOX = 'accent-text-primary'

/* ── Cards / sections ─────────────────────────────────────────────────── */

/** Big page section wrapper (chart panels). Maps to .atelier-section in index.css. */
export const SECTION = 'atelier-section'
/** KPI tile / small card. Maps to .atelier-tile in index.css. */
export const CARD = 'atelier-tile'
/** Control surface (pills, icon buttons, triggers; the class name is historic). */
export const GLASS = 'glass'

/** The thin line used for container edges and dividers (light-mode hex; class: border-line). */
export const HAIRLINE = SURFACES.line

/**
 * Media card (creative grids): raised surface, thin line, light shadow, 10px
 * radius. Hover darkens the edge and lifts the shadow; nothing moves.
 */
export const CARD_MEDIA =
  'bg-surface-raised rounded-[10px] border border-line shadow-container overflow-hidden transition-[border-color,box-shadow] duration-150 hover:border-line-hover hover:shadow-popover'

/** Selected / checked card: a rust edge plus a 1px rust ring. */
export const CARD_SELECTED = '!border-rust-500 ring-1 ring-rust-500'

/** Gutter between cards in a grid. GRID_GAP_PX must match GRID_GAP. */
export const GRID_GAP = 'gap-3'
export const GRID_GAP_PX = 12

/**
 * Section tile inside a panel or modal (raised surface, thin line, light
 * shadow, 12px radius). Isolates so open dropdowns stack above siblings.
 */
export const TILE_FLAT = 'relative isolate bg-surface-raised rounded-xl border border-line shadow-container p-4'

/** Floating overlay on a canvas or chart (strips, legends, corner controls). */
export const OVERLAY =
  'bg-surface-overlay/90 border border-line rounded-lg shadow-control ody-overlay'

/* ── Control archetypes (tabs / toggles / buttons) ────────────────────── */
//
// RULE (decided): NAVIGATION = dark fill, FILTER/SELECTION = orange tint.
//   - Tabs that switch the main content area  to dark-fill active (TAB_*).
//   - Segmented toggles that pick a mode/option (selection) to orange (SEG_*).
//   - Filter pills (Group by / Sort / applied filters) to orange (PILL_ACTIVE).

/** Sub-nav tab. Active = solid ink (matches the left nav rail). */
export const TAB =
  'h-7 px-3 rounded-full text-[11px] font-medium flex items-center gap-1.5 transition-colors text-text-secondary hover:bg-hover ody-chip'
export const TAB_ACTIVE =
  'h-7 px-3 rounded-full text-[11px] font-medium flex items-center gap-1.5 transition-colors bg-text-primary text-surface-raised ody-chip ody-chip-on'
/** Conditional tails for `${active ? TAB_ON : TAB_OFF}`. */
export const TAB_ON = 'bg-text-primary text-surface-raised ody-chip ody-chip-on'
export const TAB_OFF = 'text-text-secondary hover:bg-hover ody-chip'

/** Segmented toggle (pick a mode: selection, so the rust-tint active). */
export const SEG_ON = PILL_TINT
export const SEG_OFF = 'text-text-secondary hover:bg-hover'

/**
 * Underline tabs: page and section navigation (detail panels, Forecast,
 * Planner, Incrementality, Trends, MMM). Ink label with a rust underline on
 * the active tab. Put TAB_UNDERLINE_BAR on the row and TAB_UNDERLINE plus
 * ON / OFF on each tab. ui/Segmented variant="underline" renders exactly this.
 */
export const TAB_UNDERLINE_BAR = 'flex items-center gap-5 border-b border-line ody-tabbar'
export const TAB_UNDERLINE =
  'h-9 -mb-px flex items-center gap-1.5 text-[12px] whitespace-nowrap border-b-2 transition-colors disabled:opacity-40 ody-tab'
export const TAB_UNDERLINE_ON = 'border-rust-600 text-text-primary font-medium ody-tab-on'
export const TAB_UNDERLINE_OFF = 'border-transparent text-text-muted hover:text-text-secondary hover:border-line-strong'

/** Bare icon button (panel headers, canvas corners): no surface until hovered. */
export const BTN_ICON =
  'rounded-md p-1.5 text-text-secondary hover:text-text-primary hover:bg-hover transition-colors disabled:opacity-40 ody-btn-icon'

/**
 * Actions on a row of a list or menu (rename, export, delete): 10px icons in
 * bare round buttons, shown while the row (`group`) is hovered or one of them
 * has focus. ROW_ACTIONS goes on their wrapper. Icons by job, app wide: a
 * Pencil renames or edits content the user wrote, the SlidersHorizontal pill
 * (charts/AxesControl) sets what a chart, table or tile shows, and the gear is
 * App Settings only.
 */
export const ROW_ACTIONS =
  'flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity'
export const BTN_ROW_ICON =
  'p-1 rounded-full text-text-muted hover:text-text-primary hover:bg-hover transition-colors'
/** BTN_ROW_ICON for a delete: turns the error colour on hover. */
export const BTN_ROW_ICON_DANGER =
  'p-1 rounded-full text-text-muted hover:text-error hover:bg-hover transition-colors'

/** Primary action button: solid rust-600 with white text (5.6:1), rust-700 on hover. */
export const BTN_PRIMARY =
  'h-8 px-3.5 rounded-full text-[12px] font-medium flex items-center gap-1.5 transition-colors bg-rust-600 text-on-accent hover:bg-rust-700 disabled:opacity-50 ody-btn-primary'
/** Secondary action button, glass/ghost. */
export const BTN_SECONDARY =
  'h-8 px-3 rounded-full text-[12px] font-medium flex items-center gap-1.5 transition-colors glass glass-hover text-text-secondary disabled:opacity-50 ody-btn-secondary'

/* ── Typography ───────────────────────────────────────────────────────── */

/** Page / section heading, serif display, 16px. Maps to .atelier-section-title. */
export const HEADING = 'font-display text-base font-medium ody-heading'
/** KPI number, serif display, large, tabular. Maps to .atelier-kpi-number. */
export const KPI_NUMBER = 'font-display text-2xl font-medium tabular-nums ody-kpi-number'
/** Eyebrow label above a KPI / section. Maps to .atelier-kpi-label. */
export const KPI_LABEL =
  'text-[10px] uppercase tracking-[0.06em] text-text-muted ody-label'
/** Same eyebrow, the name the brief uses. Never tracking-widest on labels. */
export const EYEBROW = KPI_LABEL

/**
 * Spec rows (label left, value right): the label truncates, the value never
 * does, digits align on the right edge.
 */
export const ROW_LABEL = 'text-[11px] text-text-muted truncate'
export const ROW_VALUE = 'text-[11.5px] font-medium tabular-nums text-text-primary whitespace-nowrap'

/* ── Type scale (the canonical font-size ramp) ────────────────────────── */
//
// Snap every stray `text-[Npx]` to the NEAREST of these. Body/control ramp is
// 10 to 16; display is 20/24/30. Don't homogenize on-ramp sizes, only collapse
// outliers (8/8.5/9 to 10; 12.5 to 12; 13.5 to 13; 15 to 14; 18 to 16/20; 34 to 30).
export const FONT = {
  label: 'text-[10px]',   // eyebrows, table headers, meta
  ctrl: 'text-[11px]',    // pills, tabs, dense UI, captions
  body: 'text-[12px]',    // option rows, table cells
  bodyLg: 'text-[13px]',  // chat / input, readable body
  subhead: 'text-sm',     // 14px, section subheads
  heading: 'text-base',   // 16px, titles (with font-display)
  xl: 'text-xl',          // 20px
  display: 'text-2xl',    // 24px, KPI hero numbers
  displayLg: 'text-3xl',  // 30px
} as const

/* ── Surfaces (the canonical background ladder, as utility classes) ──────── */
//
// Use these instead of bg-white/NN and black alphas: they follow the mode.
export const SURFACE = {
  canvas: 'bg-surface',
  panel: 'bg-surface-raised',
  overlay: 'bg-surface-overlay',
  inputFill: 'bg-surface-recessed',
  recessed: 'bg-surface-recessed',
  glass: 'bg-surface-control',
  hover: 'bg-hover',
  hairline: 'border-line',
  controlLine: 'border-line-strong',
} as const

/* ── Chart house style (recharts props) ───────────────────────────────── */
//
// Small warm-grey ticks, faint dashed horizontals only (no vertical grid),
// thin lines, a white tooltip with a hairline and a soft shadow.
export const CHART = {
  tick: { fontSize: 10, fill: NEUTRAL_SCALE[600] },
  grid: 'rgba(0,0,0,0.06)',
  gridDash: '2 4',
  lineWidth: 1.75,
  tooltip: {
    fontSize: 11, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)',
    boxShadow: '0 8px 24px -8px rgba(0,0,0,0.18)', padding: '6px 10px',
  },
} as const

/* ── Raw hex helpers (for inline styles / recharts props) ─────────────── */

export const HEX = {
  accent: ACCENT.deep,
  accentLight: ACCENT.light,
  accentText: ACCENT.text,
  teal: TEAL.light,
  textPrimary: NEUTRAL.primary,
  textSecondary: NEUTRAL.secondary,
  textMuted: NEUTRAL.muted,
  gridLine: 'rgba(0,0,0,0.06)',
  hairline: SURFACES.line,
} as const
