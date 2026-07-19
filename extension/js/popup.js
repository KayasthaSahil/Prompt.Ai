/**
 * Prompt.AI — Chrome Extension Popup Controller
 * Handles all UI interactions, rendering, and feature logic.
 */

// ===== State =====
let currentFolder = 'All';
let quillEditor = null;
let currentTemplate = '';
let currentPromptId = null;
let isEditing = false;

// ===== DOM References =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', async () => {
    // Seed DB from MongoDB data on first run
    await PromptDB.seedIfEmpty();

    await renderFolders();
    await renderQuickAccess();
    await renderPrompts();
    await renderStorageUsage();
    bindEvents();
});

// ===== Storage Usage =====
async function renderStorageUsage() {
    const bytes = await PromptDB.getStorageUsage();
    const quota = chrome.storage.local.QUOTA_BYTES || (5 * 1024 * 1024);
    const pct = Math.min(100, (bytes / quota) * 100);

    const fill = $('#storageMeterFill');
    fill.style.width = `${pct}%`;
    fill.classList.toggle('warn', pct >= 70 && pct < 90);
    fill.classList.toggle('critical', pct >= 90);

    const mb = (bytes / (1024 * 1024)).toFixed(2);
    const quotaMb = (quota / (1024 * 1024)).toFixed(0);
    $('#storageMeterLabel').textContent = `${mb} MB / ${quotaMb} MB used`;
}

// ===== Event Binding =====
function bindEvents() {
    // New Prompt
    $('#newPromptBtn').addEventListener('click', openCreateModal);

    // Form submit
    $('#promptForm').addEventListener('submit', handleFormSubmit);

    // Cancel buttons
    $('#cancelModalBtn').addEventListener('click', () => closeModal('createModal'));
    $('#cancelMagicBtn').addEventListener('click', () => closeModal('injectionModal'));

    // Prevent search form submission (no page reload in extension)
    $('#searchForm').addEventListener('submit', (e) => e.preventDefault());

    // Search
    let searchTimeout;
    $('#searchInput').addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => performSearch(e.target.value), 250);
    });

    // Keyboard shortcut: Ctrl+K to focus search
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            $('#searchInput').focus();
        }
        if (e.key === 'Escape') {
            const activeModal = document.querySelector('.modal-overlay.active');
            if (activeModal) closeModal(activeModal.id);
        }
    });

    // Modal click-outside
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            closeModal(e.target.id);
        }
    });

    // Sidebar toggle
    $('#sidebarToggle').addEventListener('click', () => {
        $('#sidebar').classList.add('collapsed');
    });

    $('#sidebarOpen').addEventListener('click', () => {
        $('#sidebar').classList.remove('collapsed');
    });

    // Brand link -> show all
    $('#brandLink').addEventListener('click', (e) => {
        e.preventDefault();
        currentFolder = 'All';
        renderFolders();
        renderPrompts();
    });

    // Export
    $('#exportBtn').addEventListener('click', async (e) => {
        e.preventDefault();
        const json = await PromptDB.exportJSON();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'prompts_backup.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast('Exported successfully!', 'success');
    });

    // Import
    $('#importBtn').addEventListener('click', (e) => {
        e.preventDefault();
        $('#importFile').click();
    });

    $('#importFile').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!Array.isArray(data)) throw new Error('JSON must be an array');
            const count = await PromptDB.importJSON(data);
            showToast(`Imported ${count} prompt(s)!`, 'success');
            await renderFolders();
            await renderPrompts();
            await renderStorageUsage();
        } catch (err) {
            showToast(`Import failed: ${err.message}`, 'error');
        }
        e.target.value = '';
    });

    // Finalize copy
    $('#finalizeCopyBtn').addEventListener('click', finalizeCopy);

    // Version history
    $('#historyBtn').addEventListener('click', openHistoryModal);
    $('#cancelHistoryBtn').addEventListener('click', () => closeModal('historyModal'));

    // Confirm dialog
    $('#confirmCancelBtn').addEventListener('click', () => closeModal('confirmModal'));
}

// ===== Confirm Dialog =====
let pendingConfirmAction = null;

