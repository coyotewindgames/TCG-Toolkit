import { useEffect, useState, type JSX } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../hooks/useSession';
import { logout, getOnboardingStatus } from '../lib/api';

interface NavItem {
  to: string;
  label: string;
  icon: JSX.Element;
}

const NAV: NavItem[] = [
  {
    to: '/transactions',
    label: 'Transactions',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h16M4 12h16M4 17h10" />
        <path d="m17 14 3 3-3 3" />
      </svg>
    ),
  },
  {
    to: '/inventory',
    label: 'Inventory',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7h18M3 12h18M3 17h18" />
      </svg>
    ),
  },
  {
    to: '/analytics',
    label: 'Analytics',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" />
        <path d="M7 14l4-4 3 3 4-6" />
      </svg>
    ),
  },
  {
    to: '/settings/integrations',
    label: 'Settings',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    ),
  },
];

const STORAGE_KEY = 'tcg.sidebar.collapsed';
const CHECKLIST_DISMISSED_KEY = 'tcg.setup-checklist.dismissed';

export default function AppLayout() {
  const session = useSession();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [checklistDismissed, setChecklistDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(CHECKLIST_DISMISSED_KEY) === '1';
  });

  const isOwner = session.user?.role === 'owner';
  const onboardingStatus = useQuery({
    queryKey: ['onboarding-status'],
    queryFn: getOnboardingStatus,
    enabled: isOwner && !checklistDismissed,
    staleTime: 60_000,
  });
  const showChecklist =
    isOwner &&
    !checklistDismissed &&
    onboardingStatus.data?.completedAt == null;

  function dismissChecklist() {
    window.localStorage.setItem(CHECKLIST_DISMISSED_KEY, '1');
    setChecklistDismissed(true);
  }

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen flex bg-slate-950 text-slate-100">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-slate-950/70 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:static z-30 h-screen md:h-auto md:min-h-screen
                    bg-slate-900 border-r border-slate-800
                    flex flex-col
                    transition-[width,transform] duration-200 ease-out
                    ${collapsed ? 'md:w-16' : 'md:w-60'}
                    ${mobileOpen ? 'translate-x-0 w-60' : '-translate-x-full md:translate-x-0'}`}
      >
        <div className="h-14 px-3 flex items-center gap-2 border-b border-slate-800">
          <Link
            to="/"
            className={`flex items-center gap-2 font-bold text-base whitespace-nowrap overflow-hidden ${
              collapsed ? 'md:justify-center md:w-full' : ''
            }`}
            title="TCG Toolkit"
          >
            <span className="text-xl leading-none" aria-hidden>
              🃏
            </span>
            <span className={collapsed ? 'md:hidden' : ''}>TCG Toolkit</span>
          </Link>
        </div>

        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setMobileOpen(false)}
              title={collapsed ? item.label : undefined}
              className={({ isActive }: { isActive: boolean }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-emerald-500 text-slate-900 font-medium'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
                } ${collapsed ? 'md:justify-center md:px-2' : ''}`
              }
            >
              <span className="shrink-0">{item.icon}</span>
              <span className={collapsed ? 'md:hidden' : ''}>{item.label}</span>
            </NavLink>
          ))}

          {/* Getting Started checklist — owners only, until onboarding is done */}
          {showChecklist && !collapsed && (
            <div className="mt-4 mx-1 rounded-xl border border-slate-700 bg-slate-800/60 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                  Getting started
                </span>
                <button
                  type="button"
                  onClick={dismissChecklist}
                  className="text-slate-500 hover:text-slate-300 text-xs leading-none"
                  title="Dismiss"
                >
                  ✕
                </button>
              </div>
              <ul className="space-y-1.5 text-xs">
                <ChecklistItem done label="Shop created" />
                <ChecklistItem
                  done={onboardingStatus.data?.tcgapiConfigured ?? false}
                  label="Connect TCGapi.dev"
                  to="/settings/integrations"
                />
                <ChecklistItem
                  done={onboardingStatus.data?.inventoryImported ?? false}
                  label="Import inventory"
                  to="/inventory"
                />
                <ChecklistItem
                  done={onboardingStatus.data?.posConfigured ?? false}
                  label="Connect Clover"
                  to="/settings/integrations"
                  optional
                />
              </ul>
            </div>
          )}
        </nav>

        {session.user && (
          <div className={`border-t border-slate-800 px-3 py-2 ${collapsed ? 'md:px-2' : ''}`}>
            <div className={`text-xs text-slate-400 ${collapsed ? 'md:hidden' : ''}`}>
              <div className="truncate" title={session.user.email}>
                {session.user.displayName}
              </div>
              <button
                type="button"
                onClick={() => navigate('/locations/pick')}
                className="text-emerald-400 hover:underline truncate"
                title="Switch location"
              >
                Switch location
              </button>
            </div>
            <button
              type="button"
              onClick={onLogout}
              title="Sign out"
              className={`mt-2 w-full text-xs rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 py-1 ${
                collapsed ? 'md:px-1' : 'px-2'
              }`}
            >
              {collapsed ? '⎋' : 'Sign out'}
            </button>
            <div
              className={`mt-2 text-[10px] leading-tight text-slate-500 font-mono ${
                collapsed ? 'md:hidden' : ''
              }`}
              title={`Built ${__APP_BUILD_TIME__}`}
            >
              build {__APP_BUILD_ID__}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="hidden md:flex items-center justify-center h-10 border-t border-slate-800 text-slate-400 hover:text-slate-100 hover:bg-slate-800/60"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${collapsed ? 'rotate-180' : ''}`}
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="md:hidden h-14 px-3 flex items-center gap-3 border-b border-slate-800 bg-slate-900">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="p-2 rounded-lg hover:bg-slate-800"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <Link to="/" className="font-bold">
            🃏 TCG Toolkit
          </Link>
        </header>

        <main className="flex-1 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ChecklistItem({
  done,
  label,
  to,
  optional,
}: {
  done: boolean;
  label: string;
  to?: string;
  optional?: boolean;
}) {
  const inner = (
    <li className={`flex items-center gap-2 ${done ? 'text-slate-400 line-through' : 'text-slate-200'}`}>
      <span className={`text-[10px] font-bold ${done ? 'text-emerald-400' : 'text-slate-600'}`}>
        {done ? '✓' : '○'}
      </span>
      {label}
      {optional && <span className="text-slate-500 text-[10px]">(opt)</span>}
    </li>
  );
  if (!done && to) {
    return <Link to={to} className="hover:text-emerald-300">{inner}</Link>;
  }
  return inner;
}
