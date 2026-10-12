export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

let csrf = '';
export const setCsrf = (t: string): void => {
  csrf = t;
};

/** Called when any request comes back 401 while signed in. */
let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (fn: () => void): void => {
  onUnauthorized = fn;
};

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'offline', 'No connection to the server');
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const code = typeof data.error === 'string' ? data.error : 'failed';
    if (res.status === 401 && code === 'unauthorized') onUnauthorized();
    throw new ApiError(res.status, code, typeof data.message === 'string' ? data.message : undefined, data);
  }
  return data as T;
}

export const get = <T>(url: string): Promise<T> => request<T>('GET', url);
export const post = <T>(url: string, body: unknown = {}): Promise<T> => request<T>('POST', url, body);
export const patch = <T>(url: string, body: unknown): Promise<T> => request<T>('PATCH', url, body);
export const del = <T>(url: string): Promise<T> => request<T>('DELETE', url);

export const isStepUp = (e: unknown): boolean => e instanceof ApiError && e.code === 'stepup_required';
