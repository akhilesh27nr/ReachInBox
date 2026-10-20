export const ONE_HOUR_MS = 3_600_000;

export function getHourWindowIndex(timestampMs: number): number {
  return Math.floor(timestampMs / ONE_HOUR_MS);
}

export function getWindowStartTime(windowIndex: number): number {
  return windowIndex * ONE_HOUR_MS;
}

export function getNextWindowStartTime(timestampMs: number): number {
  return (Math.floor(timestampMs / ONE_HOUR_MS) + 1) * ONE_HOUR_MS;
}

export interface ScheduleEstimate {
  estimatedDurationMs: number;
  formattedDuration: string;
  totalWindows: number;
  emailsPerWindow: number;
  overflowsHourlyLimit: boolean;
  activeSenders: number;
  effectiveDelaySec: number;
  effectiveHourlyLimit: number;
}

export function calculateScheduleEstimate(
  totalLeads: number,
  delaySec: number,
  hourlyLimitPerSender: number,
  activeSendersCount: number = 3
): ScheduleEstimate {
  const senders = Math.max(1, activeSendersCount);
  const safeDelaySec = Math.max(1, delaySec);
  const safeHourlyLimit = Math.max(1, hourlyLimitPerSender);

  // Maximum physical sends possible per sender given the min delay:
  const maxSendsByDelay = Math.floor(3600 / safeDelaySec);
  // Real sender limit per hour is capped by both the configured hourly quota and the physical delay
  const senderHourlyCapacity = Math.min(safeHourlyLimit, maxSendsByDelay);
  // Total emails cluster can send per hour window
  const clusterHourlyCapacity = senderHourlyCapacity * senders;

  const totalWindows = Math.max(1, Math.ceil(totalLeads / clusterHourlyCapacity));
  const overflows = totalLeads > clusterHourlyCapacity;

  // Approximate duration:
  // (totalWindows - 1) * 1 hour + remaining emails * delay
  const remainingInLastWindow = totalLeads % clusterHourlyCapacity || clusterHourlyCapacity;
  const lastWindowDurationSec = Math.ceil(remainingInLastWindow / senders) * safeDelaySec;
  const totalDurationSec = (totalWindows - 1) * 3600 + Math.min(3600, lastWindowDurationSec);
  const totalDurationMs = totalDurationSec * 1000;

  const hours = Math.floor(totalDurationSec / 3600);
  const minutes = Math.ceil((totalDurationSec % 3600) / 60);

  let formattedDuration = '';
  if (hours > 0 && minutes > 0) {
    formattedDuration = `~${hours}h ${minutes}m`;
  } else if (hours > 0) {
    formattedDuration = `~${hours}h`;
  } else {
    formattedDuration = `~${Math.max(1, minutes)}m`;
  }

  return {
    estimatedDurationMs: totalDurationMs,
    formattedDuration,
    totalWindows,
    emailsPerWindow: clusterHourlyCapacity,
    overflowsHourlyLimit: overflows,
    activeSenders: senders,
    effectiveDelaySec: safeDelaySec,
    effectiveHourlyLimit: safeHourlyLimit,
  };
}

export interface BottleneckDiagnosis {
  systemStatus: 'HEALTHY' | 'DEGRADED' | 'BOTTLENECK';
  isBottleneck: boolean;
  diagnosis: string;
}

export function diagnoseWorkerMetrics(
  avgLatencyMs: number,
  failureRate: number,
  workerCount: number = 5
): BottleneckDiagnosis {
  if (avgLatencyMs > 350 || failureRate > 5) {
    return {
      systemStatus: 'BOTTLENECK',
      isBottleneck: true,
      diagnosis: `Elevated latency (${avgLatencyMs}ms) or failure rate (${failureRate}%). Review worker queue depth or SMTP provider responsiveness.`,
    };
  }

  if (avgLatencyMs > 250 || failureRate > 1) {
    return {
      systemStatus: 'DEGRADED',
      isBottleneck: false,
      diagnosis: `Latency is moderately elevated (${avgLatencyMs}ms), but failure rate (${failureRate}%) is within acceptable operating limits.`,
    };
  }

  return {
    systemStatus: 'HEALTHY',
    isBottleneck: false,
    diagnosis: `Worker concurrency (${workerCount} Workers) and rate-limit pacing operating optimally without bottlenecks.`,
  };
}

