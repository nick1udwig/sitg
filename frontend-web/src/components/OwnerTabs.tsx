export type OwnerTabId = 'repo-info' | 'threshold-whitelist';

interface OwnerTabsProps {
  active: OwnerTabId;
  onSelect: (tab: OwnerTabId) => void;
}

const TABS: { id: OwnerTabId; label: string }[] = [
  { id: 'repo-info', label: 'Repo Info' },
  { id: 'threshold-whitelist', label: 'Threshold & Whitelist' }
];

export function OwnerTabs({ active, onSelect }: OwnerTabsProps) {
  return (
    <nav className="owner-tabs" aria-label="Owner tabs">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`owner-tab${active === tab.id ? ' active' : ''}`}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
