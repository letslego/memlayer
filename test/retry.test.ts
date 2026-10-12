import { afterEach, expect, it, vi } from 'vitest';
import { retryTransient } from '../src/adk/retry.js';
afterEach(()=>vi.useRealTimers());
it('retries transient statuses, stops at the bound, and leaves permanent errors alone',async()=>{
  vi.useFakeTimers();
  const transient = vi.fn().mockRejectedValueOnce({status:429}).mockResolvedValue('ok');
  const success = retryTransient(transient);
  await vi.runAllTimersAsync();
  expect(await success).toBe('ok');
  expect(transient).toHaveBeenCalledTimes(2);
  const permanent = vi.fn().mockRejectedValue({status:401});
  await expect(retryTransient(permanent)).rejects.toEqual({status:401});
  expect(permanent).toHaveBeenCalledTimes(1);
  const exhausted = vi.fn().mockRejectedValue({status:503});
  const failure = expect(retryTransient(exhausted)).rejects.toEqual({status:503});
  await vi.runAllTimersAsync();await failure;
  expect(exhausted).toHaveBeenCalledTimes(3);
});
