export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message = 'Operation timed out'): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const id = setTimeout(() => reject(new Error(message)), ms);
    void promise.finally(() => clearTimeout(id));
  });
  return Promise.race([promise, timeout]);
}
