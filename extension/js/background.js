/**
 * PromptDock — Background Service Worker
 * chrome.commands (global keyboard shortcuts) only fires here, not in
 * content scripts, so this just relays the shortcut to the active tab.
 */

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-picker') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'promptai-toggle-picker' });
  });
});
