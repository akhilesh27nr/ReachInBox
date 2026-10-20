import React, { useMemo, useState } from 'react';
import { CheckCircle2, AlertTriangle, TrendingUp } from 'lucide-react';
import { computeDeliveryStabilitySeries, HourlyDeliveryBucket } from '../lib/sparkline.js';

interface Props {
  sentCount: number;
  failedCount: number;
  trend24h?: HourlyDeliveryBucket[];
}

export const DeliveryStabilitySparkline: React.FC<Props> = ({
  sentCount,
  failedCount,
  trend24h,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const series = useMemo(() => {
    const baseBuckets =
      trend24h && trend24h.length > 0
        ? trend24h.map((b) => ({ ...b }))
        : Array.from({ length: 24 }, (_, i) => ({
            hourIndex: i,
            hourLabel: `${String(i).padStart(2, '0')}:00`,
            sent: 0,
            failed: 0,
            stabilityPct: 100,
          }));

    if (baseBuckets.length > 0) {
      const last = baseBuckets[baseBuckets.length - 1];
      if (sentCount > 0 || failedCount > 0) {
        last.sent = Math.max(last.sent, sentCount);
        last.failed = Math.max(last.failed, failedCount);
      }
    }

    return computeDeliveryStabilitySeries(baseBuckets, 118, 34);
  }, [trend24h, sentCount, failedCount]);

  const totalLive = sentCount + failedCount;
  const liveSuccessPct =
    totalLive > 0
      ? Number(((sentCount / totalLive) * 100).toFixed(1))
      : series.overallStabilityPct;

  const isHealthy = failedCount === 0 || liveSuccessPct >= 97;
  const strokeColor = isHealthy ? '#10b981' : liveSuccessPct >= 90 ? '#f59e0b' : '#f43f5e';
  const gradientId = isHealthy
    ? 'sparkline-grad-emerald'
    : liveSuccessPct >= 90
    ? 'sparkline-grad-amber'
    : 'sparkline-grad-rose';

  const activePoint =
    hoveredIdx !== null && series.points[hoveredIdx]
      ? series.points[hoveredIdx]
      : series.points[series.points.length - 1];

  return (
    <div className="space-y-2" data-testid="delivery-stability-card">
      {/* Main Row: Sent vs Failed Counts + 24h Sparkline Side-by-Side */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <div className="text-3xl font-bold tracking-tight text-white" title="Delivered Emails">
            {sentCount.toLocaleString()}
          </div>
          <div className="flex items-center gap-1 text-xs font-semibold">
            <span className="text-slate-500">/</span>
            <span
              className={failedCount > 0 ? 'text-rose-400 font-bold' : 'text-slate-400'}
              title="Failed Emails"
            >
              {failedCount.toLocaleString()} failed
            </span>
          </div>
        </div>

        {/* 24h Trend Sparkline SVG */}
        <div
          className="relative flex flex-col items-end flex-shrink-0"
          onMouseLeave={() => setHoveredIdx(null)}
        >
          {hoveredIdx !== null && activePoint && (
            <div
              role="tooltip"
              className="absolute bottom-full right-0 mb-2 z-40 w-44 p-2 rounded-xl bg-[#0b0f1c]/95 border border-indigo-500/40 shadow-xl backdrop-blur-xl text-[11px] pointer-events-none animate-in fade-in duration-100"
            >
              <div className="flex items-center justify-between font-bold text-white border-b border-slate-800 pb-1 mb-1">
                <span>Hour {activePoint.hourLabel}</span>
                <span className="text-emerald-400 font-mono">{activePoint.stabilityPct}%</span>
              </div>
              <div className="flex items-center justify-between text-slate-300 font-mono">
                <span>Sent: {activePoint.sent}</span>
                <span className={activePoint.failed > 0 ? 'text-rose-400 font-bold' : 'text-slate-400'}>
                  Failed: {activePoint.failed}
                </span>
              </div>
            </div>
          )}
          <svg
            width={118}
            height={34}
            viewBox="0 0 118 34"
            className="overflow-visible cursor-crosshair"
            role="img"
            aria-label={`24-hour delivery stability trend: ${liveSuccessPct}% success`}
          >
            <defs>
              <linearGradient id="sparkline-grad-emerald" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
              </linearGradient>
              <linearGradient id="sparkline-grad-amber" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.0" />
              </linearGradient>
              <linearGradient id="sparkline-grad-rose" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Subtle 100% reference baseline */}
            <line
              x1="3"
              y1="4"
              x2="115"
              y2="4"
              stroke="currentColor"
              className="text-slate-800"
              strokeDasharray="2 2"
              strokeWidth="1"
            />

            {/* Gradient Area Fill */}
            <path d={series.areaPath} fill={`url(#${gradientId})`} />

            {/* Stability Trend Line */}
            <polyline
              fill="none"
              stroke={strokeColor}
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={series.polylinePoints}
            />

            {/* Failure Incident Dots */}
            {series.points.map((pt, idx) =>
              pt.hasFailure ? (
                <circle
                  key={`fail-${idx}`}
                  cx={pt.x}
                  cy={pt.y}
                  r={2.5}
                  fill="#f43f5e"
                  stroke="#0c0f17"
                  strokeWidth="1"
                />
              ) : null
            )}

            {/* Latest / Active Point Indicator */}
            {activePoint && (
              <circle
                cx={activePoint.x}
                cy={activePoint.y}
                r={3}
                fill={activePoint.hasFailure ? '#f43f5e' : strokeColor}
                stroke="#ffffff"
                strokeWidth="1.2"
              />
            )}

            {/* Invisible interactive hover columns for 24h inspection */}
            {series.points.map((pt, idx) => {
              const colWidth = 118 / series.points.length;
              return (
                <rect
                  key={`hit-${idx}`}
                  x={ idx * colWidth }
                  y={0}
                  width={colWidth}
                  height={34}
                  fill="transparent"
                  onMouseEnter={() => setHoveredIdx(idx)}
                />
              );
            })}
          </svg>
          <span className="text-[10px] font-mono text-slate-400 leading-none mt-0.5">
            24h stability
          </span>
        </div>
      </div>

      {/* Bottom Status Badge & Live Bucket Readout */}
      <div className="flex items-center justify-between gap-2">
        {isHealthy ? (
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-950/50 border border-emerald-500/30 text-emerald-400 text-[11px] font-semibold">
            <CheckCircle2 className="w-3 h-3" />
            <span>{liveSuccessPct}% success</span>
          </div>
        ) : (
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-950/60 border border-amber-500/40 text-amber-300 text-[11px] font-semibold">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            <span>{liveSuccessPct}% stability</span>
          </div>
        )}

        <div className="text-[11px] font-mono text-slate-400 truncate">
          {hoveredIdx !== null && activePoint ? (
            <span>
              {activePoint.hourLabel}:{' '}
              <strong className="text-emerald-400">{activePoint.sent}ok</strong>/
              <strong className={activePoint.failed > 0 ? 'text-rose-400' : 'text-slate-400'}>
                {activePoint.failed}err
              </strong>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-slate-400">
              <TrendingUp className="w-3 h-3 text-emerald-400" />
              <span>{series.overallStabilityPct}% 24h avg</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
