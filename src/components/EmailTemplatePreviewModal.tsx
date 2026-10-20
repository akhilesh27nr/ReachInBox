import React, { useState, useMemo } from 'react';
import {
  X,
  Eye,
  Mail,
  User,
  Building,
  Briefcase,
  CheckCircle2,
  Calendar,
  Send,
  Code,
  Sparkles,
  ArrowRight,
  RefreshCw,
  Copy,
  Check
} from 'lucide-react';
import {
  renderEmailTemplate,
  detectTemplateTags,
  inferLeadVariables,
  COMMON_TEMPLATE_VARIABLES
} from '../lib/template.js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  subject: string;
  body: string;
  sampleLeads: string[];
  onConfirmSchedule?: () => void;
  isSubmitting?: boolean;
}

export const EmailTemplatePreviewModal: React.FC<Props> = ({
  isOpen,
  onClose,
  subject,
  body,
  sampleLeads,
  onConfirmSchedule,
  isSubmitting = false,
}) => {
  const defaultLeads = useMemo(() => {
    if (sampleLeads && sampleLeads.length > 0) return sampleLeads;
    return ['m.spencer@outlook.com', 'l.vance@stripe.com', 'k.hall@segment.com', 'a.smith@hubspot.com'];
  }, [sampleLeads]);

  const [selectedLead, setSelectedLead] = useState<string>(defaultLeads[0] || 'lead@example.com');
  const [customLeadInput, setCustomLeadInput] = useState('');
  const [activeTab, setActiveTab] = useState<'rendered' | 'raw'>('rendered');
  const [copied, setCopied] = useState(false);

  // Active recipient being tested
  const activeRecipient = (customLeadInput.trim() || selectedLead).trim();

  // Inferred variable dictionary for the current lead
  const leadVars = useMemo(() => inferLeadVariables(activeRecipient), [activeRecipient]);

  // Detect dynamic tags in both subject and body
  const tagInfo = useMemo(() => detectTemplateTags(`${subject} ${body}`), [subject, body]);

  // Interpolated content
  const renderedSubject = useMemo(
    () => renderEmailTemplate(subject || 'No Subject Specified', leadVars),
    [subject, leadVars]
  );

  const renderedBody = useMemo(
    () => renderEmailTemplate(body || 'No email body content.', leadVars),
    [body, leadVars]
  );

  const handleCopyRendered = () => {
    navigator.clipboard.writeText(`Subject: ${renderedSubject}\n\n${renderedBody}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="bg-[#121624] border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-[#0e121d]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-600/20 border border-indigo-500/30 text-indigo-400 flex items-center justify-center">
              <Eye className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">Email Template Preview</h3>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-500/30">
                  Dynamic Tag Verification
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Verify dynamic {'{{name}}'}, {'{{company}}'}, {'{{jobTitle}}'}, and {'{{email}}'} interpolation.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dynamic Recipient Switcher Bar */}
        <div className="px-6 py-3 bg-[#0d101a] border-b border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium whitespace-nowrap">Preview with Lead:</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {defaultLeads.slice(0, 4).map((lead) => (
                <button
                  key={lead}
                  onClick={() => {
                    setSelectedLead(lead);
                    setCustomLeadInput('');
                  }}
                  className={`px-2 py-1 rounded-md text-[11px] font-mono transition-colors ${
                    activeRecipient === lead
                      ? 'bg-indigo-600 text-white font-medium shadow-sm'
                      : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700/80 border border-slate-700/60'
                  }`}
                >
                  {lead}
                </button>
              ))}
            </div>
          </div>

          {/* Custom Lead Input */}
          <div className="flex items-center gap-1.5 min-w-[200px]">
            <input
              type="email"
              placeholder="Or test custom email..."
              value={customLeadInput}
              onChange={(e) => setCustomLeadInput(e.target.value)}
              className="w-full bg-[#121624] border border-slate-800 rounded-md px-2.5 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>
        </div>

        {/* Modal Body / Email Client Mockup */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Resolved Dynamic Variables Card */}
          <div className="bg-[#0e121d] border border-slate-800 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                <span className="font-semibold text-slate-200">Resolved Lead Variables</span>
                {tagInfo.hasTags && (
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-indigo-950 text-indigo-300 border border-indigo-500/30">
                    {tagInfo.tagCount} dynamic tag{tagInfo.tagCount === 1 ? '' : 's'} active
                  </span>
                )}
              </div>

              {/* View Mode Toggle */}
              <div className="flex items-center bg-[#121624] border border-slate-800 rounded-md p-0.5">
                <button
                  onClick={() => setActiveTab('rendered')}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    activeTab === 'rendered' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Rendered
                </button>
                <button
                  onClick={() => setActiveTab('raw')}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    activeTab === 'raw' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Template
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px]">
              <div className="bg-[#121624] border border-slate-800/80 rounded-lg p-2">
                <div className="text-slate-500 flex items-center gap-1">
                  <User className="w-3 h-3 text-indigo-400" />
                  <span>{'{{name}}'}</span>
                </div>
                <div className="font-semibold text-slate-200 mt-0.5 truncate">{leadVars.name}</div>
              </div>
              <div className="bg-[#121624] border border-slate-800/80 rounded-lg p-2">
                <div className="text-slate-500 flex items-center gap-1">
                  <Building className="w-3 h-3 text-teal-400" />
                  <span>{'{{company}}'}</span>
                </div>
                <div className="font-semibold text-slate-200 mt-0.5 truncate">{leadVars.company}</div>
              </div>
              <div className="bg-[#121624] border border-slate-800/80 rounded-lg p-2">
                <div className="text-slate-500 flex items-center gap-1">
                  <Briefcase className="w-3 h-3 text-purple-400" />
                  <span>{'{{jobTitle}}'}</span>
                </div>
                <div className="font-semibold text-slate-200 mt-0.5 truncate">{leadVars.jobTitle}</div>
              </div>
              <div className="bg-[#121624] border border-slate-800/80 rounded-lg p-2">
                <div className="text-slate-500 flex items-center gap-1">
                  <Mail className="w-3 h-3 text-cyan-400" />
                  <span>{'{{email}}'}</span>
                </div>
                <div className="font-semibold text-slate-200 mt-0.5 truncate font-mono">{leadVars.email}</div>
              </div>
            </div>
          </div>

          {/* Simulated Email Envelope */}
          <div className="bg-[#0b0e17] border border-slate-800 rounded-xl overflow-hidden shadow-inner">
            {/* Email Envelope Header */}
            <div className="bg-[#0e1320] border-b border-slate-800/80 p-4 space-y-2 text-xs">
              <div className="flex items-center justify-between border-b border-slate-800/60 pb-2">
                <span className="text-slate-500 font-medium">From:</span>
                <span className="text-slate-300 font-medium">
                  Outreach Cluster &lt;dywihiz3bjmwoags@ethereal.email&gt;
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-slate-800/60 pb-2">
                <span className="text-slate-500 font-medium">To:</span>
                <span className="font-mono text-indigo-300 font-semibold bg-indigo-950/50 px-2 py-0.5 rounded border border-indigo-500/30">
                  {leadVars.name} &lt;{activeRecipient}&gt;
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-slate-800/60 pb-2">
                <span className="text-slate-500 font-medium">Subject:</span>
                <span className="text-white font-semibold">{renderedSubject}</span>
              </div>
              <div className="flex items-center justify-between text-slate-500 text-[11px] pt-0.5">
                <span>Security: TLS 1.3 Encryption</span>
                <span>Scheduled Dispatch: Sequential with 2s Pacing</span>
              </div>
            </div>

            {/* Email Body Message Container */}
            <div className="p-6 min-h-[180px] bg-[#0c101d] text-slate-200 text-sm leading-relaxed font-sans">
              {activeTab === 'rendered' ? (
                <div className="whitespace-pre-wrap select-text">{renderedBody}</div>
              ) : (
                <div className="whitespace-pre-wrap font-mono text-xs text-indigo-200 bg-[#080b12] p-4 rounded-lg border border-slate-800">
                  {body || 'No template body content specified.'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-800 bg-[#0e121d] flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={handleCopyRendered}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 text-xs font-medium transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied to Clipboard' : 'Copy Sample Text'}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors"
            >
              Close
            </button>
            {onConfirmSchedule && (
              <button
                disabled={isSubmitting}
                onClick={() => {
                  onClose();
                  onConfirmSchedule();
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all shadow-md shadow-indigo-600/30 disabled:opacity-60"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Scheduling...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>Confirm & Schedule</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
