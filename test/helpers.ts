import { openMemoryService, type MemoryService, type MemoryServiceOptions } from '../src/index.js';

export function testMemory(options: MemoryServiceOptions = {}): Promise<MemoryService> {
  return openMemoryService({
    databasePath: ':memory:',
    l1TtlMs: 60_000,
    l1Max: 2_000,
    ...options,
  });
}
