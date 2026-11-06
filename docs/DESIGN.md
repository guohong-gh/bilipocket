---
name: BiliPocket
description: A local-first Bilibili downloader with a neutral, high-density desktop interface.
colors:
  paper: "#FAFAFA"
  paperRaised: "#FFFFFF"
  paperMuted: "#F6F7F8"
  paperInset: "#F3F4F6"
  ink: "#1F2328"
  inkMedium: "#4B5563"
  inkMuted: "#6B7280"
  inkFaint: "#9CA3AF"
  hairline: "#E5E7EB"
  hairlineStrong: "#D1D5DB"
  accent: "#E60023"
  accentHover: "#C9001F"
  accentSoft: "rgba(230, 0, 35, 0.10)"
  onAccent: "#FFFFFF"
  paperDark: "#0B0C0E"
  paperRaisedDark: "#15171A"
  paperMutedDark: "#0F1113"
  paperInsetDark: "#1B1E22"
  surface3Dark: "#24282E"
  inkDark: "#ECEEF1"
  inkMediumDark: "#C3C7CE"
  inkMutedDark: "#9AA1AB"
  inkFaintDark: "#6F7681"
  hairlineDark: "#26292E"
  hairlineStrongDark: "#3A3E45"
  accentDark: "#FF4D6D"
  accentHoverDark: "#FF6B85"
  accentSoftDark: "rgba(255, 77, 109, 0.16)"
  onAccentDark: "#0B0C0E"
  selectionDark: "rgba(255, 77, 109, 0.24)"
  successDark: "#4ADE80"
  warningDark: "#FBBF24"
  dangerDark: "#F87171"
  success: "#15803D"
  warning: "#B45309"
  danger: "#DC2626"
typography:
  display:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  section:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.015em"
  control:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "Cascadia Mono, Cascadia Code, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  micro: "1px"
  xs: "2px"
  sm: "3px"
  md: "4px"
  lg: "5px"
  xl: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  section: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.onAccent}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accentHover}"
    textColor: "{colors.onAccent}"
    rounded: "{rounded.sm}"
  button-ghost:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "36px"
  segmented:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.inkMedium}"
    rounded: "{rounded.sm}"
    height: "38px"
  nav-item:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.inkMedium}"
    rounded: "{rounded.sm}"
    height: "40px"
    width: "100%"
---

# Design System: BiliPocket

## Overview

**Creative North Star: "Screening Ledger / 放映日志"**

BiliPocket is a local download workspace, not a dashboard. The parse line is the first thing seen; queue and history are readable ruled lists; settings are a focused column of semantic cards. The interface is quiet, precise and desktop-native: neutral surfaces, near-black ink, one Bilibili-pink accent, and information that reads like a tool rather than a promotional stack.

The surface is an Operate surface. Download, queue and history remain flat ruled ledger rows; Settings uses flat, hairline-bordered cards to make four semantic groups scannable. There is no decorative glow, no gradient chrome, no nested card composition, and no page-load choreography. Personality comes from numbering, timecodes, tabular numerals, and the single accent used for action, selection and active transfer.

**Key Characteristics:**
- Neutral light workspace with a near-black dark counterpart.
- Flat bordered settings cards; ruled queue/history lists; no ambient shadows.
- One Bilibili-pink accent, reserved for action, selection and active transfer.
- System UI type with monospaced timecodes, sizes and identifiers.
- Dense rows with generous page margins; no text below 12px.

## Colors

The palette is a neutral workspace system with a single Bilibili-pink accent. The ground stays quiet; the accent marks action and selection rather than washing whole regions.

