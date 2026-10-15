// The WHOLE story of a failure, in one line (E13-2, after the first --live run).
//
// Node's fetch reports every network-level failure as `TypeError: fetch failed`
// and puts the real reason one or two levels down in `.cause` (undici:
// UND_ERR_SOCKET "other side closed", ECONNRESET, ETIMEDOUT, EPIPE…). Printing
// only `.message` — what the first upload script did — throws exactly that
// reason away. tus-js-client's DetailedError carries it in `causingError`,
// plus the request it was on and the response, if one came back.
//
// Walks `.cause` and `.causingError` up to a fixed depth, so a cycle cannot hang.

type Errish = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
  address?: unknown;
  port?: unknown;
  cause?: unknown;
  causingError?: unknown;
  originalRequest?: { getMethod?: () => string; getURL?: () => string } | null;
  originalResponse?: { getStatus?: () => number; getBody?: () => string } | null;
};

const MAX_DEPTH = 6;

function one(e: Errish): string {
  const head = [typeof e.name === "string" ? e.name : "", typeof e.message === "string" ? e.message : String(e)]
    .filter(Boolean)
    .join(": ");
  const extra: string[] = [];
  for (const k of ["code", "errno", "syscall", "address", "port"] as const) {
    const v = e[k];
    if (v !== undefined && v !== null && v !== "") extra.push(`${k}=${String(v)}`);
  }
  const req = e.originalRequest;
  if (req && typeof req.getMethod === "function" && typeof req.getURL === "function") {
    extra.push(`request=${req.getMethod()} ${req.getURL()}`);
  }
  const res = e.originalResponse;
  if (res && typeof res.getStatus === "function") {
    const body = typeof res.getBody === "function" ? (res.getBody() ?? "").slice(0, 300) : "";
    extra.push(`status=${res.getStatus()}${body ? ` body=${JSON.stringify(body)}` : ""}`);
  }
  return extra.length ? `${head} [${extra.join(", ")}]` : head;
}

export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < MAX_DEPTH; depth++) {
    if (typeof cur !== "object") {
      parts.push(String(cur));
      break;
    }
    const e = cur as Errish;
    parts.push(one(e));
    cur = e.cause ?? e.causingError;
  }
  return parts.join(" ⟵ ");
}