function confirmAction(title, message, onConfirm) {
    $('#confirmTitle').textContent = title;
    $('#confirmMessage').textContent = message;
    pendingConfirmAction = onConfirm;
    openModal('confirmModal');

    const okBtn = $('#confirmOkBtn');
    okBtn.onclick = () => {
        closeModal('confirmModal');
        if (pendingConfirmAction) pendingConfirmAction();
        pendingConfirmAction = null;
    };
}

// ===== Quick Access =====
async function renderQuickAccess() {
    const mostUsed = await PromptDB.getMostUsed(5);
    const section = $('#quickAccess');
    const list = $('#quickAccessList');

    if (mostUsed.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    list.innerHTML = mostUsed.map(p =>
        `<button class="quick-access-item" data-id="${p.id}">${escapeHtml(p.title)}</button>`
    ).join('');

    list.querySelectorAll('.quick-access-item').forEach(btn => {
        btn.addEventListener('click', async () => {
            const allPrompts = await PromptDB.getAll();
            const prompt = allPrompts.find(p => p.id === btn.dataset.id);
            if (prompt) initiateCopy(prompt.id, prompt.content, btn);
        });
    });
}

// ===== Version History =====
function openHistoryModal() {
    if (!currentPromptId) return;
    renderHistoryList();
    openModal('historyModal');
}

async function renderHistoryList() {
    const allPrompts = await PromptDB.getAll();
    const prompt = allPrompts.find(p => p.id === currentPromptId);
    const container = $('#historyList');
    const history = (prompt && prompt.history) || [];

    if (history.length === 0) {
        container.innerHTML = '<div class="history-empty">No earlier versions yet. Edits create a version here.</div>';
        return;
    }

    container.innerHTML = history.slice().reverse().map((v, i) => {
        const versionIndex = history.length - 1 - i; // index into the original (non-reversed) array
        return `
      <div class="history-item">
        <div class="history-meta">
          <span class="history-title">${escapeHtml(v.title)}</span>
          <span class="history-date">${new Date(v.updated_at).toLocaleString()}</span>
        </div>
        <div class="history-preview">${v.plain ? escapeHtml(v.content) : v.content}</div>
        ${v.plain ? '<div style="color: var(--text-tertiary); font-size: 0.68rem; margin-bottom: 0.5rem;">Formatting not preserved in history</div>' : ''}
        <button type="button" class="btn-copy btn-secondary restore-version-btn" data-index="${versionIndex}">Restore this version</button>
      </div>`;
    }).join('');

    container.querySelectorAll('.restore-version-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            await PromptDB.restoreVersion(currentPromptId, parseInt(btn.dataset.index, 10));
            showToast('Version restored', 'success');
            closeModal('historyModal');
            closeModal('createModal');
            await renderFolders();
            await renderPrompts();
            await renderStorageUsage();
        });
    });
}

// ===== Folder Rendering =====
async function renderFolders() {
    const folders = await PromptDB.getFolders();
    const folderList = $('#folderList');

    const folderIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;

    let html = `<li><a href="#" data-folder="All" class="${currentFolder === 'All' ? 'active' : ''}">${folderIcon} All Prompts</a></li>`;

    folders.forEach(f => {
        html += `<li><a href="#" data-folder="${escapeHtml(f)}" class="${currentFolder === f ? 'active' : ''}">${folderIcon} ${escapeHtml(f)}</a></li>`;
    });

    folderList.innerHTML = html;

    // Bind folder clicks
    folderList.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            currentFolder = link.dataset.folder;
            $('#pageTitle').textContent = currentFolder === 'All' ? 'All Prompts' : currentFolder;
            renderFolders();
            renderPrompts();
        });
    });

    // Update folder dropdowns in modals
    updateFolderDropdown();
}

function updateFolderDropdown() {
    PromptDB.getFolders().then(folders => {
        const select = $('#promptFolder');
        const currentValue = select.value;

        let html = `<option value="General">General</option>`;
        folders.forEach(f => {
            if (f !== 'General') {
                html += `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`;
            }
        });
        html += `<option value="__new__">+ Create New Folder</option>`;
        select.innerHTML = html;

        // Restore value if it still exists
        if (currentValue && currentValue !== '__new__') {
            select.value = currentValue;
        }

        // Handle "create new folder"
        select.onchange = () => {
            if (select.value === '__new__') {
                select.style.display = 'none';
                $('#newFolderInput').style.display = 'block';
                $('#newFolderInput').focus();
            }
        };
    });
}

