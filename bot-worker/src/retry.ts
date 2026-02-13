const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const shouldRetryStatus = (status: number): boolean => {
  return status === 408 || status === 425 || status === 429 || status >= 500;
};

export const fetchWithRetry = async (
  url: string,
  init: RequestInit,
  attempts = 3,
  baseDelayMs = 200,
): Promise<Response> => {
  let lastError: unknown = null;

  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, init);
      if (!shouldRetryStatus(res.status) || i === attempts - 1) {
        return res;
      }
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) {
        throw error;
      }
    }

    const delay = baseDelayMs * 2 ** i;
    await sleep(delay);
  }

  throw new Error(`Request failed after ${attempts} attempts: ${String(lastError)}`);
};
