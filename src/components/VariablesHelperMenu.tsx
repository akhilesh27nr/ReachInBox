import React, { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
  ChevronDown,
  Info,
  Check,
  Plus,
  FileText,
  Mail,
  User,
  Building,
  Briefcase
} from 'lucide-react';
import { COMMON_TEMPLATE_VARIABLES, VariableDefinition, inferLeadVariables } from '../lib/template.js';

interface Props {
  onInsertTag: (tag: string, targetField?: 'body' | 'subject') => void;
  sampleLeadEmail?: string;
}

export const VariablesHelperMenu: React.FC<Props> = ({ onInsertTag, sampleLeadEmail = 'sarah.jenkins@stripe.com' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [recentlyInserted, setRecentlyInserted] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const sampleInferred = inferLeadVariables(sampleLeadEmail);

  const getVariableIcon = (key: string) => {
    switch (key) {
      case 'name':
        return <User className="w-3.5 h-3.5 text-indigo-400" />;
      case 'company':
        return <Building className="w-3.5 h-3.5 text-teal-400" />;
      case 'jobTitle':
        return <Briefcase className="w-3.5 h-3.5 text-purple-400" />;
      case 'email':
      default:
        return <Mail className="w-3.5 h-3.5 text-cyan-400" />;
    }
  };

  const getResolvedSampleValue = (key: string): string => {
    switch (key) {
      case 'name':
        return sampleInferred.name || 'Sarah Jenkins';
      case 'company':
        return sampleInferred.company || 'Stripe';
      case 'jobTitle':
        return sampleInferred.jobTitle || 'VP of Growth';
      case 'email':
      default:
        return sampleInferred.email || 'sarah.jenkins@stripe.com';
    }
  };

  const handleInsert = (tag: string, target: 'body' | 'subject' = 'body') => {
    onInsertTag(tag, target);
    setRecentlyInserted(tag);
    setTimeout(() => setRecentlyInserted(null), 1800);
  };

  return (
    <div className="relative block w-full text-xs" ref={dropdownRef}>
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Main Dropdown Button */}
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border transition-all ${
            isOpen
              ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm'
              : 'bg-indigo-950/60 hover:bg-indigo-950 text-indigo-300 border-indigo-500/30'
          }`}
          title="Open dynamic variables helper menu"
        >
          <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
          <span>Variables</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {/* Quick-Insert Variable Chips */}
        {COMMON_TEMPLATE_VARIABLES.map((v) => (
          <button
            key={v.tag}
            type="button"
            onClick={() => handleInsert(v.tag, 'body')}
            className={`px-2 py-1 rounded-md text-[11px] font-mono border transition-all flex items-center gap-1 ${
              recentlyInserted === v.tag
                ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50 scale-105'
                : 'bg-slate-800/70 hover:bg-indigo-950/60 text-slate-300 hover:text-indigo-200 border-slate-700/70 hover:border-indigo-500/40'
            }`}
            title={`Click to insert ${v.tag} into email body`}
          >
            {recentlyInserted === v.tag ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Plus className="w-2.5 h-2.5 text-slate-400" />
            )}
            <span>{v.tag}</span>
          </button>
        ))}
      </div>

      {/* Dropdown Popover */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-2 z-50 w-80 bg-[#121624] border border-slate-800 rounded-xl shadow-2xl p-3.5 space-y-3 backdrop-blur-md animate-in fade-in slide-in-from-top-1">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <span className="font-bold text-white text-xs">Dynamic Campaign Variables</span>
            </div>
            <span className="text-[10px] text-slate-500 font-mono">Auto-interpolated</span>
          </div>

          <p className="text-[11px] text-slate-400 leading-normal">
            Insert placeholder tags. When workers dispatch outreach, each tag is dynamically replaced with the
            recipient's data.
          </p>

          {/* Variables List */}
          <div className="space-y-2">
            {COMMON_TEMPLATE_VARIABLES.map((v) => {
              const sampleVal = getResolvedSampleValue(v.key);
              return (
                <div
                  key={v.tag}
                  className="bg-[#0b0e17] border border-slate-800/80 rounded-lg p-2.5 space-y-1.5 hover:border-slate-700 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {getVariableIcon(v.key)}
                      <span className="font-semibold text-slate-200 text-xs">{v.label}</span>
                    </div>
                    <code className="text-[11px] font-mono text-indigo-300 bg-indigo-950/60 px-1.5 py-0.5 rounded border border-indigo-500/30">
                      {v.tag}
                    </code>
                  </div>

                  <div className="text-[11px] text-slate-400">{v.description}</div>

                  <div className="flex items-center justify-between pt-1 border-t border-slate-800/40 text-[11px]">
                    <div className="text-slate-500 truncate max-w-[140px]">
                      Sample: <span className="text-slate-300 italic">{sampleVal}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleInsert(v.tag, 'subject')}
                        className="px-1.5 py-0.5 rounded text-[10px] text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 transition-colors"
                        title={`Insert ${v.tag} into Subject`}
                      >
                        + Subject
                      </button>
                      <button
                        type="button"
                        onClick={() => handleInsert(v.tag, 'body')}
                        className="px-2 py-0.5 rounded text-[10px] font-semibold text-indigo-300 hover:text-white bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/40 transition-colors"
                        title={`Insert ${v.tag} into Body`}
                      >
                        + Body
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-1 border-t border-slate-800/80 text-[10px] text-slate-500 flex items-center gap-1">
            <Info className="w-3 h-3 text-indigo-400 flex-shrink-0" />
            <span>Missing names or companies default gracefully to smart fallbacks.</span>
          </div>
        </div>
      )}
    </div>
  );
};
