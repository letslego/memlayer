import { existsSync, readFileSync } from 'node:fs';
import { ValidationError } from './errors.js';
import { requireId } from './validate.js';

export function loadEnvFile(file = '.env'): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function parseApiKeys(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new ValidationError(`Invalid API_KEYS entry: ${trimmed}`);
    }
    const key = trimmed.slice(0, idx).trim();
    const tenant = requireId(trimmed.slice(idx + 1).trim(), 'tenantId');
    if (!key) throw new ValidationError('API key is empty');
    out[key] = tenant;
  }
  return out;
}

export function readPositiveInt(raw: string | undefined, fallback: number, field: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return value;
}