// ===== Prompt Grid Rendering =====
async function renderPrompts() {
    let prompts;
    if (currentFolder === 'All') {
        prompts = await PromptDB.getAll();
    } else {
        prompts = await PromptDB.getByFolder(currentFolder);
    }
    renderGrid(prompts);
}

function renderGrid(prompts) {
    const grid = $('#promptsGrid');

    if (!prompts || prompts.length === 0) {
        grid.innerHTML = `
      <div class="empty-state">
        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
          <path d="M8 7h8" />
          <path d="M8 11h8" />
        </svg>
        <p>No prompts found. Create one with variables like <code>{{VariableName}}</code>!</p>
      </div>`;
        return;
    }

    const starFilled = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    const starEmpty = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    const editIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
    const deleteIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
    const sparkleIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>`;
    const clipIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`;
    const folderMiniIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;

    grid.innerHTML = prompts.map((p, index) => {
        const tagColors = ['1', '2', '3', '4', '5'];
        const tagsHtml = (p.tags || []).map((t, i) =>
            `<span class="tag tag-${tagColors[i % 5]} tag-clickable" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`
        ).join('');

        return `
      <div class="glass-panel prompt-card" id="prompt-${p.id}" style="animation-delay: ${index * 0.04}s;">
        <div class="card-header">
          <div class="card-title">${escapeHtml(p.title)}</div>
          <div class="card-actions">
            <button class="icon-btn favorite-btn" data-id="${p.id}" title="Favorite">
              ${p.is_favorite ? starFilled : starEmpty}
            </button>
            <button class="icon-btn edit-btn" data-id="${p.id}" title="Edit">${editIcon}</button>
            <button class="icon-btn delete-btn" data-id="${p.id}" title="Delete">${deleteIcon}</button>
          </div>
        </div>
        <div class="card-preview">${p.content}</div>
        <div class="tags">
          ${tagsHtml}
          <span class="tag tag-folder">${folderMiniIcon} ${escapeHtml(p.folder)}</span>
        </div>
        <div class="card-buttons">
          <button class="btn-copy magic-copy-btn" data-id="${p.id}" title="Magic Copy">
            ${sparkleIcon} Magic Copy
          </button>
          <button class="btn-copy btn-secondary raw-copy-btn" data-id="${p.id}" title="Raw Copy">
            ${clipIcon} Copy
          </button>
        </div>
      </div>`;
    }).join('');

    // Bind card button events
    bindCardEvents();
}

// ===== Card Event Binding =====
function bindCardEvents() {
    // Favorite
    $$('.favorite-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const result = await PromptDB.toggleFavorite(id);
            if (result) {
                showToast(result.is_favorite ? 'Added to favorites' : 'Removed from favorites', 'info');
                await renderPrompts();
            }
        });
    });

    // Edit
    $$('.edit-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const allPrompts = await PromptDB.getAll();
            const prompt = allPrompts.find(p => p.id === id);
            if (prompt) openEditModal(prompt);
        });
    });

    // Delete
    $$('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            confirmAction('Delete this prompt?', 'This can\'t be undone.', async () => {
                await PromptDB.delete(id);
                showToast('Prompt deleted', 'info');
                await renderFolders();
                await renderQuickAccess();
                await renderPrompts();
                await renderStorageUsage();
            });
        });
    });

    // Magic Copy
    $$('.magic-copy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const allPrompts = await PromptDB.getAll();
            const prompt = allPrompts.find(p => p.id === id);
            if (prompt) initiateCopy(prompt.id, prompt.content, btn);
        });
    });

    // Raw Copy
    $$('.raw-copy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const allPrompts = await PromptDB.getAll();
            const prompt = allPrompts.find(p => p.id === id);
            if (prompt) rawCopy(prompt.id, prompt.content, btn);
        });
    });

    // Tag click -> filter search by that tag
    $$('.tag-clickable').forEach(tag => {
        tag.addEventListener('click', () => {
            $('#searchInput').value = tag.dataset.tag;
            performSearch(tag.dataset.tag);
        });
    });
}

