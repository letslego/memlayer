import { randomBytes } from 'node:crypto';
import { ValidationError } from './errors.js';
import type { Acl, FactInput, FactType } from './types.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const LABEL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

export function requireId(value: string, field: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new ValidationError(`${field} must match ${ID_RE.source}`);
  }
  return value;
}

export function requireFactKey(value: string): string {
  if (typeof value !== 'string' || !KEY_RE.test(value)) {
    throw new ValidationError(`fact key must match ${KEY_RE.source}`);
  }
  return value;
}

export function requireLabel(value: string, field: string): string {
  if (typeof value !== 'string' || !LABEL_RE.test(value)) {
    throw new ValidationError(`${field} must match ${LABEL_RE.source}`);
  }
  return value;
}

export function pairKey(left: string, right: string): string {
  return `${left}:${right}`;
}

export function assertFact(input: FactInput): void {
  requireFactKey(input.key);
  if (input.type === 'string') {
    if (typeof input.value !== 'string') throw new ValidationError('String fact requires a string value');
    if (input.value.length > 4_096) throw new ValidationError('String fact exceeds 4096 characters');
    return;
  }
  if (input.type === 'number') {
    if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
      throw new ValidationError('Numeric fact requires a finite number');
    }
    return;
  }
  if (input.type === 'boolean') {
    if (typeof input.value !== 'boolean') throw new ValidationError('Boolean fact requires a boolean value');
    return;
  }
  if (input.type === 'json') {
    const encoded = jsonClone(input.value);
    if (encoded.length > 8_192) throw new ValidationError('JSON fact exceeds 8192 characters');
    return;
  }
  throw new ValidationError(`Unsupported fact type: ${String(input.type)}`);
}

export function jsonClone(value: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ValidationError('Value must be JSON-serializable');
  }
  if (encoded === undefined) throw new ValidationError('Value must be JSON-serializable');
  return encoded;
}

export function parseJsonObject(encoded: string, field: string): Record<string, unknown> {
  try {
    const value = JSON.parse(encoded) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ValidationError(`Corrupt ${field}`);
  }
}

export function normalizeAcl(input: {
  visibility?: 'tenant' | 'restricted';
  userIds?: string[];
  roles?: string[];
} | undefined): Acl {
  const visibility = input?.visibility ?? 'tenant';
  if (visibility !== 'tenant' && visibility !== 'restricted') {
    throw new ValidationError('ACL visibility must be tenant or restricted');
  }
  const userIds = input?.userIds ?? [];
  const roles = input?.roles ?? [];
  if (!Array.isArray(userIds) || !Array.isArray(roles)) {
    throw new ValidationError('ACL userIds and roles must be arrays');
  }
  if (userIds.length > 100 || roles.length > 50) throw new ValidationError('ACL list is too large');
  return {
    visibility,
    userIds: userIds.map((id) => requireId(id, 'acl.userId')),
    roles: roles.map((role) => requireLabel(role, 'acl.role')),
  };
}

export function aclAllows(acl: Acl, userId: string | undefined, roles: readonly string[] | undefined): boolean {
  if (acl.visibility === 'tenant') return true;
  if (userId && acl.userIds.includes(userId)) return true;
  if (roles && acl.roles.some((role) => roles.includes(role))) return true;
  return false;
}

export function parseAclJson(encoded: string): Acl {
  const value = parseJsonObject(encoded, 'acl');
  const visibility = value.visibility;
  if (visibility !== 'tenant' && visibility !== 'restricted') {
    throw new ValidationError('Corrupt acl visibility');
  }
  const userIds = Array.isArray(value.userIds) ? value.userIds.filter((item): item is string => typeof item === 'string') : [];
  const roles = Array.isArray(value.roles) ? value.roles.filter((item): item is string => typeof item === 'string') : [];
  return { visibility, userIds, roles };
}

export function assertMetadata(
  metadata: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> {
  if (!metadata) return {};
  const keys = Object.keys(metadata);
  if (keys.length > 32) throw new ValidationError('metadata exceeds 32 keys');
  for (const key of keys) {
    if (!KEY_RE.test(key) && !ID_RE.test(key)) throw new ValidationError(`Invalid metadata key: ${key}`);
    const value = metadata[key];
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new ValidationError(`metadata.${key} must be a string, number, boolean, or null`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ValidationError(`metadata.${key} must be finite`);
    }
    if (typeof value === 'string' && value.length > 1_024) {
      throw new ValidationError(`metadata.${key} is too long`);
    }
  }
  return metadata;
}

export function isFactType(value: string): value is FactType {
  return value === 'string' || value === 'number' || value === 'boolean' || value === 'json';
}
