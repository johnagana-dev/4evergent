import type { AgentIntent } from '@4evergent/shared';

export interface ScheduleValidationResult {
  valid: boolean;
  error?: string;
  nextRunAt?: string;
}

export function validateScheduleExpression(expression?: string, timezone?: string): ScheduleValidationResult {
  if (!expression || expression.trim().length === 0) return { valid: false, error: 'schedule expression is required' };
  if (!timezone || !isValidTimezone(timezone)) return { valid: false, error: 'invalid timezone' };

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return { valid: false, error: 'schedule expression must have 5 fields' };

  const minute = parts[0] ?? '';
  const hour = parts[1] ?? '';
  const dom = parts[2] ?? '';
  const month = parts[3] ?? '';
  const dow = parts[4] ?? '';

  if (!isValidCronField(minute, 0, 59)) return { valid: false, error: 'invalid minute' };
  if (!isValidCronField(hour, 0, 23)) return { valid: false, error: 'invalid hour' };
  if (!isValidCronField(dom, 1, 31)) return { valid: false, error: 'invalid day-of-month' };
  if (!isValidCronField(month, 1, 12)) return { valid: false, error: 'invalid month' };
  if (!isValidCronField(dow, 0, 6)) return { valid: false, error: 'invalid day-of-week' };

  const nextRunAt = computeNextRun(minute, hour, dom, month, dow);
  if (!nextRunAt) return { valid: false, error: 'could not compute next run time' };

  return { valid: true, nextRunAt };
}

export function validateScheduleIntent(intent?: AgentIntent): ScheduleValidationResult {
  if (!intent || typeof intent !== 'object') return { valid: false, error: 'intent is required' };
  if (intent.type !== 'payment') return { valid: false, error: 'unsupported intent type' };
  if (!intent.asset) return { valid: false, error: 'intent.asset is required' };
  if (!intent.destination || !intent.destination.startsWith('G')) return { valid: false, error: 'invalid destination' };
  if (!intent.amount || isNaN(parseFloat(intent.amount)) || parseFloat(intent.amount) <= 0) return { valid: false, error: 'invalid amount' };
  if (!intent.reason || intent.reason.length < 3) return { valid: false, error: 'reason too short' };
  return { valid: true };
}

function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*' || field === '') return field === '*';
  if (field.includes(',')) return field.split(',').every((f) => isValidCronField(f, min, max));
  if (field.includes('/')) {
    const parts = field.split('/');
    const base = parts[0] ?? '';
    const stepStr = parts[1] ?? '0';
    return isValidCronField(base, min, max) && parseInt(stepStr) > 0;
  }
  if (field.includes('-')) {
    const parts = field.split('-');
    const start = parseInt(parts[0] ?? '0');
    const end = parseInt(parts[1] ?? '0');
    return start >= min && end <= max && start <= end;
  }
  const num = parseInt(field);
  return num >= min && num <= max;
}

function isValidTimezone(tz: string): boolean {
  return ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'].includes(tz);
}

function computeNextRun(minute: string, hour: string, dom: string, month: string, dow: string): string | null {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);

  for (let i = 0; i < 525600; i++) {
    candidate.setMinutes(candidate.getMinutes() + 1);

    if (!matchesMinutes(candidate.getMinutes(), minute)) continue;
    if (!matchesHours(candidate.getHours(), hour)) continue;
    if (!matchesDayOfMonth(candidate.getDate(), dom)) continue;
    if (!matchesMonth(candidate.getMonth() + 1, month)) continue;
    if (!matchesDayOfWeek(candidate.getDay(), dow)) continue;

    if (candidate > now) return candidate.toISOString();
  }

  return null;
}

function matchesMinutes(value: number, field: string): boolean {
  if (field === '*') return true;
  if (field.includes(',')) return field.split(',').some((f) => matchesMinutes(value, f));
  if (field.includes('/')) {
    const parts = field.split('/');
    const base = parts[0] ?? '';
    const stepStr = parts[1] ?? '0';
    const step = parseInt(stepStr);
    if (base === '*') return value % step === 0;
    return value >= parseInt(base) && (value - parseInt(base)) % step === 0;
  }
  if (field.includes('-')) {
    const parts = field.split('-');
    const start = parseInt(parts[0] ?? '0');
    const end = parseInt(parts[1] ?? '0');
    return value >= start && value <= end;
  }
  return value === parseInt(field);
}

function matchesHours(value: number, field: string): boolean {
  if (field === '*') return true;
  if (field.includes(',')) return field.split(',').some((f) => matchesHours(value, f));
  if (field.includes('/')) {
    const parts = field.split('/');
    const base = parts[0] ?? '';
    const stepStr = parts[1] ?? '0';
    const step = parseInt(stepStr);
    if (base === '*') return value % step === 0;
    return value >= parseInt(base) && (value - parseInt(base)) % step === 0;
  }
  if (field.includes('-')) {
    const parts = field.split('-');
    const start = parseInt(parts[0] ?? '0');
    const end = parseInt(parts[1] ?? '0');
    return value >= start && value <= end;
  }
  return value === parseInt(field);
}

function matchesDayOfMonth(value: number, field: string): boolean {
  if (field === '*') return true;
  if (field.includes(',')) return field.split(',').some((f) => matchesDayOfMonth(value, f));
  if (field.includes('/')) {
    const parts = field.split('/');
    const base = parts[0] ?? '';
    const stepStr = parts[1] ?? '0';
    const step = parseInt(stepStr);
    if (base === '*') return value % step === 0;
    return value >= parseInt(base) && (value - parseInt(base)) % step === 0;
  }
  if (field.includes('-')) {
    const parts = field.split('-');
    const start = parseInt(parts[0] ?? '0');
    const end = parseInt(parts[1] ?? '0');
    return value >= start && value <= end;
  }
  return value === parseInt(field);
}

function matchesMonth(value: number, field: string): boolean {
  if (field === '*') return true;
  if (field.includes(',')) return field.split(',').some((f) => matchesMonth(value, f));
  if (field.includes('/')) {
    const parts = field.split('/');
    const base = parts[0] ?? '';
    const stepStr = parts[1] ?? '0';
    const step = parseInt(stepStr);
    if (base === '*') return value % step === 0;
    return value >= parseInt(base) && (value - parseInt(base)) % step === 0;
  }
  if (field.includes('-')) {
    const parts = field.split('-');
    const start = parseInt(parts[0] ?? '0');
    const end = parseInt(parts[1] ?? '0');
    return value >= start && value <= end;
  }
  return value === parseInt(field);
}

function matchesDayOfWeek(value: number, field: string): boolean {
  if (field === '*') return true;
  if (field.includes(',')) return field.split(',').some((f) => matchesDayOfWeek(value, f));
  if (field.includes('/')) {
    const parts = field.split('/');
    const base = parts[0] ?? '';
    const stepStr = parts[1] ?? '0';
    const step = parseInt(stepStr);
    if (base === '*') return value % step === 0;
    return value >= parseInt(base) && (value - parseInt(base)) % step === 0;
  }
  if (field.includes('-')) {
    const parts = field.split('-');
    const start = parseInt(parts[0] ?? '0');
    const end = parseInt(parts[1] ?? '0');
    return value >= start && value <= end;
  }
  return value === parseInt(field);
}
