/**
 * PromptDock — Chrome Extension Storage Layer
 * Uses chrome.storage.local as the data backend.
 * Each prompt: { id, title, content, tags[], folder, is_favorite, created_at, updated_at }
 */

const PromptDB = {
  STORAGE_KEY: 'promptai_prompts',
  SEEDED_KEY: 'promptai_seeded',

  /**
   * Seed storage with starter prompts (js/seed_data.js) if this is the first run.
   * Called once during initialization.
   */
  async seedIfEmpty() {
    return new Promise((resolve) => {
      chrome.storage.local.get([this.STORAGE_KEY, this.SEEDED_KEY], async (result) => {
        // If already seeded, skip
        if (result[this.SEEDED_KEY]) {
          resolve(false);
          return;
        }

        const existing = result[this.STORAGE_KEY] || [];
        // Only seed if there are no prompts yet
        if (existing.length === 0 && typeof SEED_PROMPTS !== 'undefined' && SEED_PROMPTS.length > 0) {
          const seeded = SEED_PROMPTS.map(item => ({
            id: this._generateId(),
            title: item.title,
            content: item.content,
            tags: item.tags || [],
            folder: item.folder || 'General',
            is_favorite: item.is_favorite || false,
            created_at: item.created_at || new Date().toISOString(),
            updated_at: item.updated_at || new Date().toISOString()
          }));

          chrome.storage.local.set({
            [this.STORAGE_KEY]: seeded,
            [this.SEEDED_KEY]: true
          }, () => {
            console.log(`[PromptDock] Seeded ${seeded.length} starter prompts.`);
            resolve(true);
          });
        } else {
          // Mark as seeded so we don't check again
          chrome.storage.local.set({ [this.SEEDED_KEY]: true }, () => resolve(false));
        }
      });
    });
  },

  /**
   * Generate a unique ID
   */
  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  },

  /**
   * Get all prompts, sorted by favorite first then newest first
   */
  async getAll() {
    return new Promise((resolve) => {
      chrome.storage.local.get(this.STORAGE_KEY, (result) => {
        const prompts = result[this.STORAGE_KEY] || [];
        prompts.sort((a, b) => {
          if (a.is_favorite !== b.is_favorite) return b.is_favorite ? 1 : -1;
          return new Date(b.created_at) - new Date(a.created_at);
        });
        resolve(prompts);
      });
    });
  },

  /**
   * Get prompts by folder
   */
  async getByFolder(folderName) {
    const all = await this.getAll();
    return all.filter(p => p.folder === folderName);
  },

  /**
   * Search prompts by query text across title, content, tags, folder
   */
  async search(query, folder = 'All') {
    let prompts = await this.getAll();
    if (folder !== 'All') {
      prompts = prompts.filter(p => p.folder === folder);
    }
    if (!query || !query.trim()) return prompts;

    const q = query.toLowerCase();
    return prompts.filter(p => {
      const text = `${p.title} ${p.content} ${(p.tags || []).join(' ')} ${p.folder}`.toLowerCase();
      return text.includes(q);
    });
  },

  /**
   * Create a new prompt
   */
  async create({ title, content, tags, folder }) {
    const prompts = await this._getRaw();
    const newPrompt = {
      id: this._generateId(),
      title: title || 'Untitled',
      content: content || '',
      tags: tags || [],
      folder: (folder || 'General').trim() || 'General',
      is_favorite: false,
      use_count: 0,
      last_used_at: null,
      history: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    prompts.push(newPrompt);
    await this._save(prompts);
    return newPrompt;
  },

  /**
   * Update an existing prompt. Pushes the pre-edit state onto history —
   * but only when title/content actually changed (moving a prompt between
   * folders shouldn't burn a full history entry), and stored as stripped
   * plain text rather than Quill's HTML (history is a recovery net, not a
   * primary editing surface — ~2x smaller, formatting isn't worth the bytes).
   * Capped at 5 entries — ponytail: bump the cap or move to IndexedDB if
   * users need deeper history than that.
   */
  async update(id, { title, content, tags, folder }) {
    const prompts = await this._getRaw();
    const idx = prompts.findIndex(p => p.id === id);
    if (idx === -1) return null;

    const prev = prompts[idx];
    const history = prev.history || [];
    const contentChanged = (title !== undefined && title !== prev.title) || (content !== undefined && content !== prev.content);
    if (contentChanged) {
      history.push({ title: prev.title, content: this._stripHtml(prev.content), tags: prev.tags, folder: prev.folder, updated_at: prev.updated_at, plain: true });
      if (history.length > 5) history.shift();
    }

    prompts[idx] = {
      ...prev,
      title: title !== undefined ? title : prev.title,
      content: content !== undefined ? content : prev.content,
      tags: tags !== undefined ? tags : prev.tags,
      folder: folder !== undefined ? (folder.trim() || 'General') : prev.folder,
      updated_at: new Date().toISOString(),
      history
    };

    await this._save(prompts);
    return prompts[idx];
  },

  /**
   * Restore a prior version of a prompt (index into its history array).
   * The current state is pushed onto history first, via update().
   */
  async restoreVersion(id, versionIndex) {
    const prompts = await this._getRaw();
    const prompt = prompts.find(p => p.id === id);
    const version = prompt && (prompt.history || [])[versionIndex];
    if (!version) return null;
    return this.update(id, { title: version.title, content: version.content, tags: version.tags, folder: version.folder });
  },

  /**
   * Strip HTML markup down to plain text (used for history snapshots).
   */
  _stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    return div.textContent || '';
  },

  /**
   * Bytes currently used in chrome.storage.local, for the usage indicator.
   * getBytesInUse() on the local storage area isn't supported on older
   * Firefox (only landed in storage.local as of Firefox 144) — returns
   * null when unavailable so the UI can hide the meter instead of erroring.
   */
  async getStorageUsage() {
    if (typeof chrome.storage.local.getBytesInUse !== 'function') return null;
    return new Promise((resolve) => {
      chrome.storage.local.getBytesInUse(null, (bytes) => resolve(bytes || 0));
    });
  },

  /**
   * Record that a prompt was actually used (copied or inserted), for
   * the Quick Access list. Distinct from updated_at, which tracks edits.
   */
  async recordUsage(id) {
    const prompts = await this._getRaw();
    const idx = prompts.findIndex(p => p.id === id);
    if (idx === -1) return;
    prompts[idx].use_count = (prompts[idx].use_count || 0) + 1;
    prompts[idx].last_used_at = new Date().toISOString();
    await this._save(prompts);
  },

  /**
   * Most-used prompts, for the Quick Access strip. Ranked by use count,
   * then by recency.
   */
  async getMostUsed(limit = 5) {
    const prompts = await this._getRaw();
    return prompts
      .filter(p => p.use_count > 0)
      .sort((a, b) => (b.use_count - a.use_count) || (new Date(b.last_used_at) - new Date(a.last_used_at)))
      .slice(0, limit);
  },

  /**
   * Toggle the favorite status of a prompt
   */
  async toggleFavorite(id) {
    const prompts = await this._getRaw();
    const idx = prompts.findIndex(p => p.id === id);
    if (idx === -1) return null;

    prompts[idx].is_favorite = !prompts[idx].is_favorite;
    prompts[idx].updated_at = new Date().toISOString();
    await this._save(prompts);
    return { is_favorite: prompts[idx].is_favorite };
  },

  /**
   * Delete a prompt by ID
   */
  async delete(id) {
    let prompts = await this._getRaw();
    prompts = prompts.filter(p => p.id !== id);
    await this._save(prompts);
    return true;
  },

  /**
   * Get distinct folder names
   */
  async getFolders() {
    const prompts = await this._getRaw();
    const folderSet = new Set(prompts.map(p => p.folder).filter(f => f && f.trim()));
    if (!folderSet.has('General')) folderSet.add('General');
    return [...folderSet].sort();
  },

  /**
   * Export all prompts as JSON string
   */
  async exportJSON() {
    const prompts = await this._getRaw();
    // Strip the internal id for cleaner export, keep everything else
    const exportData = prompts.map(({ id, ...rest }) => rest);
    return JSON.stringify(exportData, null, 2);
  },

  /**
   * Import prompts from a JSON array. Adds to existing data (doesn't replace).
   */
  async importJSON(jsonArray) {
    const prompts = await this._getRaw();
    let imported = 0;
    for (const item of jsonArray) {
      if (item.title && item.content) {
        prompts.push({
          id: this._generateId(),
          title: item.title,
          content: item.content,
          tags: item.tags || [],
          folder: item.folder || 'General',
          is_favorite: item.is_favorite || false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
        imported++;
      }
    }
    await this._save(prompts);
    return imported;
  },

  // ===== Internal helpers =====

  async _getRaw() {
    return new Promise((resolve) => {
      chrome.storage.local.get(this.STORAGE_KEY, (result) => {
        resolve(result[this.STORAGE_KEY] || []);
      });
    });
  },

  /**
   * Saves prompts to chrome.storage.local. If the write fails (quota
   * exceeded), the user's actual edit shouldn't be the casualty — old
   * history snapshots are the least-important bytes on disk, so trim every
   * prompt's history down to its 2 most recent versions and retry once
   * before surfacing a real error.
   */
  async _save(prompts) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [this.STORAGE_KEY]: prompts }, () => {
        if (!chrome.runtime.lastError) {
          resolve();
          return;
        }
        const trimmed = prompts.map(p => ({ ...p, history: (p.history || []).slice(-2) }));
        chrome.storage.local.set({ [this.STORAGE_KEY]: trimmed }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error('Storage is full. Delete some old prompts to free up space.'));
          } else {
            resolve();
          }
        });
      });
    });
  }
};