### Primary
- **Bilibili Pink** (#E60023): primary actions, active navigation, selected quality, active progress and small status marks. Hover deepens to #C9001F; its soft wash is `rgba(230,0,35,.10)`.

### Neutral
- **Workspace** (#FAFAFA): the page and content ground.
- **Raised Surface** (#FFFFFF): cards, modal and toast sheets.
- **Muted Surface** (#F6F7F8): path fields, inset notes and secondary areas.
- **Inset Surface** (#F3F4F6): selected rows and subdued controls.
- **Ink** (#1F2328): headings, titles and primary data.
- **Medium Ink** (#4B5563): body and secondary data.
- **Muted Ink** (#6B7280): metadata, labels and descriptions.
- **Faint Ink** (#9CA3AF): decorative rules, idle dots and non-essential icon accents only.
- **Hairline** (#E5E7EB) and **Strong Hairline** (#D1D5DB): row separators, table heads and section rules.

### Named Rules
**The One Stamp Rule.** Bilibili pink appears only on the primary action, the current selection, active transfer state and status marks. It never fills a decorative panel or a page region.

**The No Neon Rule.** No glow, gradient chrome, glass or colored halo belongs on this surface.

## Typography

**Display Font:** Segoe UI Variable Text / Microsoft YaHei UI (system stack)  
**Body Font:** the same system stack  
**Label/Mono Font:** Cascadia Mono (fallback Consolas)

**Character:** one workhorse sans for the whole interface, with a tabular mono voice only for measurable data. The mono is a measurement tool, never a costume.

### Hierarchy
- **Display** (600, 28px/1.2, -0.03em): parse heading and page-level product statements.
- **Headline** (600, 22px/1.3, -0.025em): result titles and major notices.
- **Title** (600, 20px/1.2, -0.02em): page titlebar.
- **Section** (600, 15px/1.4, -0.015em): settings card headings.
- **Control / row** (500, 13px/1.4): buttons, navigation rows and task titles.
- **Body** (400, 14px/1.55): descriptions and guidance, kept near 68ch.
- **Label** (500, 12px/1.5): metadata, row labels and status text; this is the floor.
- **Mono** (400, 12px/1.5): BV numbers, timecodes, sizes, percentages, speeds and paths.

### Named Rules
**The 12px Floor.** No visible text is smaller than 12px. Density comes from line rhythm, not from shrinking labels.

**Data Wears Mono.** Anything measurable — time, bytes, percentages, identifiers — is set in the mono face with tabular numerals.

## Layout

A fixed 200px sidebar holds the wordmark and five navigation rows; a 56px titlebar carries the page identity, quick parse, three-state theme control and window controls. Content is centered inside the workspace with a 1040px maximum and 36px side padding. Download, queue and history use the wider reading column; Settings is a single 720px column centered in the workspace.

The Download page opens on one strong parse line, then a two-column ledger: recent completions on the left, a quiet local-first note and the live queue activity in the right rail. The result is a 300px cover beside a data column. Queue is grouped into 进行中 / 已完成 / 已取消或失败, with each group a ruled list; history remains a ruled list. Settings is four semantic cards in one column: 下载行为 / 账号与清晰度 / 通知与系统 / 存储与诊断. About is a colophon.

At 1180px the sidebar stays 200px and padding tightens to 28px; at 1000px the sidebar becomes a 64px icon rail and the quick parse hides, with Ctrl/Cmd+K returning to the main input; at 960px the result and home rail stack; at 900px padding becomes 24px and inline settings rows stack; at 640px cards and path rows fill the viewport and segmented controls wrap. The 1040×700 window is the shipping floor; 900px is browser-preview only.

## Elevation & Depth

Surfaces are flat at rest. Depth is carried by neutral surfaces, 1px borders, ruled lists and spacing, not by shadows. Settings cards use a white surface with a 1px hairline border and 8px radius. Only the three true overlays — modal, right-side extras drawer and toast — lift from the page with `0 16px 40px -24px rgba(15, 23, 42, 0.20)` in light and `0 20px 48px -24px rgba(0, 0, 0, 0.8)` in dark.

### Named Rules
**The Flat-By-Default Rule.** No card, row, button or field gets a resting shadow. A shadow is a response to an overlay, never a decoration.

## Shapes

The form language is compact and rectilinear: 4px for micro marks, 8px for cards, controls and sheets, and 8px for the modal. Borders are 1px hairlines. The switch is the only intentional pill. There are no bubbly 16–24px radii and no nested card silhouettes. Icons use one 1.5px line set; the brand mark is a flat outlined download arrow.

## Components

### Buttons
- **Shape:** 3px radius, 36px default height, 30px compact height.
- **Primary:** Bilibili pink fill with `#FFFFFF` text; hover deepens the fill and active moves down 1px.
- **Ghost:** Paper background with a 1px hairline and ink text; hover warms the surface.
- **Quiet / link:** Text-only until hover; used for secondary and destructive row actions.
- **Focus:** 2px accent outline with 2px offset; disabled controls fade to 42%.

### Inputs / Fields
- **Style:** 1px hairline, paper ground, 3px radius, 10px horizontal inset. The URL field is a single ruled line with a 50px row height.
- **Focus:** the hairline shifts to medium ink; error uses the danger hue.
- **States:** hover, focus, filled, error, disabled and loading are all present.

### Navigation
- **Style:** 38px rows with a 3px accent left rule only on the active row; active surface uses the 10% pink tint with pink text. Icons are 18px, 1.5px line. At 1000px the rail becomes 64px and labels become accessible names plus tooltips.

### Signature: Ledger Row
- **Style:** 26px index + 112px cover + flexible body + actions. A 1px top rule separates rows; there is no row card.
- **Progress:** a 2px hairline track with a pink fill and a 7px leading tick; the metrics underneath use mono for speed, size, remaining time and percent.
- **States:** downloading uses pink, paused amber, queued muted, failed danger, completed success; status text always accompanies the color.

### Chips & Metadata
No pill chips. Quality, format and counts are plain mono or label text; the only square marks are 5px status dots, the 12px quality radio and the 14px extra checkbox.

### Quality Selector
- **Structure:** a two-column grid of hairline-bottom records, two rows of information per cell: 12px square radio + 13px quality label on the first line; mono format/size on the second. Below 640px it becomes one column.
- **Recommendation:** a small pink “推荐” label sits beside the recommended accessible tier; recommended is 1080P when available, otherwise the highest accessible non-audio tier.
- **Account status:** the section head’s right label reads `未登录 · 3 档受限`, `已登录 · 2 档受限`, `大会员 · 全部可用`, or the no-downloadable-tier state.
- **Locked rows:** supported but inaccessible tiers are real disabled buttons: hairline grid, ink-3 label and detail, a 12px lock icon and a visible reason (`登录后可下载` or `大会员专享`). They never receive the selection background or roving tab stop.
- **States:** active uses a pink radio and `--accent-soft` background; hover only applies to selectable rows; no re-render on selection.
- **Empty:** unsupported video qualities are absent; no qualities at all becomes a 12px note, never an empty radiogroup.

### Quality Preference & Demo Account
- **Default quality:** settings render a segmented control that wraps when needed: `自动` plus the quality tiers currently accessible to the account. The active choice uses the 10% pink tint and pink text, with a roving tab stop.
- **Demo account:** a three-option segmented control (`未登录` / `已登录` / `大会员`) explicitly labeled as local simulation; it changes only which simulated qualities are available and never performs login or network access. On desktop it is replaced by the real account row.
- **Availability:** the account card shows a read-only quality-tier summary with locked reasons (`登录后可下载` / `大会员专享`), while the default-quality control lists only accessible tiers.
- **Fallback:** unavailable preferred tiers resolve to the nearest accessible supported tier; the same rule is stated in the helper copy.

### Download Extras Selector
- **Structure:** a hairline-topped section between quality and actions, titled “弹幕与字幕” with two compact category rows: danmaku and subtitles.
- **Row:** left is a 14px tri-state checkbox (checked, indeterminate dash, empty, or disabled); center is the category name over a 12px summary of exact availability and current selection; right is a 30px ghost “更多设置” button with the sliders icon.
- **Summary:** danmaku reads total + selection (e.g. “共 21,000 条 · 已选 3/5 类”); subtitles read language count (e.g. “2 种语言 · 已选 1 种”); an unavailable row says “无可用弹幕/字幕” and disables both controls.
- **States:** pink fill and tick when full, pink fill and dash when mixed, plain hairline when empty; focus ring on the mark; no re-render on toggle.

### Extras Drawer
- **Structure:** a full-height 380px paper sheet on the right over the dimmed page, separated by a strong left hairline and lifted only as an overlay. Header holds the title and close button; the scrolling body holds the live summary and the 弹幕 / 字幕 groups; footer holds “完成”.
- **Group:** group name with exact selected/available counts, 全选 and 清空 text buttons, one-column 38px option rows (14px checkbox, 12px name, right-aligned mono count); an unavailable group becomes a 12px note.
- **Behavior:** opens from either row and focuses that group’s first available option; every change updates the result rows live; closes via 完成, close, Escape or backdrop and restores focus to the opener. The background is inert, Tab is trapped, only one drawer exists, and its z-index stays below the modal.

### Toasts, Modals & Drawer
Toast: raised paper, 1px strong hairline, 4px radius, offset shadow, icon + title + message + optional action. Modal: 420px paper sheet, dimmed page, focus trap, Escape and a cancel-first focus policy; destructive confirm is a solid danger button. Cancel and removal dialogs may include a default-off checkbox to delete the corresponding partial or completed files, including subtitle/danmaku sidecars. Drawer: 380px full-height right sheet, dimmed page, focus trap, inert background, Escape / backdrop / 完成 close, focus restored to the opener.

### Theme Control
A single 28px icon button in the titlebar cycles `浅色 → 深色 → 跟随系统 → 浅色`, with sun, moon and monitor icons. Its tooltip and accessible name state the current preference and the next state; the settings page has no separate theme card.

## Do's and Don'ts

### Do:
- **Do** keep the workspace neutral and the pink accent for action/selection; use hairlines to separate information.
- **Do** use flat, bordered cards for Settings and ruled lists for queue/history.
- **Do** use mono for timecodes, sizes, BV numbers and percentages, and tabular numerals for counts.
- **Do** preserve the 12px floor, 30px+ controls, 38–40px navigation rows and visible focus.
- **Do** keep the full-bleed ledger rows and the right-rail queue activity on Download.
- **Do** keep both themes token-complete and test at 1440/1280/1040/900.

### Don't:
- **Don't** add gradients, glow, glass, colored halos or resting card shadows.
- **Don't** nest cards inside settings cards or introduce pill badges for status.
- **Don't** use a display serif, a decorative mono, or text below 12px.
- **Don't** use color as the only status signal or hide the queue's live state below the first screen.
- **Don't** change the simulated-data and compliance disclosures when restyling.
