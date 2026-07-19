# Prompt.AI

A local-first prompt manager built specifically for **Claude** and **ChatGPT** — save, organize, and drop your prompts straight into the chat box without ever leaving the page.

No account. No cloud. No subscription. Your prompts stay in your browser, on your machine.

## Why

Most AI prompt managers try to do everything — every AI platform, cloud sync, team libraries, marketplaces. Prompt.AI does one thing well: a fast, keyboard-driven prompt library for the two tools developers actually live in, that never sends your data anywhere.

## Features

- **On-page insertion** — a floating trigger on claude.ai and chatgpt.com opens a searchable prompt picker and inserts your prompt directly into the chat composer. No copy-paste.
- **Magic Copy** — write prompts with `{{Variable}}` placeholders; fill them in on the spot before inserting or copying.
- **`{{selection}}` capture** — highlight any text on the page (a stack trace, a code snippet, an AI response) and it auto-fills into a prompt's `{{selection}}` variable.
- **Global keyboard shortcut** — `Alt+Shift+P` opens the picker from anywhere, no mouse required. Fully remappable at `chrome://extensions/shortcuts`.
- **Folders, tags, favorites, search** — organize prompts your way; click any tag to filter instantly.
- **Quick Access** — your most-used prompts surface automatically, ranked by frequency and recency.
- **Version history** — every edit is saved. Restore an earlier draft any time; prompt engineering is iterative, your library remembers that.
- **Import / export** — take your prompts anywhere as JSON.
- **100% local** — everything lives in `chrome.storage.local`. Nothing leaves your browser, no account required.

## Install (unpacked, for now)

Not yet on the Chrome Web Store — load it manually:

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension/` folder from this repo.
5. Pin the extension from the puzzle-piece icon in your toolbar for quick access.

That's it — no build step, no dependencies to install.

## Using it

- **Popup** — click the toolbar icon to browse, create, edit, and organize prompts.
- **On any claude.ai or chatgpt.com page** — click the floating ⚡ button (or press `Alt+Shift+P`) to search your prompts and insert one directly into the chat box.
- **Variables** — write `{{Topic}}`, `{{Language}}`, etc. in a prompt's content; you'll be asked to fill them in before it's inserted or copied. A variable named `{{selection}}` is auto-filled from whatever text you last highlighted on the page.
- **Version history** — open a prompt to edit it, then click **History** to see and restore earlier drafts.

## Project structure

```
extension/
  manifest.json     Chrome MV3 manifest — permissions, content scripts, keyboard command
  popup.html/js      the toolbar popup UI (browse, create, edit, organize)
  js/storage.js      chrome.storage.local data layer — CRUD, usage tracking, version history
  js/content.js      injected on claude.ai / chatgpt.com — the on-page picker + insertion
  js/background.js   relays the global keyboard shortcut to the active tab
  css/popup.css      popup styling
  icons/             toolbar icons
```

## Privacy

Prompt.AI requests only the permissions it needs to function: local storage, clipboard write, and access to claude.ai/chatgpt.com to insert prompts into the composer. There is no analytics, no external network calls, no account system. Your prompt library never leaves your machine.

## License

All rights reserved — no license has been designated yet.
