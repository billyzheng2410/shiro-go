# Changelog

## 1.3.1

- Start the analysis deadline when KataGo receives the request and cancel only the timed-out search.
- Remember the desktop game and language across local port changes. Import a legacy browser save on the original address.
- Reuse one Windows process even when the app opens twice at the same time.
- Keep setup checks in sync with the selected backend and directory.
- Open manual scoring when AI analysis is unavailable and send only the position fields needed for scoring long games.

## 1.3.0

- Windows x64 standalone EXE with an embedded Node runtime, browser-based first-run setup, persistent local data, port selection, and app shutdown.
- Chinese/English interface switching and separate linked English/Chinese READMEs.
- Full-strength KataGo scoring, automatic two-pass scoring, suggested dead stones, territory review, and manual whole-group corrections.
- Ownership normalized to black's perspective; final-position scoring replays the same board before the ending passes.
- Installer, scoring, localization, HTTP, and no-external-Node executable checks.

中文：新增免装 Node.js 的 Windows EXE、中英文切换，以及可复核死活的 AI 自动数子。计算始终使用下载者的本机 CPU／GPU。
