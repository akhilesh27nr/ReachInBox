import React, { useState, useEffect } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Gauge,
  RefreshCw,
  TrendingUp,
  Zap,
  Info,
  Sliders,
  ShieldCheck,
  ChevronRight
} from 'lucide-react';

export interface WorkerBucket {
  bucketIndex: number;
  timestamp: string;
  label: string;
  avgLatencyMs: number;
  p95LatencyMs: number;
  successCount: number;
  failureCount: number;
  totalCount: number;
  failureRate: number;
  throughputPerMin: number;
  isBottleneck: boolean;
  statusNote: string;
}

export interface WorkerMetricsData {
  timeframe: string;
  summary: {
    avgLatencyMs: number;
    p95LatencyMs: number;
    failureRate: number;
    totalProcessed: number;
    systemStatus: 'HEALTHY' | 'DEGRADED' | 'BOTTLENECK';
    activeWorkers: number;
    workerPacingSec: number;
    hourlyLimitPerSender: number;
    diagnosis: string;
  };
  buckets: WorkerBucket[];
}

interface Props {
  safeFetchJson: (url: string) => Promise<any>;
}

export const WorkerPerformanceMetrics: React.FC<Props> = ({ safeFetchJson }) => {
  const [metricType, setMetricType] = useState<'latency' | 'failures' | 'throughput'>('latency');
  const [timeframe, setTimeframe] = useState<'1h' | '6h' | '24h'>('1h');
  const [metricsData, setMetricsData] = useState<WorkerMetricsData | null>(null);
  const [hoveredBucket, setHoveredBucket] = useState<WorkerBucket | null>(null);
  const [activeHoverIndex, setActiveHoverIndex] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchMetrics = async () => {
    setIsLoading(true);
    try {
      const data = await safeFetchJson(`/api/stats/worker-metrics?timeframe=${timeframe}`);
      if (data) {
        setMetricsData(data);
        if (data.buckets && data.buckets.length > 0) {
          setHoveredBucket(data.buckets[data.buckets.length - 1]);
        }
      }
    } catch (err) {
      console.warn('Could not fetch worker metrics:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
    const timer = setInterval(fetchMetrics, 15000);
    return () => clearInterval(timer);
  }, [timeframe]);

  const summary = metricsData?.summary;
  const buckets: WorkerBucket[] =
    metricsData?.buckets && metricsData.buckets.length > 0
      ? metricsData.buckets
      : Array.from({ length: 12 }, (_, idx) => ({
          bucketIndex: idx,
          timestamp: new Date(Date.now() - (11 - idx) * 5 * 60000).toISOString(),
          label: new Date(Date.now() - (11 - idx) * 5 * 60000).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
          avgLatencyMs: 0,
          p95LatencyMs: 0,
          successCount: 0,
          failureCount: 0,
          totalCount: 0,
          failureRate: 0,
          throughputPerMin: 0,
          isBottleneck: false,
          statusNote: 'Idle Baseline',
        }));

  // Compute maximums for scaling the bar heights
  const maxLatency = Math.max(350, ...buckets.map((b) => Math.max(b.avgLatencyMs, b.p95LatencyMs)));
  const maxFailureRate = Math.max(10, ...buckets.map((b) => b.failureRate));
  const maxThroughput = Math.max(5, ...buckets.map((b) => b.throughputPerMin));

  const getBarHeight = (bucket: WorkerBucket) => {
    if (metricType === 'latency') {
      const val = bucket.avgLatencyMs;
      return `${Math.min(100, Math.max(18, (val / maxLatency) * 100))}%`;
    }
    if (metricType === 'failures') {
      const val = bucket.failureRate;
      return val === 0 ? '8%' : `${Math.min(100, Math.max(18, (val / maxFailureRate) * 100))}%`;
    }
    // throughput
    const val = bucket.throughputPerMin;
    return val === 0 ? '8%' : `${Math.min(100, Math.max(18, (val / maxThroughput) * 100))}%`;
  };

  const getBarColorClass = (bucket: WorkerBucket) => {
    if (metricType === 'latency') {
      if (bucket.avgLatencyMs > 350) return 'from-rose-500 to-amber-500 shadow-rose-500/20';
      if (bucket.avgLatencyMs > 250) return 'from-indigo-500 to-cyan-400 shadow-indigo-500/20';
      return 'from-teal-500 to-emerald-400 shadow-teal-500/20';
    }
    if (metricType === 'failures') {
      if (bucket.failureRate > 5) return 'from-red-600 to-rose-500 shadow-red-500/30';
      if (bucket.failureRate > 0) return 'from-amber-500 to-rose-400 shadow-amber-500/20';
      return 'from-emerald-600/80 to-teal-500/80 shadow-emerald-500/10';
    }
    // throughput
    return 'from-indigo-600 to-blue-400 shadow-indigo-500/20';
  };

  const getPrimaryBarValueLabel = (bucket: WorkerBucket) => {
    if (metricType === 'latency') return `${bucket.avgLatencyMs}ms`;
    if (metricType === 'failures') return `${bucket.failureRate}%`;
    return `${bucket.throughputPerMin}/m`;
  };

  return (
    <div className="glass-panel bg-[#121624]/75 border border-white/10 rounded-2xl p-5 shadow-xl backdrop-blur-xl space-y-5">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 text-indigo-400 flex items-center justify-center shadow-inner backdrop-blur-md">
            <Gauge className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-white tracking-tight">
                Worker Performance & Bottleneck Diagnostics
              </h3>
              {summary && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border backdrop-blur-md ${
                    summary.systemStatus === 'HEALTHY'
                      ? 'bg-emerald-950/60 border-emerald-500/30 text-emerald-300'
                      : summary.systemStatus === 'DEGRADED'
                      ? 'bg-amber-950/60 border-amber-500/30 text-amber-300'
                      : 'bg-rose-950/60 border-rose-500/30 text-rose-300'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      summary.systemStatus === 'HEALTHY'
                        ? 'bg-emerald-400 animate-pulse'
                        : summary.systemStatus === 'DEGRADED'
                        ? 'bg-amber-400'
                        : 'bg-rose-400 animate-ping'
                    }`}
                  />
                  <span>
                    {summary.systemStatus === 'HEALTHY'
                      ? 'System: Optimal'
                      : summary.systemStatus === 'DEGRADED'
                      ? 'Latency Elevated'
                      : 'Bottleneck Detected'}
                  </span>
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Live execution latency, failure rates, and concurrency throughput across worker instances. Hover any bar to inspect window metrics.
            </p>
          </div>
        </div>

        {/* Metric and Timeframe Toggles */}
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
          {/* Metric Switcher */}
          <div className="glass-subcard bg-[#0e121d]/80 border border-slate-800 rounded-xl p-0.5 flex items-center text-xs backdrop-blur-md">
            <button
              onClick={() => setMetricType('latency')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer whitespace-nowrap ${
                metricType === 'latency'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Latency (ms)
            </button>
            <button
              onClick={() => setMetricType('failures')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer whitespace-nowrap ${
                metricType === 'failures'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Failure Rate (%)
            </button>
            <button
              onClick={() => setMetricType('throughput')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer whitespace-nowrap ${
                metricType === 'throughput'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Throughput
            </button>
          </div>

          {/* Timeframe Selector */}
          <div className="glass-subcard bg-[#0e121d]/80 border border-slate-800 rounded-xl p-0.5 flex items-center text-xs backdrop-blur-md">
            {(['1h', '6h', '24h'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTimeframe(t)}
                className={`px-2.5 py-1 rounded-lg font-semibold uppercase transition-colors cursor-pointer ${
                  timeframe === t
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <button
            onClick={fetchMetrics}
            className="glass-subcard p-1.5 rounded-xl bg-[#0e121d]/80 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700 transition-colors cursor-pointer flex-shrink-0"
            title="Refresh metrics"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* KPI Cards Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="glass-subcard bg-[#0e121d]/75 border border-white/10 rounded-xl p-3.5 backdrop-blur-md">
          <div className="text-[11px] font-medium text-slate-400 flex items-center justify-between">
            <span>Avg Processing Latency</span>
            <span className="text-[10px] text-emerald-400 font-mono">SLA &lt; 250ms</span>
          </div>
          <div className="text-xl font-bold text-white mt-1">
            {summary ? `${summary.avgLatencyMs} ms` : '0 ms'}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Ethereal SMTP dispatch time</div>
        </div>

        <div className="glass-subcard bg-[#0e121d]/75 border border-white/10 rounded-xl p-3.5 backdrop-blur-md">
          <div className="text-[11px] font-medium text-slate-400 flex items-center justify-between">
            <span>P95 Tail Latency</span>
            <span className="text-[10px] text-indigo-400 font-mono">95% of sends</span>
          </div>
          <div className="text-xl font-bold text-white mt-1">
            {summary ? `${summary.p95LatencyMs} ms` : '0 ms'}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Peak queue claim duration</div>
        </div>

        <div className="glass-subcard bg-[#0e121d]/75 border border-white/10 rounded-xl p-3.5 backdrop-blur-md">
          <div className="text-[11px] font-medium text-slate-400 flex items-center justify-between">
            <span>Worker Failure Rate</span>
            <span className="text-[10px] text-emerald-400 font-mono">Target: 0%</span>
          </div>
          <div className="text-xl font-bold text-white mt-1">
            {summary ? `${summary.failureRate.toFixed(1)}%` : '0.0%'}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Automatic backoff on failure</div>
        </div>

        <div className="glass-subcard bg-[#0e121d]/75 border border-white/10 rounded-xl p-3.5 backdrop-blur-md">
          <div className="text-[11px] font-medium text-slate-400 flex items-center justify-between">
            <span>Worker Concurrency</span>
            <span className="text-[10px] text-cyan-400 font-mono">5 Workers</span>
          </div>
          <div className="text-xl font-bold text-white mt-1">
            {summary ? `${summary.workerPacingSec}s` : '2.0s'}
            <span className="text-xs text-slate-400 font-normal ml-1">Pacing</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Enforced via Redis Lua script</div>
        </div>
      </div>

      {/* Main Bar Chart Container */}
      <div className="glass-subcard bg-[#0e121d]/75 border border-white/10 rounded-xl p-4 space-y-3 backdrop-blur-md">
        {/* Chart Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-200">
              {metricType === 'latency'
                ? 'Processing Latency per Time Bucket (ms)'
                : metricType === 'failures'
                ? 'Failure Rate Trend (%)'
                : 'Processed Jobs Throughput (jobs/min)'}
            </span>
            <span className="text-[11px] text-slate-500">
              ({timeframe === '1h' ? '5-min buckets' : timeframe === '6h' ? '30-min buckets' : '1-hour buckets'} • Hover bar for details)
            </span>
          </div>

          {/* Reference Line Label */}
          {metricType === 'latency' && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className="w-3 h-0.5 border-t border-dashed border-indigo-400 inline-block" />
              <span>Target SLA Baseline: 250ms</span>
            </div>
          )}
          {metricType === 'failures' && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className="w-3 h-0.5 border-t border-dashed border-rose-400 inline-block" />
              <span>Warning Threshold: 5.0%</span>
            </div>
          )}
        </div>

        {/* Relative Chart Grid and Bars */}
        <div
          className="relative h-48 w-full pt-8 pb-6 flex items-end justify-between gap-1 sm:gap-2 px-1"
          onMouseLeave={() => setActiveHoverIndex(null)}
        >
          {/* Horizontal Reference Baseline Guides */}
          <div className="absolute inset-x-0 top-8 border-b border-slate-800/60 pointer-events-none" />
          <div className="absolute inset-x-0 top-14 border-b border-indigo-500/30 border-dashed pointer-events-none flex justify-end pr-2">
            <span className="text-[9px] text-indigo-400/80 font-mono -mt-3.5 bg-[#0e121d]/80 px-1 rounded">
              {metricType === 'latency' ? '250ms SLA' : metricType === 'failures' ? '5% Warning' : 'Medium Load'}
            </span>
          </div>
          <div className="absolute inset-x-0 bottom-6 border-b border-slate-800 pointer-events-none" />

          {/* Render Responsive Bars with Floating Glassy Hover Tooltip */}
          {buckets.map((b, idx) => {
            const isSelected = hoveredBucket?.bucketIndex === b.bucketIndex;
            const isActivelyHovered = activeHoverIndex === idx;
            const barHeight = getBarHeight(b);
            const colorClass = getBarColorClass(b);

            // Prevent horizontal clipping on edge bars
            const tooltipPositionClass =
              idx <= 1
                ? 'left-0 translate-x-0'
                : idx >= buckets.length - 2
                ? 'right-0 translate-x-0'
                : 'left-1/2 -translate-x-1/2';

            return (
              <div
                key={b.bucketIndex}
                data-testid={`chart-bar-${idx}`}
                onMouseEnter={() => {
                  setHoveredBucket(b);
                  setActiveHoverIndex(idx);
                }}
                onFocus={() => {
                  setHoveredBucket(b);
                  setActiveHoverIndex(idx);
                }}
                tabIndex={0}
                aria-label={`Time bucket ${b.label}: Avg Latency ${b.avgLatencyMs}ms, P95 Tail ${b.p95LatencyMs}ms, Delivered ${b.successCount}, Failed ${b.failureCount}`}
                className="relative flex-1 h-full flex flex-col justify-end items-center group cursor-pointer focus:outline-none"
              >
                {/* Floating Glassy Hover Popover Card on Bar Hover */}
                {isActivelyHovered && (
                  <div
                    role="tooltip"
                    data-testid="bar-hover-tooltip"
                    className={`absolute bottom-full mb-2.5 ${tooltipPositionClass} z-40 w-64 p-3 rounded-xl bg-[#0b0f1c]/95 border border-indigo-500/40 shadow-2xl backdrop-blur-xl pointer-events-none animate-in fade-in zoom-in-95 duration-150`}
                  >
                    <div className="flex items-center justify-between gap-2 pb-1.5 mb-2 border-b border-slate-800">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-white whitespace-nowrap">
                        <Clock className="w-3.5 h-3.5 text-indigo-400" />
                        <span>Window {b.label}</span>
                      </div>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-semibold whitespace-nowrap ${
                          b.isBottleneck
                            ? 'bg-rose-950/90 text-rose-300 border border-rose-500/40'
                            : 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/40'
                        }`}
                      >
                        {b.statusNote}
                      </span>
                    </div>

                    <div className="space-y-1.5 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400 whitespace-nowrap">Avg Latency:</span>
                        <span className="font-mono font-bold text-emerald-400 whitespace-nowrap">{b.avgLatencyMs} ms</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400 whitespace-nowrap">P95 Tail Latency:</span>
                        <span className="font-mono font-semibold text-indigo-300 whitespace-nowrap">{b.p95LatencyMs} ms</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400 whitespace-nowrap">Delivered / Failed:</span>
                        <span className="font-mono font-semibold text-white whitespace-nowrap">
                          {b.successCount} ok /{' '}
                          <span className={b.failureCount > 0 ? 'text-rose-400' : 'text-slate-300'}>
                            {b.failureCount} err ({b.failureRate}%)
                          </span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400 whitespace-nowrap">Throughput:</span>
                        <span className="font-mono font-semibold text-cyan-300 whitespace-nowrap">
                          {b.throughputPerMin} jobs/min
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Value Badge Directly Above Bar */}
                <span
                  className={`mb-1 text-[10px] font-mono transition-all ${
                    isActivelyHovered || isSelected
                      ? 'opacity-100 text-indigo-300 font-bold -translate-y-0.5'
                      : 'opacity-70 text-slate-400 group-hover:opacity-100'
                  }`}
                >
                  {getPrimaryBarValueLabel(b)}
                </span>

                {/* Bar */}
                <div
                  style={{ height: barHeight }}
                  className={`w-full max-w-[34px] rounded-t-md transition-all duration-200 bg-gradient-to-t ${colorClass} ${
                    isActivelyHovered
                      ? 'ring-2 ring-indigo-400 ring-offset-2 ring-offset-[#0e121d] scale-105 z-10 brightness-110'
                      : isSelected
                      ? 'ring-1 ring-indigo-400/70 opacity-100'
                      : 'opacity-85 hover:opacity-100'
                  }`}
                />

                {/* X-Axis Tick Label */}
                <span
                  className={`absolute -bottom-5 text-[10px] font-mono transition-colors truncate max-w-full ${
                    isActivelyHovered || isSelected ? 'text-indigo-400 font-bold' : 'text-slate-500'
                  }`}
                >
                  {b.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* Hover Inspector Tooltip / Details Footer Bar */}
        {hoveredBucket && (
          <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs bg-[#101524]/60 p-2.5 rounded-xl backdrop-blur-md">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-indigo-400" />
              <span className="font-semibold text-slate-200">Window at {hoveredBucket.label}</span>
              <span className="text-slate-500">|</span>
              <span className="text-slate-400">
                Avg Latency:{' '}
                <strong
                  className={
                    hoveredBucket.avgLatencyMs > 350
                      ? 'text-rose-400'
                      : hoveredBucket.avgLatencyMs > 250
                      ? 'text-amber-400'
                      : 'text-emerald-400'
                  }
                >
                  {hoveredBucket.avgLatencyMs}ms
                </strong>
              </span>
              <span className="text-slate-500">|</span>
              <span className="text-slate-400">
                P95 Tail: <strong className="text-indigo-300">{hoveredBucket.p95LatencyMs}ms</strong>
              </span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-slate-400">
                Delivered: <strong className="text-white">{hoveredBucket.successCount}</strong>
              </span>
              <span className="text-slate-400">
                Failures:{' '}
                <strong className={hoveredBucket.failureCount > 0 ? 'text-rose-400' : 'text-slate-300'}>
                  {hoveredBucket.failureCount} ({hoveredBucket.failureRate}%)
                </strong>
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                  hoveredBucket.isBottleneck
                    ? 'bg-rose-950/80 text-rose-300 border border-rose-500/40'
                    : 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30'
                }`}
              >
                {hoveredBucket.statusNote}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Diagnostic Diagnosis & Bottleneck Advice */}
      <div className="bg-indigo-950/25 border border-indigo-500/25 rounded-xl p-3.5 flex items-start gap-3 text-xs backdrop-blur-md">
        <div className="w-6 h-6 rounded-lg bg-indigo-600/30 text-indigo-400 flex-shrink-0 flex items-center justify-center mt-0.5">
          <Info className="w-3.5 h-3.5" />
        </div>
        <div className="space-y-1">
          <div className="font-semibold text-slate-200 flex items-center gap-1.5">
            <span>Admin Bottleneck Analysis</span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-indigo-950 text-indigo-300 border border-indigo-500/30">
              Auto-Evaluated
            </span>
          </div>
          <p className="text-slate-400 leading-relaxed">
            {summary?.diagnosis ||
              'Worker concurrency (5 Workers) and rate-limit pacing (2s) operating optimally without bottlenecks.'}
          </p>
          <div className="pt-1 flex flex-wrap items-center gap-3 text-[11px] text-indigo-300/90">
            <span className="flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                Zero-drop guarantee active: Redis Lua script atomically spaces sends &ge; 2s and reschedules hourly
                overflows into subsequent windows without failing jobs.
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
