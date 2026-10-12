/** Retry only read-only remote calls. Never replay memory writes automatically. */
export async function retryTransient<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); }
    catch (error) {
      const status = Number((error as { status?: number; code?: number })?.status ?? (error as {code?:number})?.code);
      if (attempt + 1 >= attempts || ![429,500,502,503,504].includes(status)) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(4000,250*2**attempt)));
    }
  }
}