function flashCopied(btn) {
    if (!btn) return;
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 900);
}

// ===== Search =====
async function performSearch(query) {
    const results = await PromptDB.search(query, currentFolder);
    renderGrid(results);
}

// ===== Modal Management =====
function openCreateModal() {
    isEditing = false;
    currentPromptId = null;
    $('#historyBtn').style.display = 'none';
    $('#modalTitle').textContent = 'New Prompt';
    $('#modalSubtitle').innerHTML = 'Create a new prompt template. Use <code>{{ VariableName }}</code> syntax to add variables.';
    $('#savePromptBtn').textContent = 'Save Prompt';
    $('#editPromptId').value = '';
    $('#promptTitle').value = '';
    $('#promptTags').value = '';

    // Reset folder dropdown
    const select = $('#promptFolder');
    select.style.display = 'block';
    $('#newFolderInput').style.display = 'none';
    $('#newFolderInput').value = '';

    if (currentFolder !== 'All') {
        select.value = currentFolder;
    } else {
        select.value = 'General';
    }

    initQuillEditor('');
    openModal('createModal');
    setTimeout(() => $('#promptTitle').focus(), 100);
}

function openEditModal(prompt) {
    isEditing = true;
    currentPromptId = prompt.id;
    $('#historyBtn').style.display = 'inline-block';
    $('#modalTitle').textContent = 'Edit Prompt';
    $('#modalSubtitle').innerHTML = 'Update your prompt details below.';
    $('#savePromptBtn').textContent = 'Update Prompt';
    $('#editPromptId').value = prompt.id;
    $('#promptTitle').value = prompt.title;
    $('#promptTags').value = (prompt.tags || []).join(', ');

    // Set folder
    const select = $('#promptFolder');
    select.style.display = 'block';
    $('#newFolderInput').style.display = 'none';
    $('#newFolderInput').value = '';

    // Check if the folder exists in the dropdown
    const options = [...select.options].map(o => o.value);
    if (options.includes(prompt.folder)) {
        select.value = prompt.folder;
    } else {
        // Folder not in list — trigger "create new" mode
        select.value = '__new__';
        select.style.display = 'none';
        $('#newFolderInput').style.display = 'block';
        $('#newFolderInput').value = prompt.folder;
    }

    initQuillEditor(prompt.content);
    openModal('createModal');
}

function initQuillEditor(content) {
    const container = $('#editor-container');
    container.innerHTML = '';
    quillEditor = new Quill(container, {
        theme: 'snow',
        placeholder: 'Write your prompt here. Use {{VariableName}} for dynamic placeholders...',
        modules: {
            toolbar: [['bold', 'italic', 'code-block'], [{ 'list': 'ordered' }, { 'list': 'bullet' }]]
        }
    });
    if (content) {
        quillEditor.clipboard.dangerouslyPasteHTML(0, content);
    }
}

function openModal(id) {
    $(`#${id}`).classList.add('active');
}

function closeModal(id) {
    const modal = $(`#${id}`);
    if (!modal) return;
    modal.classList.remove('active');
    modal.classList.add('closing');
    setTimeout(() => modal.classList.remove('closing'), 250);
}

// ===== Form Submit =====
async function handleFormSubmit(e) {
    e.preventDefault();

    const title = $('#promptTitle').value.trim();
    const content = quillEditor ? quillEditor.root.innerHTML : '';
    const tagsRaw = $('#promptTags').value;
    const tags = tagsRaw.split(',').map(t => t.trim()).filter(t => t);

    // Determine folder
    let folder;
    const select = $('#promptFolder');
    const newFolderInput = $('#newFolderInput');
    if (newFolderInput.style.display !== 'none' && newFolderInput.value.trim()) {
        folder = newFolderInput.value.trim();
    } else {
        folder = select.value;
    }

    if (!title) {
        showToast('Title is required', 'error');
        return;
    }

    const editId = $('#editPromptId').value;

    try {
        if (isEditing && editId) {
            await PromptDB.update(editId, { title, content, tags, folder });
            showToast('Prompt updated successfully!', 'success');
        } else {
            await PromptDB.create({ title, content, tags, folder });
            showToast('Prompt created successfully!', 'success');
        }
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }

    closeModal('createModal');
    await renderFolders();
    await renderPrompts();
    await renderStorageUsage();
}

