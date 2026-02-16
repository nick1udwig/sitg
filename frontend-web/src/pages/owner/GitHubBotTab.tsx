import type { FormEvent } from 'react';
import type { BotClient } from '../../types';

interface GitHubBotTabProps {
  botClients: BotClient[];
  selectedBotClientId: string;
  onSelectBotClient: (id: string) => void;
  newBotClientName: string;
  onNewBotClientNameChange: (value: string) => void;
  onCreateBotClient: (event: FormEvent<HTMLFormElement>) => void;
  onCreateBotKey: () => void;
  createdKeySecret: string | null;
  revokeKeyId: string;
  onRevokeKeyIdChange: (value: string) => void;
  onRevokeBotKey: (event: FormEvent<HTMLFormElement>) => void;
  bindingsInput: string;
  onBindingsInputChange: (value: string) => void;
  onSaveBindings: (event: FormEvent<HTMLFormElement>) => void;
  isBusy: (key: string) => boolean;
  isAuthed: boolean;
}

export function GitHubBotTab({
  botClients,
  selectedBotClientId,
  onSelectBotClient,
  newBotClientName,
  onNewBotClientNameChange,
  onCreateBotClient,
  onCreateBotKey,
  createdKeySecret,
  revokeKeyId,
  onRevokeKeyIdChange,
  onRevokeBotKey,
  bindingsInput,
  onBindingsInputChange,
  onSaveBindings,
  isBusy,
  isAuthed
}: GitHubBotTabProps) {
  const selectedBotClient = botClients.find((client) => client.id === selectedBotClientId) ?? null;

  return (
    <article className="card">
      <h3>Bot Clients</h3>
      <p className="meta">Create bot credentials and bind them to your GitHub App installation.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div className="section-label">Create Client</div>
          <form onSubmit={onCreateBotClient}>
            <label>
              Name
              <input
                value={newBotClientName}
                onChange={(event) => onNewBotClientNameChange(event.target.value)}
                placeholder="acme-prod-bot"
              />
            </label>
            <button type="submit" disabled={isBusy('bot-client-create') || !isAuthed}>
              {isBusy('bot-client-create') ? 'Creating...' : 'Create Bot Client'}
            </button>
          </form>

          <div className="section-label">Select Client</div>
          <label>
            Active client
            <select
              value={selectedBotClientId}
              onChange={(event) => onSelectBotClient(event.target.value)}
            >
              <option value="">Select client</option>
              {botClients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name} ({client.id})
                </option>
              ))}
            </select>
          </label>

          <dl className="kv">
            <dt>Selected bot</dt>
            <dd>{selectedBotClient ? selectedBotClient.name : <span style={{ color: 'var(--ink-soft)' }}>none</span>}</dd>
            <dt>Key count</dt>
            <dd>{selectedBotClient?.keys?.length ?? 0}</dd>
            <dt>Installations</dt>
            <dd>{selectedBotClient?.installation_ids?.join(', ') || <span style={{ color: 'var(--ink-soft)' }}>none</span>}</dd>
          </dl>
        </div>

        <div>
          <div className="section-label">Keys</div>
          <div className="row-wrap" style={{ marginBottom: 12 }}>
            <button onClick={onCreateBotKey} disabled={!selectedBotClientId || isBusy('bot-key-create')}>
              {isBusy('bot-key-create') ? 'Creating...' : 'Create Key'}
            </button>
          </div>

          {createdKeySecret ? (
            <div className="notice" aria-live="polite" style={{ marginBottom: 12 }}>
              <span className="meta" style={{ margin: 0 }}>Secret (shown once):</span>
              <code className="mono" style={{ display: 'block', marginTop: 4, wordBreak: 'break-all' }}>
                {createdKeySecret}
              </code>
            </div>
          ) : null}

          <form onSubmit={onRevokeBotKey}>
            <label>
              Revoke key ID
              <input value={revokeKeyId} onChange={(event) => onRevokeKeyIdChange(event.target.value)} placeholder="bck_live_abc123" />
            </label>
            <button type="submit" className="warn" disabled={!selectedBotClientId || isBusy('bot-key-revoke')}>
              {isBusy('bot-key-revoke') ? 'Revoking...' : 'Revoke Key'}
            </button>
          </form>

          <div className="section-label">Installation Bindings</div>
          <form onSubmit={onSaveBindings}>
            <label>
              Installation IDs (comma separated)
              <textarea
                value={bindingsInput}
                onChange={(event) => onBindingsInputChange(event.target.value)}
                placeholder="100, 101"
              />
            </label>
            <button type="submit" disabled={!selectedBotClientId || isBusy('bot-bindings-save')}>
              {isBusy('bot-bindings-save') ? 'Saving...' : 'Save Bindings'}
            </button>
          </form>
        </div>
      </div>
    </article>
  );
}
