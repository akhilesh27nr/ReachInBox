import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  MoreHorizontal,
  Server,
  RefreshCw,
  Download,
  ExternalLink,
  Eye,
  RotateCcw,
  Plus,
  CheckCircle2,
  Mail,
  X,
  ShieldCheck,
  Activity
} from 'lucide-react';

export interface SenderItem {
  id: string;
  email: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  isActive: number;
}

interface Props {
  onRunReconcile: () => Promise<void>;
  onExportCsv: () => void;
  onOpenTemplatePreview: () => void;
  onOpenTimelineModal: () => void;
  onResetComposeDefaults: () => void;
  onNotify: (msg: string) => void;
  safeFetchJson: (url: string) => Promise<any>;
}

export const SystemActionsMenu: React.FC<Props> = ({
  onRunReconcile,
  onExportCsv,
  onOpenTemplatePreview,
  onOpenTimelineModal,
  onResetComposeDefaults,
  onNotify,
  safeFetchJson,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showSendersModal, setShowSendersModal] = useState(false);
  const [senders, setSenders] = useState<SenderItem[]>([]);
  const [isProvisioningSender, setIsProvisioningSender] = useState(false);
  const [newSenderName, setNewSenderName] = useState('');
  const [isReconciling, setIsReconciling] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setShowSendersModal(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const fetchSenders = async () => {
    try {
      const data = await safeFetchJson('/api/senders');
      if (Array.isArray(data)) {
        setSenders(data);
      }
    } catch {}
  };

  const handleOpenSendersModal = () => {
    setIsOpen(false);
    fetchSenders();
    setShowSendersModal(true);
  };

  const handleProvisionSender = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProvisioningSender(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      try {
        const tok = localStorage.getItem('reachinbox_session_token');
        if (tok) headers['Authorization'] = `Bearer ${tok}`;
      } catch {}
      const res = await fetch('/api/senders', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          displayName: newSenderName.trim() || `Outreach Node #${senders.length + 1}`,
        }),
      });
      if (res.ok) {
        const created = await res.json();
        setSenders((prev) => [...prev, created]);
        setNewSenderName('');
        onNotify(`Provisioned new Ethereal SMTP sender: ${created.email}`);
      } else {
        onNotify('Could not provision new sender');
      }
    } catch {
      onNotify('Network error provisioning sender');
    } finally {
      setIsProvisioningSender(false);
    }
  };

  return (
    <>
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-expanded={isOpen}
          aria-haspopup="true"
          aria-label="More system actions"
          title="System Actions & Cluster Controls"
          className={`p-2 rounded-lg border transition-all ${
            isOpen
              ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm'
              : 'bg-slate-800/60 border-slate-700/50 text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>

        {isOpen && (
          <div
            role="menu"
            aria-label="System Actions Menu"
            className="absolute right-0 top-full mt-2 w-72 bg-[#121624] border border-slate-800 rounded-xl shadow-2xl p-2 z-50 space-y-1 animate-in fade-in slide-in-from-top-1"
          >
            <div className="px-3 py-2 border-b border-slate-800/80 flex items-center justify-between">
              <span className="text-xs font-bold text-white">Cluster & System Actions</span>
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                Online
              </span>
            </div>

            <button
              type="button"
              role="menuitem"
              onClick={handleOpenSendersModal}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-200 hover:bg-slate-800/60 transition-colors text-left"
            >
              <div className="flex items-center gap-2.5">
                <Server className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                <div>
                  <div className="font-semibold">Manage SMTP Sender Cluster</div>
                  <div className="text-[10px] text-slate-400">View or add Ethereal accounts</div>
                </div>
              </div>
            </button>

            <button
              type="button"
              role="menuitem"
              disabled={isReconciling}
              onClick={async () => {
                setIsReconciling(true);
                await onRunReconcile();
                setIsReconciling(false);
                setIsOpen(false);
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-200 hover:bg-slate-800/60 transition-colors text-left"
            >
              <div className="flex items-center gap-2.5">
                <RefreshCw className={`w-3.5 h-3.5 text-emerald-400 flex-shrink-0 ${isReconciling ? 'animate-spin' : ''}`} />
                <div>
                  <div className="font-semibold">Run Queue Reconciliation</div>
                  <div className="text-[10px] text-slate-400">Reclaim stale locks & verify jobs</div>
                </div>
              </div>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                onExportCsv();
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-200 hover:bg-slate-800/60 transition-colors text-left"
            >
              <div className="flex items-center gap-2.5">
                <Download className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                <div>
                  <div className="font-semibold">Export Emails to CSV</div>
                  <div className="text-[10px] text-slate-400">Download current table records</div>
                </div>
              </div>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                onOpenTemplatePreview();
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-200 hover:bg-slate-800/60 transition-colors text-left"
            >
              <div className="flex items-center gap-2.5">
                <Eye className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                <div>
                  <div className="font-semibold">Preview Email Template</div>
                  <div className="text-[10px] text-slate-400">Test dynamic variable tags</div>
                </div>
              </div>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                onOpenTimelineModal();
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-200 hover:bg-slate-800/60 transition-colors text-left"
            >
              <div className="flex items-center gap-2.5">
                <Activity className="w-3.5 h-3.5 text-teal-400 flex-shrink-0" />
                <div>
                  <div className="font-semibold">View Send Timeline</div>
                  <div className="text-[10px] text-slate-400">Inspect 6-hour rate-limit windows</div>
                </div>
              </div>
            </button>

            <div className="border-t border-slate-800/80 pt-1 mt-1 flex items-center justify-between gap-1">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsOpen(false);
                  onResetComposeDefaults();
                }}
                className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800/60 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                <span>Reset Defaults</span>
              </button>

              <a
                href="/admin/queues"
                target="_blank"
                rel="noreferrer"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-indigo-400 hover:bg-slate-800/60 font-medium transition-colors"
              >
                <span>Bull Board</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        )}
      </div>

      {/* SMTP Sender Cluster Modal rendered via Portal outside header */}
      {showSendersModal &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="SMTP Sender Cluster"
            onClick={() => setShowSendersModal(false)}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-[#121624] border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 text-indigo-400 flex items-center justify-center">
                    <Server className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white">SMTP Sender Cluster</h3>
                    <p className="text-xs text-slate-400">Round-robin Ethereal SMTP accounts with per-sender rate limits</p>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close SMTP Sender Cluster Modal"
                  onClick={() => setShowSendersModal(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {senders.length > 0 ? (
                  senders.map((s) => (
                    <div
                      key={s.id}
                      className="bg-[#0d101b] border border-slate-800 rounded-xl p-3 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Mail className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-200 truncate">{s.displayName}</div>
                          <div className="font-mono text-[11px] text-slate-400 truncate">
                            {s.email} • {s.smtpHost}:{s.smtpPort}
                          </div>
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Active</span>
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-6 text-xs text-slate-400">Loading active SMTP senders...</div>
                )}
              </div>

              <form onSubmit={handleProvisionSender} className="pt-2 border-t border-slate-800 flex items-center gap-2">
                <input
                  type="text"
                  placeholder="New sender display name (e.g. Outreach Node #4)"
                  value={newSenderName}
                  onChange={(e) => setNewSenderName(e.target.value)}
                  className="flex-1 bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="submit"
                  disabled={isProvisioningSender}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap shadow-sm"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{isProvisioningSender ? 'Provisioning...' : 'Add Sender'}</span>
                </button>
              </form>

              <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                <span>Each sender independently enforces the 2s minimum spacing and hourly quota via Redis Lua.</span>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