// ===== Magic Copy =====
let copyPromptId = null;

function extractTextFromHTML(html) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    return tempDiv.innerText;
}

function initiateCopy(id, htmlContent, btn) {
    copyPromptId = id;
    currentTemplate = extractTextFromHTML(htmlContent);
    const regex = /\{\{\s*([a-zA-Z0-9_\s-]+)\s*\}\}/g;
    const matches = [...currentTemplate.matchAll(regex)];

    if (matches.length === 0) {
        copyToClipboard(currentTemplate);
        recordCopyUsage();
        flashCopied(btn);
        return;
    }

    const container = $('#variablesContainer');
    container.innerHTML = '';
    const uniqueVars = [...new Set(matches.map(m => m[1].trim()))];

    uniqueVars.forEach(variable => {
        const wrapper = document.createElement('div');

        const label = document.createElement('label');
        label.className = 'variable-label';
        label.textContent = variable.replace(/_/g, ' ');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'form-input variable-input';
        input.dataset.varName = variable;
        input.placeholder = `Enter ${variable.replace(/_/g, ' ')}...`;
        input.addEventListener('input', () => {
            checkVariablesFilled();
            updatePreview();
        });

        wrapper.appendChild(label);
        wrapper.appendChild(input);
        container.appendChild(wrapper);
    });

    // Show live preview
    $('#livePreviewSection').style.display = 'block';
    updatePreview();

    openModal('injectionModal');
    checkVariablesFilled();
    setTimeout(() => container.querySelector('input')?.focus(), 100);
}

function checkVariablesFilled() {
    const inputs = $$('.variable-input');
    const copyBtn = $('#finalizeCopyBtn');
    let allFilled = true;

    inputs.forEach(input => {
        if (!input.value.trim()) allFilled = false;
    });

    copyBtn.style.display = allFilled ? 'inline-flex' : 'none';
}

function updatePreview() {
    let preview = currentTemplate;
    $$('.variable-input').forEach(input => {
        const varName = input.dataset.varName;
        const value = input.value || `{{${varName}}}`;
        const regex = new RegExp(`\\{\\{\\s*${escapeRegex(varName)}\\s*\\}\\}`, 'g');
        preview = preview.replace(regex, value);
    });
    $('#previewBox').textContent = preview;
}

function finalizeCopy() {
    let finalText = currentTemplate;
    $$('.variable-input').forEach(input => {
        const varName = input.dataset.varName;
        const value = input.value || `{{${varName}}}`;
        const regex = new RegExp(`\\{\\{\\s*${escapeRegex(varName)}\\s*\\}\\}`, 'g');
        finalText = finalText.replace(regex, value);
    });
    copyToClipboard(finalText);
    recordCopyUsage();
    flashCopied($('#finalizeCopyBtn'));
    setTimeout(() => closeModal('injectionModal'), 350);
}

function recordCopyUsage() {
    if (!copyPromptId) return;
    PromptDB.recordUsage(copyPromptId).then(renderQuickAccess);
}

function rawCopy(id, htmlContent, btn) {
    copyToClipboard(extractTextFromHTML(htmlContent));
    copyPromptId = id;
    recordCopyUsage();
    flashCopied(btn);
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast('Prompt copied to clipboard!', 'success');
    } catch (err) {
        // Fallback for extension context
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('Prompt copied to clipboard!', 'success');
    }
}

// ===== Toast Notifications =====
function showToast(message, type = 'success') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    // Icon per type
    const icons = {
        success: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        error: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
        info: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c6cff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`
    };

    toast.innerHTML = `${icons[type] || icons.info} ${escapeHtml(message)}`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('hide');
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// ===== Utility Functions =====
function escapeHtml(unsafe) {
    return (unsafe || '').toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
