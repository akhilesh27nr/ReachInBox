import React, { useState, useRef, useEffect } from 'react';
import {
  Sun,
  Moon,
  ChevronDown,
  Radio,
  LogOut,
  Check,
  Activity,
  UserPlus
} from 'lucide-react';

export interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarUrl: string;
}

interface Props {
  user: WorkspaceUser | null;
  theme: 'dark' | 'light';
  slackConnected?: boolean;
  slackChannelName?: string;
  onToggleTheme: (newTheme: 'dark' | 'light') => void;
  onOpenSlackModal: () => void;
  onOpenTimelineModal: () => void;
  onSignOut: () => void;
  onOpenCreateAccount?: () => void;
}

export const UserProfileMenu: React.FC<Props> = ({
  user,
  theme,
  slackConnected = false,
  slackChannelName = '',
  onToggleTheme,
  onOpenSlackModal,
  onOpenTimelineModal,
  onSignOut,
  onOpenCreateAccount,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const displayName = user?.name || 'Not Signed In';
  const displayEmail = user?.email || 'Sign in required';
  const displayRole = user?.role || 'Unauthenticated';
  const displayAvatar =
    user?.avatarUrl ||
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80';

  return (
    <div className="relative" ref={menuRef}>
      {/* Profile Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label={`User profile menu for ${displayName}`}
        className={`flex items-center gap-2.5 pl-2 py-1 pr-2 rounded-xl transition-all border ${
          isOpen
            ? 'bg-slate-800/80 border-indigo-500/50 shadow-sm'
            : 'border-transparent hover:bg-slate-800/50'
        }`}
        title="Open user profile and appearance menu"
      >
        <div className="relative flex-shrink-0">
          <img
            src={displayAvatar}
            alt={displayName}
            className="w-8 h-8 min-w-8 rounded-full ring-2 ring-indigo-500/40 object-cover flex-shrink-0"
          />
          <span
            className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ring-2 ring-[#0e121d] ${
              user ? 'bg-emerald-500' : 'bg-amber-500'
            }`}
          />
        </div>
        <div className="hidden sm:block text-left text-xs leading-tight">
          <div className="font-semibold text-slate-200">{displayName}</div>
          <div className="text-slate-400 text-[11px]">{displayEmail}</div>
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 flex-shrink-0 transition-transform duration-200 ${
            isOpen ? 'rotate-180 text-indigo-400' : ''
          }`}
        />
      </button>

      {/* Profile Dropdown Menu */}
      {isOpen && (
        <div
          role="menu"
          aria-label="User Profile Dropdown"
          className="absolute right-0 top-full mt-2 w-80 bg-[#121624] border border-slate-800 rounded-2xl shadow-2xl p-4 space-y-4 z-50 backdrop-blur-xl animate-in fade-in slide-in-from-top-1"
        >
          {/* User Details Banner */}
          <div className="flex items-center gap-3 pb-3 border-b border-slate-800/80">
            <img
              src={displayAvatar}
              alt={displayName}
              className="w-10 h-10 rounded-full ring-2 ring-indigo-500/40 object-cover"
            />
            <div className="flex-1 min-w-0">
              <div className="font-bold text-slate-100 text-sm truncate">{displayName}</div>
              <div className="text-slate-400 text-xs truncate">{displayEmail}</div>
              <span className="inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-950/80 text-indigo-300 border border-indigo-500/30">
                {displayRole}
              </span>
            </div>
          </div>

          {/* Theme & Accessibility Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                {theme === 'dark' ? (
                  <Moon className="w-3.5 h-3.5 text-indigo-400" />
                ) : (
                  <Sun className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span>Theme & Accessibility</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                {theme === 'dark' ? 'Dark Mode' : 'High Contrast'}
              </span>
            </div>

            {/* Segmented Theme Controls */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-[#0b0e17] rounded-xl border border-slate-800/80">
              <button
                type="button"
                onClick={() => onToggleTheme('dark')}
                className={`flex items-center gap-2 p-2 rounded-lg text-xs font-medium transition-all ${
                  theme === 'dark'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Moon className="w-4 h-4 flex-shrink-0" />
                <div className="text-left leading-tight">
                  <div className="font-semibold">Dark Mode</div>
                  <div className="text-[10px] opacity-80">Default Theme</div>
                </div>
                {theme === 'dark' && <Check className="w-3.5 h-3.5 ml-auto flex-shrink-0" />}
              </button>

              <button
                type="button"
                onClick={() => onToggleTheme('light')}
                className={`flex items-center gap-2 p-2 rounded-lg text-xs font-medium transition-all ${
                  theme === 'light'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Sun className="w-4 h-4 flex-shrink-0" />
                <div className="text-left leading-tight">
                  <div className="font-semibold">Light Mode</div>
                  <div className="text-[10px] opacity-80">High Contrast</div>
                </div>
                {theme === 'light' && <Check className="w-3.5 h-3.5 ml-auto flex-shrink-0" />}
              </button>
            </div>

            <p className="text-[11px] text-slate-400 leading-normal pt-0.5">
              High-contrast light mode optimizes typography and border contrast for accessibility and brightly lit environments.
            </p>
          </div>

          {/* Quick Shortcuts & Integrations */}
          <div className="space-y-1.5 pt-2 border-t border-slate-800/80 text-xs">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onOpenSlackModal();
              }}
              className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-slate-800/50 text-slate-300 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Radio className="w-3.5 h-3.5 text-indigo-400" />
                <span>Slack Alert Integration</span>
              </div>
              <span
                className={`text-[10px] font-mono ${
                  slackConnected ? 'text-emerald-400' : 'text-slate-400'
                }`}
              >
                {slackConnected ? slackChannelName || '#rate-limits' : 'Disconnected'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onOpenTimelineModal();
              }}
              className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-slate-800/50 text-slate-300 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-teal-400" />
                <span>Hourly Distribution</span>
              </div>
              <span className="text-[10px] text-slate-400 font-mono">6h Window</span>
            </button>

            {onOpenCreateAccount && (
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  onOpenCreateAccount();
                }}
                className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-slate-800/50 text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <UserPlus className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Switch / Add Account</span>
                </div>
                <span className="text-[10px] text-indigo-400 font-mono">+ New</span>
              </button>
            )}
          </div>

          {/* Sign Out / Reset Footer */}
          <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
            <span className="text-slate-500 text-[11px]">v2.4.0 • BullMQ Cluster</span>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onSignOut();
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-rose-950/60 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-500/30 transition-all text-xs font-semibold cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
