<script lang="ts">
  import { onMount } from 'svelte';
  
  interface Config {
    llm: {
      endpoint: string;
      model: string;
    };
    polling: {
      intervalMs: number;
    };
    notifications: {
      blocked: { sound: string | null };
      complete: { sound: string | null };
    };
    password?: string;
  }
  
  let config = $state<Config | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let message = $state('');
  let sounds = $state<string[]>([]);
  let newPassword = $state('');
  
  onMount(async () => {
    await loadConfig();
    await loadSounds();
  });
  
  async function loadConfig() {
    try {
      const response = await fetch('/api/config');
      if (response.ok) {
        config = await response.json();
      }
    } catch (e) {
      console.error('Load config error:', e);
    } finally {
      loading = false;
    }
  }
  
  async function loadSounds() {
    try {
      const response = await fetch('/api/sounds');
      if (response.ok) {
        sounds = await response.json();
      }
    } catch (e) {
      console.error('Load sounds error:', e);
    }
  }
  
  async function saveConfig() {
    if (!config) return;
    
    saving = true;
    message = '';
    
    try {
      const body: Record<string, unknown> = { ...config };
      if (newPassword) {
        body.password = newPassword;
      }
      
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      if (response.ok) {
        message = 'Settings saved!';
        newPassword = '';
      } else {
        message = 'Failed to save settings';
      }
    } catch (e) {
      message = 'Error saving settings';
    } finally {
      saving = false;
    }
  }
  
  async function uploadSound(event: Event, type: 'blocked' | 'complete') {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    
    if (!file || !config) return;
    
    const formData = new FormData();
    formData.append('sound', file);
    formData.append('type', type);
    
    try {
      const response = await fetch('/api/sounds', {
        method: 'POST',
        body: formData
      });
      
      if (response.ok) {
        const data = await response.json();
        config.notifications[type].sound = data.filename;
        await loadSounds();
        message = 'Sound uploaded!';
      }
    } catch (e) {
      message = 'Failed to upload sound';
    }
  }
  
  async function testSound(soundPath: string | null) {
    if (!soundPath) return;
    
    try {
      await fetch(`/api/sounds/${encodeURIComponent(soundPath)}/test`, { method: 'POST' });
    } catch (e) {
      console.error('Test sound error:', e);
    }
  }
</script>

<svelte:head>
  <title>Settings - AI Agent Dashboard</title>
</svelte:head>

<div class="settings-page">
  <header class="settings-header">
    <a href="/" class="back-link">← Back to Dashboard</a>
    <h1>Settings</h1>
  </header>
  
  {#if loading}
    <div class="loading">Loading...</div>
  {:else if config}
    <form class="settings-form" onsubmit={(e) => { e.preventDefault(); saveConfig(); }}>
      <section class="settings-section">
        <h2>LLM Configuration</h2>
        <div class="form-group">
          <label for="llm-endpoint">API Endpoint</label>
          <input 
            id="llm-endpoint" 
            type="url" 
            bind:value={config.llm.endpoint}
            placeholder="http://192.168.68.150:5010/v1"
          />
        </div>
        <div class="form-group">
          <label for="llm-model">Model</label>
          <input 
            id="llm-model" 
            type="text" 
            bind:value={config.llm.model}
            placeholder="glm-4-flash"
          />
        </div>
      </section>
      
      <section class="settings-section">
        <h2>Polling</h2>
        <div class="form-group">
          <label for="polling-interval">Interval (ms)</label>
          <input 
            id="polling-interval" 
            type="number" 
            bind:value={config.polling.intervalMs}
            min="100"
            max="10000"
          />
        </div>
      </section>
      
      <section class="settings-section">
        <h2>Notifications</h2>
        
        <h3>Blocked Status</h3>
        <div class="form-group">
          <label for="sound-blocked">Sound</label>
          <div class="sound-row">
            <select id="sound-blocked" bind:value={config.notifications.blocked.sound}>
              <option value={null}>None</option>
              {#each sounds as sound}
                <option value={sound}>{sound}</option>
              {/each}
            </select>
            {#if config.notifications.blocked.sound}
              <button type="button" class="btn-small" onclick={() => testSound(config!.notifications.blocked.sound)}>
                🔊
              </button>
            {/if}
          </div>
          <input 
            type="file" 
            accept=".wav,.mp3,.ogg"
            onchange={(e) => uploadSound(e, 'blocked')}
          />
        </div>
        
        <h3>Complete Status</h3>
        <div class="form-group">
          <label for="sound-complete">Sound</label>
          <div class="sound-row">
            <select id="sound-complete" bind:value={config.notifications.complete.sound}>
              <option value={null}>None</option>
              {#each sounds as sound}
                <option value={sound}>{sound}</option>
              {/each}
            </select>
            {#if config.notifications.complete.sound}
              <button type="button" class="btn-small" onclick={() => testSound(config!.notifications.complete.sound)}>
                🔊
              </button>
            {/if}
          </div>
          <input 
            type="file" 
            accept=".wav,.mp3,.ogg"
            onchange={(e) => uploadSound(e, 'complete')}
          />
        </div>
      </section>
      
      <section class="settings-section">
        <h2>Security</h2>
        <div class="form-group">
          <label for="password">New Password</label>
          <input 
            id="password" 
            type="password" 
            placeholder="Enter new password"
            bind:value={newPassword}
          />
          <span class="hint">Leave blank to keep current password</span>
        </div>
      </section>
      
      <div class="form-actions">
        <button type="submit" class="btn-primary" disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {#if message}
          <span class="message">{message}</span>
        {/if}
      </div>
    </form>
  {/if}
</div>

<style>
  .settings-page {
    padding: 1.5rem;
    max-width: 600px;
    margin: 0 auto;
  }
  
  .settings-header {
    margin-bottom: 2rem;
  }
  
  .back-link {
    font-size: 0.875rem;
    margin-bottom: 0.5rem;
    display: inline-block;
  }
  
  .settings-header h1 {
    font-size: 1.5rem;
    font-weight: 600;
  }
  
  .loading {
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
  }
  
  .settings-section {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: 1.25rem;
    margin-bottom: 1rem;
  }
  
  .settings-section h2 {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-color);
  }
  
  .settings-section h3 {
    font-size: 0.875rem;
    font-weight: 500;
    margin-top: 1rem;
    margin-bottom: 0.5rem;
    color: var(--text-secondary);
  }
  
  .form-group {
    margin-bottom: 1rem;
  }
  
  .form-group:last-child {
    margin-bottom: 0;
  }
  
  .form-group label {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    margin-bottom: 0.25rem;
    color: var(--text-secondary);
  }
  
  .form-group input,
  .form-group select {
    width: 100%;
    margin-bottom: 0.5rem;
  }
  
  .form-group input[type="file"] {
    font-size: 0.75rem;
    padding: 0.25rem;
  }
  
  .sound-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  
  .sound-row select {
    flex: 1;
    margin-bottom: 0;
  }
  
  .btn-small {
    padding: 0.5rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius);
  }
  
  .btn-small:hover {
    background: var(--bg-hover);
  }
  
  .hint {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  
  .form-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: 1rem;
  }
  
  .message {
    font-size: 0.875rem;
    color: var(--accent-green);
  }
</style>
