/**
 * PromptDock — Content Script
 * Runs on claude.ai / chatgpt.com. Adds a floating trigger that opens a
 * searchable prompt picker and inserts the (variable-filled) result
 * directly into the page's chat composer.
 *
 * Deliberately NOT built with Shadow DOM: claude.ai/chatgpt.com both watch
 * document.activeElement and steal focus back to their own composer if it
 * doesn't look like an editable field. A Shadow DOM host reports as the
 * shadow *host* element (not the real <input> inside it) to document.activeElement,
 * so the site sees "nothing editable focused" and yanks focus away on every
 * keystroke. Attaching directly to the light DOM makes the real <input> the
 * reported activeElement, so the site's own logic leaves it alone.
 * Trade-off: no CSS isolation, so every class name below is prefixed `pai-`.
 */

(function () {
  // Candidate composer selectors per site, tried in order — both sites'
  // composers are contenteditable divs that can change class names across
  // deploys, so we try a few and fall back to "first contenteditable in a form".
  const COMPOSER_SELECTORS = [
    '#prompt-textarea',                 // ChatGPT
    'div.ProseMirror[contenteditable="true"]', // Claude
    'form [contenteditable="true"]',
    'form textarea'
  ];

  function findComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function insertIntoComposer(el, text) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } else {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function extractText(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.innerText;
  }

  // Track the most recent non-empty text selection on the page. Clicking our
  // own trigger button collapses the page's live selection before our click
  // handler runs, so we can't just read window.getSelection() at click time —
  // we keep the last real selection cached instead, updated as the user selects.
  let lastSelection = '';
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection().toString();
    if (sel && sel.trim()) lastSelection = sel;
  });

  // ===== UI (light DOM — see focus-stealing note above) =====
  const widget = document.createElement('div');
  widget.id = 'promptai-widget';
  widget.style.cssText = 'all: initial; position: fixed; bottom: 20px; right: 20px; z-index: 2147483647; font-family: -apple-system, "Segoe UI", sans-serif;';

  const style = document.createElement('style');
  style.textContent = `
    #promptai-widget * { box-sizing: border-box; font-family: -apple-system, 'Segoe UI', sans-serif; }
    #promptai-widget .pai-trigger {
      width: 46px; height: 46px; border-radius: 50%; border: none; cursor: pointer;
      background: linear-gradient(135deg, #7c6cff, #6a58f0); color: #fff; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 18px rgba(124,108,255,0.45), 0 1px 2px rgba(0,0,0,0.3);
      transition: transform 0.16s cubic-bezier(0.4,0,0.2,1), box-shadow 0.16s cubic-bezier(0.4,0,0.2,1);
      animation: pai-pulse 2.6s ease-in-out infinite;
    }
    #promptai-widget .pai-trigger svg { transition: transform 0.18s cubic-bezier(0.4,0,0.2,1); }
    #promptai-widget .pai-trigger .pai-icon-close { display: none; }
    #promptai-widget .pai-trigger.pai-active .pai-icon-open { display: none; }
    #promptai-widget .pai-trigger.pai-active .pai-icon-close { display: block; }
    #promptai-widget .pai-trigger:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 8px 24px rgba(124,108,255,0.55); animation-play-state: paused; }
    #promptai-widget .pai-trigger:active { transform: translateY(0) scale(0.98); }
    #promptai-widget .pai-trigger.pai-active { animation: none; box-shadow: 0 4px 18px rgba(124,108,255,0.55), 0 1px 2px rgba(0,0,0,0.3); }
    @keyframes pai-pulse {
      0%, 100% { box-shadow: 0 4px 18px rgba(124,108,255,0.45), 0 1px 2px rgba(0,0,0,0.3), 0 0 0 0 rgba(124,108,255,0.4); }
      50% { box-shadow: 0 4px 18px rgba(124,108,255,0.45), 0 1px 2px rgba(0,0,0,0.3), 0 0 0 8px rgba(124,108,255,0); }
    }
    #promptai-widget .pai-panel {
      position: absolute; bottom: 58px; right: 0; width: 330px; max-height: 420px;
      background: rgba(15,15,20,0.98); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04);
      display: none; flex-direction: column; overflow: hidden; color: #f5f5f7;
      opacity: 0; transform: translateY(8px) scale(0.98);
      transition: opacity 0.18s cubic-bezier(0.16,1,0.3,1), transform 0.18s cubic-bezier(0.16,1,0.3,1);
    }
    #promptai-widget .pai-panel.pai-open { display: flex; opacity: 1; transform: translateY(0) scale(1); }
    #promptai-widget .pai-search { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    #promptai-widget .pai-search input {
      width: 100%; padding: 8px 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 7px; color: #f5f5f7; font-size: 13px; outline: none;
      transition: border-color 0.16s, box-shadow 0.16s;
    }
    #promptai-widget .pai-search input:focus { border-color: rgba(124,108,255,0.5); box-shadow: 0 0 0 3px rgba(124,108,255,0.18); }
    #promptai-widget .pai-list { overflow-y: auto; flex: 1; }
    #promptai-widget .pai-item { padding: 9px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.12s; }
    #promptai-widget .pai-item:hover, #promptai-widget .pai-item.pai-active { background: rgba(124,108,255,0.16); }
    #promptai-widget .pai-item .pai-folder { color: #93939f; font-size: 11px; margin-left: 6px; }
    #promptai-widget .pai-empty { padding: 18px; color: #93939f; font-size: 12px; text-align: center; }
    #promptai-widget .pai-vars { padding: 12px; border-top: 1px solid rgba(255,255,255,0.08); display: none; flex-direction: column; gap: 8px; }
    #promptai-widget .pai-vars.pai-open { display: flex; }
    #promptai-widget .pai-vars label { font-size: 11px; color: #93939f; text-transform: capitalize; font-weight: 600; }
    #promptai-widget .pai-vars input {
      width: 100%; padding: 6px 8px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 7px; color: #f5f5f7; font-size: 13px; outline: none; margin-top: 3px;
      transition: border-color 0.16s, box-shadow 0.16s;
    }
    #promptai-widget .pai-vars input:focus { border-color: rgba(124,108,255,0.5); box-shadow: 0 0 0 3px rgba(124,108,255,0.18); }
    #promptai-widget .pai-insert-btn {
      margin-top: 4px; padding: 8px; background: linear-gradient(135deg, #7c6cff, #6a58f0); color: #fff; border: none; border-radius: 7px;
      cursor: pointer; font-size: 12px; font-weight: 600; transition: transform 0.12s, box-shadow 0.12s;
    }
    #promptai-widget .pai-insert-btn:hover { box-shadow: 0 4px 14px rgba(124,108,255,0.4); }
    #promptai-widget .pai-back { font-size: 11px; color: #93939f; cursor: pointer; margin-bottom: 4px; }
    #promptai-widget .pai-back:hover { color: #f5f5f7; }
    #promptai-widget .pai-toast {
      position: absolute; bottom: 58px; right: 0; padding: 9px 14px; background: rgba(15,15,20,0.98);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 9px; font-size: 12px; color: #f5f5f7;
      white-space: nowrap; box-shadow: 0 10px 28px rgba(0,0,0,0.4);
      opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
    }
    #promptai-widget .pai-toast.pai-show { opacity: 1; }
  `;

  widget.innerHTML = `
    <button class="pai-trigger" title="PromptDock — insert a saved prompt (Alt+Shift+P)">
      <svg class="pai-icon-open" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
      <svg class="pai-icon-close" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="pai-panel">
      <div class="pai-search"><input type="text" placeholder="Search prompts..." /></div>
      <div class="pai-list"></div>
      <div class="pai-vars"></div>
    </div>
    <div class="pai-toast"></div>
  `;
  document.head.appendChild(style);
  document.body.appendChild(widget);

  // Keep keystrokes inside the widget from reaching the host page's own
  // global key handlers (e.g. keyboard-shortcut or "refocus composer" logic).
  ['keydown', 'keyup', 'keypress'].forEach(evt => {
    widget.addEventListener(evt, (e) => e.stopPropagation());
  });
  widget.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  const trigger = widget.querySelector('.pai-trigger');
  const panel = widget.querySelector('.pai-panel');
  const searchInput = widget.querySelector('.pai-search input');
  const list = widget.querySelector('.pai-list');
  const varsBox = widget.querySelector('.pai-vars');
  const toastEl = widget.querySelector('.pai-toast');

  function showWidgetToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('pai-show');
    setTimeout(() => toastEl.classList.remove('pai-show'), 2500);
  }

  let allPrompts = [];
  let activePrompt = null;
  let highlightedIndex = -1;

  async function loadPrompts() {
    allPrompts = await PromptDB.getAll();
  }

  function renderList(filter) {
    varsBox.classList.remove('pai-open');
    varsBox.innerHTML = '';
    list.style.display = 'block';
    searchInput.style.display = 'block';
    highlightedIndex = -1;

    const q = (filter || '').toLowerCase();
    const matches = allPrompts.filter(p => !q || p.title.toLowerCase().includes(q) || (p.tags || []).join(' ').toLowerCase().includes(q));

    if (matches.length === 0) {
      list.innerHTML = '<div class="pai-empty">No prompts found.</div>';
      return;
    }

    list.innerHTML = matches.map(p =>
      `<div class="pai-item" data-id="${p.id}">${escapeHtml(p.title)}<span class="pai-folder">${escapeHtml(p.folder)}</span></div>`
    ).join('');

    list.querySelectorAll('.pai-item').forEach(el => {
      el.addEventListener('click', () => selectPrompt(el.dataset.id));
    });
  }

  function moveHighlight(delta) {
    const items = list.querySelectorAll('.pai-item');
    if (items.length === 0) return;
    if (highlightedIndex >= 0) items[highlightedIndex].classList.remove('pai-active');
    highlightedIndex = (highlightedIndex + delta + items.length) % items.length;
    items[highlightedIndex].classList.add('pai-active');
    items[highlightedIndex].scrollIntoView({ block: 'nearest' });
  }

  function selectHighlighted() {
    const items = list.querySelectorAll('.pai-item');
    if (highlightedIndex >= 0 && items[highlightedIndex]) {
      selectPrompt(items[highlightedIndex].dataset.id);
    } else if (items.length === 1) {
      selectPrompt(items[0].dataset.id);
    }
  }

  function selectPrompt(id) {
    activePrompt = allPrompts.find(p => p.id === id);
    if (!activePrompt) return;

    const text = extractText(activePrompt.content);
    const regex = /\{\{\s*([a-zA-Z0-9_\s-]+)\s*\}\}/g;
    const vars = [...new Set([...text.matchAll(regex)].map(m => m[1].trim()))];

    if (vars.length === 0) {
      finish(text);
      return;
    }

    list.style.display = 'none';
    searchInput.style.display = 'none';
    varsBox.classList.add('pai-open');
    varsBox.innerHTML = '<div class="pai-back">&larr; Back</div>' +
      vars.map(v => {
        const prefill = v.toLowerCase() === 'selection' ? escapeHtml(lastSelection) : '';
        return `<label>${escapeHtml(v.replace(/_/g, ' '))}<input type="text" data-var="${escapeHtml(v)}" value="${prefill}" /></label>`;
      }).join('') +
      '<button class="pai-insert-btn">Insert</button>';

    varsBox.querySelector('.pai-back').addEventListener('click', () => renderList(searchInput.value));
    varsBox.querySelector('.pai-insert-btn').addEventListener('click', () => {
      let finalText = text;
      varsBox.querySelectorAll('input[data-var]').forEach(input => {
        const varName = input.dataset.var;
        const value = input.value || `{{${varName}}}`;
        finalText = finalText.replace(new RegExp(`\\{\\{\\s*${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g'), value);
      });
      finish(finalText);
    });

    const firstEmpty = varsBox.querySelector('input[data-var][value=""]') || varsBox.querySelector('input[data-var]');
    setTimeout(() => firstEmpty?.focus(), 30);
  }

  function finish(text) {
    const composer = findComposer();
    if (composer) {
      insertIntoComposer(composer, text);
      closePanel();
    } else {
      navigator.clipboard.writeText(text);
      showWidgetToast("Couldn't find the chat box — copied to clipboard instead");
      // Leave the panel open behind the toast briefly so the message is seen,
      // rather than closing immediately like the successful-insert path.
      setTimeout(closePanel, 1600);
    }
    if (activePrompt) PromptDB.recordUsage(activePrompt.id);
  }

  function openPanel() {
    panel.classList.add('pai-open');
    trigger.classList.add('pai-active');
    loadPrompts().then(() => renderList(''));
    setTimeout(() => searchInput.focus(), 50);
  }

  function closePanel() {
    panel.classList.remove('pai-open');
    trigger.classList.remove('pai-active');
    searchInput.value = '';
  }

  trigger.addEventListener('click', () => {
    panel.classList.contains('pai-open') ? closePanel() : openPanel();
  });

  // Global keyboard shortcut (Alt+Shift+P by default, user-remappable at
  // chrome://extensions/shortcuts) — relayed here from js/background.js
  // since chrome.commands only fires in the service worker, not content scripts.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'promptai-toggle-picker') {
      panel.classList.contains('pai-open') ? closePanel() : openPanel();
    }
  });

  searchInput.addEventListener('input', () => renderList(searchInput.value));

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); selectHighlighted(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePanel(); }
  });

  document.addEventListener('click', (e) => {
    if (!widget.contains(e.target) && panel.classList.contains('pai-open')) closePanel();
  });

  function escapeHtml(unsafe) {
    return (unsafe || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
})();
