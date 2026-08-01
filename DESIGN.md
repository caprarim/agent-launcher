# Design

## Theme

Dark only. A deep blue-black night surface with a faint procedural starfield on the workspace canvas. Panels float above it as slightly lighter ink surfaces. One warm orange accent carries state and primary actions, continuing the identity of the previous launcher.

## Color (OKLCH)

| Token | Value | Use |
|---|---|---|
| --bg | oklch(0.17 0.02 255) | app background, canvas night |
| --bg-deep | oklch(0.13 0.02 255) | canvas vignette, wells |
| --surface | oklch(0.22 0.02 250) | cards, bars, panels |
| --surface-2 | oklch(0.26 0.02 250) | headers, inputs, hover |
| --line | oklch(0.32 0.02 250) | borders |
| --ink | oklch(0.93 0.01 250) | primary text |
| --ink-mute | oklch(0.72 0.02 250) | secondary text |
| --ink-faint | oklch(0.55 0.02 250) | hints, placeholders |
| --accent | oklch(0.74 0.16 55) | working state, active selection, primary action |
| --accent-ink | oklch(0.22 0.05 55) | text on accent |
| --ok | oklch(0.78 0.14 150) | done, healthy |
| --danger | oklch(0.68 0.19 25) | exited, errors |

## Typography

- UI: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif. One family for everything.
- Terminal and data: "Cascadia Mono", Consolas, monospace.
- Fixed rem scale, ratio 1.2: 12, 13 (base), 15, 18, 22. Labels 12 medium, body 13, card titles 13 semibold, bar title 15.

## Components

- Agent card: floating panel, 8px radius, 1px line border, header (status dot, persona name, task label, controls), xterm body. Drag by header, resize by corner. Working: accent dot with soft pulse. Done: ok dot. Exited: danger dot.
- Orchestrator bar: floating pill bottom center. Orb (state animation), last exchange text, push-to-talk button with keybind hint, model chip, workspace pills, settings gear. Asleep: bar dims and collapses to a slim pill.
- Preview card: same panel anatomy with URL field and an iframe body.
- Settings: right-side panel, not a modal.

## Motion

150 to 250 ms, ease-out (cubic-bezier(0.16, 1, 0.3, 1)). Orb breathing 3 s loop, subtle. Working dot pulse 1.6 s. All animation removed under prefers-reduced-motion.

## Layout

Free canvas per workspace: cards keep user positions, new cards cascade from top left. Bars float: top left toolbar (add agent, add preview), bottom center orchestrator bar. z scale: card 10, dragged card 20, bars 30, settings 40, toasts 50.
