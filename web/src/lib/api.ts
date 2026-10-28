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

/**
 * Sends one file as the raw request body. XMLHttpRequest, not fetch, because only it reports upload progress.
 * Rejects with an ApiError, or with a DOMException named AbortError when `signal` aborts.
 */
export function upload<T>(
  url: string,
  file: Blob,
  name: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => new DOMException('Upload cancelled', 'AbortError');
    if (signal.aborted) return reject(aborted());
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(name));
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'offline', 'No connection to the server'));
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        /* empty body */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
      const code = typeof data.error === 'string' ? data.error : 'failed';
      if (xhr.status === 401 && code === 'unauthorized') onUnauthorized();
      reject(
        new ApiError(xhr.status, code, typeof data.message === 'string' ? data.message : undefined, data),
      );
    };
    signal.addEventListener(
      'abort',
      () => {
        xhr.abort();
        reject(aborted());
      },
      { once: true },
    );
    xhr.send(file);
  });
}

export const get = <T>(url: string): Promise<T> => request<T>('GET', url);
export const post = <T>(url: string, body: unknown = {}): Promise<T> => request<T>('POST', url, body);
export const patch = <T>(url: string, body: unknown): Promise<T> => request<T>('PATCH', url, body);
export const del = <T>(url: string): Promise<T> => request<T>('DELETE', url);

export const isStepUp = (e: unknown): boolean => e instanceof ApiError && e.code === 'stepup_required';
