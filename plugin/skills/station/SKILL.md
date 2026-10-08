---
name: station
description: Open, focus or control the WSC station window, a live 2D pixel-art view of your Claude Code agents at work. Use when the user types /station or asks to open, show, launch or focus "the station" (or WSC), switch its theme, open compact mode, play the demo, or check whether it is running.
argument-hint: '[compact | theme <name> | demo | status]'
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs" $ARGUMENTS`

The line above is the result of running the WSC launcher. Reply with exactly that one line and nothing else: no commentary, no follow-up questions, and do not run any other tools.
