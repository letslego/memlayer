export class MemoryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends MemoryError {
  constructor(message: string) {
    super('validation', message, 400);
  }
}

export class UnauthorizedError extends MemoryError {
  constructor(message = 'Missing or unknown API key') {
    super('unauthorized', message, 401);
  }
}

export class TenantMismatchError extends MemoryError {
  constructor() {
    super(
      'tenant_mismatch',
      'Tenant scope comes from the verified API key, not the request payload.',
      403,
    );
  }
}

export class NotFoundError extends MemoryError {
  constructor(resource: string, id: string) {
    super('not_found', `${resource} not found: ${id}`, 404);
  }
}

export class KillSwitchError extends MemoryError {
  constructor(reason: string | null) {
    super('kill_switch', reason ? `Kill switch is on: ${reason}` : 'Kill switch is on', 423);
  }
}

export class CapExceededError extends MemoryError {
  constructor(kind: 'steps' | 'spend') {
    super('cap_exceeded', `Operational ${kind} cap exceeded`, 429);
  }
}

export class TimeoutError extends MemoryError {
  constructor(operation: string, timeoutMs: number) {
    super('timeout', `${operation} timed out after ${timeoutMs}ms`, 504);
  }
}
