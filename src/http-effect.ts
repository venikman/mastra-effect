import { Data, Duration, Effect, Schedule } from "effect";

export class NetworkError extends Data.TaggedError("NetworkError")<{
  message: string;
  cause?: unknown;
}> {}

export class HttpError extends Data.TaggedError("HttpError")<{
  status: number;
  statusText: string;
  bodyText: string;
}> {}

export class ParseError extends Data.TaggedError("ParseError")<{
  message: string;
  bodyText: string;
}> {}

export type HttpFetchError = NetworkError | HttpError | ParseError;

/** Fetch with an AbortController-based timeout that composes with an existing signal. */
export const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const upstream = init.signal;

  const abortFromUpstream = () => controller.abort(upstream?.reason);
  if (upstream) {
    if (upstream.aborted) abortFromUpstream();
    else upstream.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    upstream?.removeEventListener("abort", abortFromUpstream);
  }
};

export const headersToRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
};

/**
 * Build a retry schedule: exponential backoff starting at `baseMs`,
 * up to `maxRetries`, only retrying when `shouldRetry` returns true.
 */
export const retrySchedule = <E>(opts: {
  baseMs: number;
  maxRetries: number;
  shouldRetry: (err: E) => boolean;
}) =>
  Schedule.intersect(
    Schedule.exponential(Duration.millis(opts.baseMs)),
    Schedule.recurs(opts.maxRetries - 1),
  ).pipe(Schedule.whileInput(opts.shouldRetry));
