interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Austria — consolidated federal law and case law, from the Bundeskanzleramt's
 * Rechtsinformationssystem (RIS) open government data service.
 *
 * Two datasets, one pack:
 *  - Bundesrecht konsolidiert (consolidated federal law): every federal
 *    statute/regulation kept up to date, addressable by law (Gesetzesnummer)
 *    and provision (§/Art/Anlage), each provision carrying every historical
 *    "Fassung" (version) with its own in-force dates.
 *  - Judikatur (case law): decisions of the Verfassungsgerichtshof (VfGH,
 *    constitutional court), Verwaltungsgerichtshof (VwGH, supreme
 *    administrative court) and the ordinary courts (Justiz: OGH plus
 *    OLG/LG/BG), each with Geschäftszahl, ECLI, decision date and full text.
 *
 * Keyless, live proxy, fully public. RIS asks to be notified before
 * high-volume harvesting — this pack makes one upstream request per tool
 * call (plus, where a tool returns original-language text, one further
 * request to fetch that one document's text), never a bulk crawl, so it
 * stays well under anything RIS would call high-volume.
 *
 * THE RESPONSE SHAPE IS XML-DERIVED JSON: a field that can repeat is
 * `{ "item": "x" }` for one value and `{ "item": ["x","y"] }` for several —
 * never a bare array. `asArray()` normalises both (and absence) into a real
 * array everywhere this pack reads one.
 *
 * NEITHER DATASET'S SEARCH RETURNS BODY TEXT — only metadata plus links to
 * the one document's Xml/Html/Rtf/Pdf. Getting actual original-language text
 * (a provision, a decision) is always a second fetch, to a URL taken from
 * the first response, never constructed from guesswork except in the two
 * "by id" tools, which use the one stable, confirmed-live URL pattern
 * (`.../Dokumente/<ApplicationFolder>/<id>/<id>.html`) for a caller who
 * already holds an id from an earlier search.
 *
 * FASSUNG VERSIONING: a provision can have several historical Fassungen
 * (versions), each with its own in-force window. `Fassung.FassungVom=<date>`
 * asks the upstream to resolve to the one version valid on that date — this
 * pack always sends it (defaulting to today) rather than returning every
 * version and making the caller pick.
 */


const UA = 'pipeworx-mcp-at-ris/1.0 (+https://pipeworx.io)';
const UPSTREAM_NAME = 'RIS (Rechtsinformationssystem, Bundeskanzleramt)';
const API_BASE = 'https://data.bka.gv.at/ris/api/v2.6';
const DOC_BASE = 'https://ogd.ris.bka.gv.at/Dokumente';

const SOURCE_LEGISLATION = 'Bundeskanzleramt (Austria), Rechtsinformationssystem (RIS) — Bundesrecht konsolidiert (consolidated federal law)';
const SOURCE_CASELAW = 'Bundeskanzleramt (Austria), Rechtsinformationssystem (RIS) — Judikatur (case law)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM_NAME);
}

// ── small shared helpers ────────────────────────────────────────────────

/** XML-derived JSON repeats a field as `{ item: T | T[] }`; absence is `undefined`. */
function asArray<T>(x: { item?: T | T[] } | T | T[] | undefined): T[] {
  if (x === undefined || x === null) return [];
  const container = (x as { item?: T | T[] })?.item !== undefined ? (x as { item?: T | T[] }).item : x;
  if (container === undefined || container === null) return [];
  return Array.isArray(container) ? container : [container as T];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** DokumenteProSeite only accepts these four strings — snap a numeric limit up to the nearest. */
const PAGE_SIZE_ENUM: Array<{ n: number; v: string }> = [
  { n: 10, v: 'Ten' },
  { n: 20, v: 'Twenty' },
  { n: 50, v: 'Fifty' },
  { n: 100, v: 'OneHundred' },
];

function resolvePageSize(limit: unknown): { n: number; v: string } {
  const want = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 20;
  return PAGE_SIZE_ENUM.find((p) => p.n >= want) ?? PAGE_SIZE_ENUM[PAGE_SIZE_ENUM.length - 1];
}

/** RIS paginates in fixed pages (Seitennummer, 1-n) at a fixed DokumenteProSeite.
 *  The tool surface takes an arbitrary record offset, so this maps one to the
 *  other and reports how many leading rows of the fetched page to drop. */
function planPage(limit: unknown, offset: unknown): { pageSize: { n: number; v: string }; page: number; drop: number } {
  const pageSize = resolvePageSize(limit);
  const off = typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const page = Math.floor(off / pageSize.n) + 1;
  const drop = off % pageSize.n;
  return { pageSize, page, drop };
}

/** RIS reports the soap-flavoured client error shown in its own docs as
 *  `{"OgdSearchResult":{"Error":{"Applikation":"...","Message":"..."}}}`,
 *  on both 200 and non-200 responses — check for it before assuming the body
 *  is a result. */
async function fetchOgd(path: string, params: URLSearchParams): Promise<unknown> {
  params.set('OutputFormat', 'Json');
  const url = `${API_BASE}/${path}?${params.toString()}`;
  const res = await pwFetch(url);
  const raw = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${UPSTREAM_NAME} returned a non-JSON response (HTTP ${res.status}).`);
  }
  const errBlock = (json as { OgdSearchResult?: { Error?: { Applikation?: string; Message?: string } } })?.OgdSearchResult?.Error;
  if (errBlock) {
    throw new Error(`${UPSTREAM_NAME} rejected the request (${errBlock.Applikation ?? 'RIS'}): ${errBlock.Message ?? `HTTP ${res.status}`}`);
  }
  if (!res.ok) {
    throw new Error(`${UPSTREAM_NAME} returned HTTP ${res.status}.`);
  }
  return json;
}

function hitsOf(json: unknown): number {
  const h = (json as { OgdSearchResult?: { OgdDocumentResults?: { Hits?: { '#text'?: string } } } })?.OgdSearchResult?.OgdDocumentResults?.Hits;
  const n = h?.['#text'];
  return n ? Number(n) : 0;
}

function docsOf(json: unknown): Array<{ Data: { Metadaten: Record<string, any>; Dokumentliste?: Record<string, any> } }> {
  const refs = (json as { OgdSearchResult?: { OgdDocumentResults?: { OgdDocumentReference?: unknown } } })?.OgdSearchResult?.OgdDocumentResults
    ?.OgdDocumentReference;
  if (!refs) return [];
  return (Array.isArray(refs) ? refs : [refs]) as Array<{ Data: { Metadaten: Record<string, any>; Dokumentliste?: Record<string, any> } }>;
}

function contentUrl(doc: { Dokumentliste?: Record<string, any> } | undefined, type: 'Html' | 'Xml' = 'Html'): string | undefined {
  const urls = doc?.Dokumentliste?.ContentReference?.Urls?.ContentUrl;
  const arr = Array.isArray(urls) ? urls : urls ? [urls] : [];
  return arr.find((u: { DataType?: string; Url?: string }) => u.DataType === type)?.Url;
}

/** Strips the RIS document HTML (style/script blocks, then tags, then
 *  entities) down to the readable original-language text — the same shape
 *  for a statute provision and a court decision. */
function extractRisText(html: string): string {
  let s = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return s.replace(/\s+/g, ' ').trim();
}

const TEXT_PAGE_CHARS = 12000;

function pageText(text: string, offset: unknown): { text: string; total_length: number; has_more: boolean; next_offset: number | null } {
  const off = typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const slice = text.slice(off, off + TEXT_PAGE_CHARS);
  const end = off + slice.length;
  return {
    text: slice,
    total_length: text.length,
    has_more: end < text.length,
    next_offset: end < text.length ? end : null,
  };
}

async function fetchDocText(url: string): Promise<string> {
  const res = await pwFetch(url);
  if (!res.ok) throw new Error(`${UPSTREAM_NAME} returned HTTP ${res.status} fetching the document text.`);
  const html = await res.text();
  return extractRisText(html);
}

// ── Bundesrecht konsolidiert (legislation) normalisation ────────────────

function normalizeBrKons(doc: { Data: { Metadaten: Record<string, any>; Dokumentliste?: Record<string, any> } }) {
  const meta = doc.Data.Metadaten;
  const tech = meta.Technisch ?? {};
  const br = meta.Bundesrecht ?? {};
  const k = br.BrKons ?? {};
  return {
    document_id: tech.ID as string | undefined,
    gesetzesnummer: k.Gesetzesnummer as string | undefined,
    short_title: br.Kurztitel as string | undefined,
    title: typeof br.Titel === 'string' ? extractRisText(br.Titel) : undefined,
    abbreviation: k.Abkuerzung as string | undefined,
    provision: k.ArtikelParagraphAnlage as string | undefined,
    provision_type: k.Dokumenttyp as string | undefined,
    in_force_from: k.Inkrafttretensdatum as string | undefined,
    in_force_until: k.Ausserkrafttretensdatum as string | undefined,
    publication: k.Kundmachungsorgan as string | undefined,
    last_amended_by: k.Aenderung || undefined,
    subject_index: asArray<string>(k.Indizes),
    official_url: br.Eli as string | undefined,
    whole_law_url: k.GesamteRechtsvorschriftUrl as string | undefined,
    data_as_of: meta.Allgemein?.Geaendert as string | undefined,
    _doc: doc,
  };
}

async function resolveGesetzesnummer(law: string): Promise<{ gesetzesnummer: string; short_title?: string } | null> {
  if (/^\d+$/.test(law.trim())) return { gesetzesnummer: law.trim() };
  // Most consolidated laws carry a "§ 0" root record naming the whole law —
  // try that restriction first so a title search resolves to exactly one law.
  const rootParams = new URLSearchParams({
    Applikation: 'BrKons',
    Titel: law,
    'Abschnitt.Von': '0',
    'Abschnitt.Bis': '0',
    'Abschnitt.Typ': 'Paragraph',
  });
  const rootJson = await fetchOgd('Bundesrecht', rootParams);
  const rootHit = docsOf(rootJson)[0];
  if (rootHit) {
    const n = normalizeBrKons(rootHit);
    if (n.gesetzesnummer) return { gesetzesnummer: n.gesetzesnummer, short_title: n.short_title };
  }
  // Fall back to an unrestricted title search (some laws have no §0 record).
  const plainParams = new URLSearchParams({ Applikation: 'BrKons', Titel: law });
  const plainJson = await fetchOgd('Bundesrecht', plainParams);
  const plainHit = docsOf(plainJson)[0];
  if (plainHit) {
    const n = normalizeBrKons(plainHit);
    if (n.gesetzesnummer) return { gesetzesnummer: n.gesetzesnummer, short_title: n.short_title };
  }
  return null;
}

// ── Judikatur (case law) normalisation ───────────────────────────────────

type CourtKey = 'vfgh' | 'vwgh' | 'justiz';

const APPLIKATION_BY_COURT: Record<CourtKey, string> = { vfgh: 'Vfgh', vwgh: 'Vwgh', justiz: 'Justiz' };
const FOLDER_BY_COURT: Record<CourtKey, string> = { vfgh: 'Vfgh', vwgh: 'Vwgh', justiz: 'Justiz' };
const APP_BLOCK_KEY: Record<CourtKey, string> = { vfgh: 'Vfgh', vwgh: 'Vwgh', justiz: 'Justiz' };

function inferCourtFromId(id: string): CourtKey | undefined {
  if (id.startsWith('JFT')) return 'vfgh';
  if (id.startsWith('JWT')) return 'vwgh';
  if (id.startsWith('JJT') || id.startsWith('JJR')) return 'justiz';
  return undefined;
}

function inferCourtFromEcli(ecli: string): CourtKey {
  const upper = ecli.toUpperCase();
  if (upper.includes(':VFGH:')) return 'vfgh';
  if (upper.includes(':VWGH:')) return 'vwgh';
  return 'justiz';
}

function normalizeJudikatur(doc: { Data: { Metadaten: Record<string, any>; Dokumentliste?: Record<string, any> } }, court: CourtKey) {
  const meta = doc.Data.Metadaten;
  const tech = meta.Technisch ?? {};
  const j = meta.Judikatur ?? {};
  const block = j[APP_BLOCK_KEY[court]] ?? {};
  return {
    document_id: tech.ID as string | undefined,
    court: (block.Gericht as string | undefined) ?? APPLIKATION_BY_COURT[court],
    geschaeftszahl: asArray<string>(j.Geschaeftszahl),
    ecli: j.EuropeanCaseLawIdentifier as string | undefined,
    decision_date: j.Entscheidungsdatum as string | undefined,
    document_type: j.Dokumenttyp as string | undefined, // "Text" (full decision) or "Rechtssatz" (headnote)
    decision_type: (block.Entscheidungsart as string | undefined) ?? undefined,
    legal_areas: asArray<string>(block.Rechtsgebiete),
    subject_areas: asArray<string>(block.Fachgebiete),
    headnote: (block.Leitsatz as string | undefined) ?? undefined,
    keywords: (j.Schlagworte as string | undefined) || undefined,
    norms: asArray<string>(j.Normen),
    data_as_of: meta.Allgemein?.Geaendert as string | undefined,
    _doc: doc,
  };
}

// ── at_search_legislation ────────────────────────────────────────────────

async function searchLegislation(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const titel = typeof args.titel === 'string' ? args.titel.trim() : '';
  const gesetzesnummer = typeof args.gesetzesnummer === 'string' ? args.gesetzesnummer.trim() : '';
  const inForceOn = typeof args.in_force_on === 'string' ? args.in_force_on.trim() : '';
  if (!query && !titel && !gesetzesnummer) {
    throw new Error('Pass at least one of query (full-text), titel (law title) or gesetzesnummer.');
  }
  const { pageSize, page, drop } = planPage(args.limit, args.offset);
  const offset = typeof args.offset === 'number' ? Math.max(0, Math.trunc(args.offset)) : 0;

  const params = new URLSearchParams({ Applikation: 'BrKons' });
  if (query) params.set('Suchworte', query);
  if (titel) params.set('Titel', titel);
  if (gesetzesnummer) params.set('Gesetzesnummer', gesetzesnummer);
  if (inForceOn) params.set('Fassung.FassungVom', inForceOn);
  params.set('DokumenteProSeite', pageSize.v);
  params.set('Seitennummer', String(page));

  const json = await fetchOgd('Bundesrecht', params);
  const total = hitsOf(json);
  const docs = docsOf(json).slice(drop);
  if (total === 0 || docs.length === 0) {
    return {
      found: false,
      query: query || undefined,
      titel: titel || undefined,
      gesetzesnummer: gesetzesnummer || undefined,
      message: 'No consolidated federal law provisions match this search.',
      source: SOURCE_LEGISLATION,
    };
  }
  const items = docs.map((d) => {
    const n = normalizeBrKons(d);
    return {
      document_id: n.document_id,
      gesetzesnummer: n.gesetzesnummer,
      short_title: n.short_title,
      title: n.title,
      abbreviation: n.abbreviation,
      provision: n.provision,
      provision_type: n.provision_type,
      in_force_from: n.in_force_from,
      in_force_until: n.in_force_until,
      publication: n.publication,
      subject_index: n.subject_index,
      official_url: n.official_url,
    };
  });
  const shownEnd = offset + items.length;
  return {
    found: true,
    query: query || undefined,
    titel: titel || undefined,
    gesetzesnummer: gesetzesnummer || undefined,
    in_force_on: inForceOn || undefined,
    total_hits: total,
    shown: items.length,
    limit: pageSize.n,
    offset,
    has_more: shownEnd < total,
    next_offset: shownEnd < total ? shownEnd : null,
    items,
    source: SOURCE_LEGISLATION,
  };
}

// ── at_get_provision ──────────────────────────────────────────────────────

async function getProvision(args: Record<string, unknown>): Promise<unknown> {
  const law = typeof args.law === 'string' ? args.law.trim() : '';
  const paragraph = typeof args.paragraph === 'string' ? args.paragraph.trim() : String(args.paragraph ?? '').trim();
  if (!law) throw new Error('law is required — a Gesetzesnummer (e.g. "10001622") or a law title/abbreviation (e.g. "ABGB").');
  if (!paragraph) throw new Error('paragraph is required — the §/Art/Anlage number, e.g. "1328a", "1", "16".');
  const provisionType = typeof args.provision_type === 'string' && args.provision_type ? args.provision_type : 'Paragraph';
  const asOf = typeof args.as_of === 'string' && args.as_of ? args.as_of : todayIso();

  const resolved = await resolveGesetzesnummer(law);
  if (!resolved) {
    return {
      found: false,
      law,
      message: `No consolidated federal law found matching "${law}". Use at_search_legislation to find the right title or gesetzesnummer first.`,
      source: SOURCE_LEGISLATION,
    };
  }

  const params = new URLSearchParams({
    Applikation: 'BrKons',
    Gesetzesnummer: resolved.gesetzesnummer,
    'Abschnitt.Von': paragraph,
    'Abschnitt.Bis': paragraph,
    'Abschnitt.Typ': provisionType,
    'Fassung.FassungVom': asOf,
  });
  const json = await fetchOgd('Bundesrecht', params);
  const doc = docsOf(json)[0];
  if (!doc) {
    return {
      found: false,
      law,
      gesetzesnummer: resolved.gesetzesnummer,
      paragraph,
      as_of: asOf,
      message: `No provision "${paragraph}" of gesetzesnummer ${resolved.gesetzesnummer} is in force on ${asOf} (or that number does not exist). Try a different as_of date or check the number with at_search_legislation.`,
      source: SOURCE_LEGISLATION,
    };
  }
  const n = normalizeBrKons(doc);
  const htmlUrl = contentUrl(doc.Data, 'Html');
  let textResult: { text: string; total_length: number; has_more: boolean; next_offset: number | null } | undefined;
  if (htmlUrl) {
    const full = await fetchDocText(htmlUrl);
    textResult = pageText(full, args.text_offset);
  }
  return {
    found: true,
    document_id: n.document_id,
    gesetzesnummer: n.gesetzesnummer,
    short_title: n.short_title,
    abbreviation: n.abbreviation,
    provision: n.provision,
    provision_type: n.provision_type,
    as_of: asOf,
    in_force_from: n.in_force_from,
    in_force_until: n.in_force_until,
    publication: n.publication,
    last_amended_by: n.last_amended_by,
    official_url: n.official_url,
    whole_law_url: n.whole_law_url,
    text: textResult?.text,
    text_total_length: textResult?.total_length,
    text_has_more: textResult?.has_more ?? false,
    text_next_offset: textResult?.next_offset ?? null,
    data_as_of: n.data_as_of,
    source: SOURCE_LEGISLATION,
  };
}

// ── at_get_legislation_document ──────────────────────────────────────────

async function getLegislationDocument(args: Record<string, unknown>): Promise<unknown> {
  const documentId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
  if (!documentId) throw new Error('document_id is required — a RIS document id (e.g. "NOR40229402") from at_search_legislation or at_get_provision.');
  const url = `${DOC_BASE}/Bundesnormen/${encodeURIComponent(documentId)}/${encodeURIComponent(documentId)}.html`;
  const res = await pwFetch(url);
  if (res.status === 404) {
    return {
      found: false,
      document_id: documentId,
      message: `No legislation document with id "${documentId}". Ids come from at_search_legislation or at_get_provision, not from guessing.`,
      source: SOURCE_LEGISLATION,
    };
  }
  if (!res.ok) throw new Error(`${UPSTREAM_NAME} returned HTTP ${res.status} fetching document ${documentId}.`);
  const full = extractRisText(await res.text());
  const page = pageText(full, args.text_offset);
  return {
    found: true,
    document_id: documentId,
    text: page.text,
    text_total_length: page.total_length,
    text_has_more: page.has_more,
    text_next_offset: page.next_offset,
    source: SOURCE_LEGISLATION,
  };
}

// ── at_search_case_law ────────────────────────────────────────────────────

const VALID_COURTS: CourtKey[] = ['vfgh', 'vwgh', 'justiz'];

async function searchCaseLaw(args: Record<string, unknown>): Promise<unknown> {
  const court = typeof args.court === 'string' ? (args.court.toLowerCase() as CourtKey) : undefined;
  if (!court || !VALID_COURTS.includes(court)) {
    throw new Error('court is required — one of "vfgh" (constitutional court), "vwgh" (supreme administrative court) or "justiz" (OGH/OLG/LG/BG ordinary courts).');
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const geschaeftszahl = typeof args.geschaeftszahl === 'string' ? args.geschaeftszahl.trim() : '';
  const dateFrom = typeof args.date_from === 'string' ? args.date_from.trim() : '';
  const dateTo = typeof args.date_to === 'string' ? args.date_to.trim() : '';
  if (!query && !geschaeftszahl && !dateFrom && !dateTo) {
    throw new Error('Pass at least one of query (full-text), geschaeftszahl, date_from or date_to.');
  }
  const docType = typeof args.doc_type === 'string' && args.doc_type === 'rechtssatz' ? 'rechtssatz' : 'entscheidungstext';
  const { pageSize, page, drop } = planPage(args.limit, args.offset);
  const offset = typeof args.offset === 'number' ? Math.max(0, Math.trunc(args.offset)) : 0;

  const params = new URLSearchParams({ Applikation: APPLIKATION_BY_COURT[court] });
  if (query) params.set('Suchworte', query);
  if (geschaeftszahl) params.set('Geschaeftszahl', geschaeftszahl);
  if (dateFrom) params.set('EntscheidungsdatumVon', dateFrom);
  if (dateTo) params.set('EntscheidungsdatumBis', dateTo);
  if (docType === 'rechtssatz') {
    params.set('Dokumenttyp.SucheInRechtssaetzen', 'true');
  } else {
    params.set('Dokumenttyp.SucheInEntscheidungstexten', 'true');
  }
  params.set('DokumenteProSeite', pageSize.v);
  params.set('Seitennummer', String(page));

  const json = await fetchOgd('Judikatur', params);
  const total = hitsOf(json);
  const docs = docsOf(json).slice(drop);
  if (total === 0 || docs.length === 0) {
    return {
      found: false,
      court,
      query: query || undefined,
      geschaeftszahl: geschaeftszahl || undefined,
      message: 'No decisions match this search.',
      source: SOURCE_CASELAW,
    };
  }
  const items = docs.map((d) => {
    const n = normalizeJudikatur(d, court);
    return {
      document_id: n.document_id,
      court: n.court,
      geschaeftszahl: n.geschaeftszahl,
      ecli: n.ecli,
      decision_date: n.decision_date,
      document_type: n.document_type,
      decision_type: n.decision_type,
      legal_areas: n.legal_areas,
      subject_areas: n.subject_areas,
      headnote: n.headnote,
      norms: n.norms,
    };
  });
  const shownEnd = offset + items.length;
  return {
    found: true,
    court,
    query: query || undefined,
    geschaeftszahl: geschaeftszahl || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    doc_type: docType,
    total_hits: total,
    shown: items.length,
    limit: pageSize.n,
    offset,
    has_more: shownEnd < total,
    next_offset: shownEnd < total ? shownEnd : null,
    items,
    source: SOURCE_CASELAW,
  };
}

// ── at_get_decision ────────────────────────────────────────────────────────

async function getDecision(args: Record<string, unknown>): Promise<unknown> {
  const documentId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
  const ecli = typeof args.ecli === 'string' ? args.ecli.trim() : '';
  const geschaeftszahl = typeof args.geschaeftszahl === 'string' ? args.geschaeftszahl.trim() : '';
  const courtArg = typeof args.court === 'string' ? (args.court.toLowerCase() as CourtKey) : undefined;

  let doc: { Data: { Metadaten: Record<string, any>; Dokumentliste?: Record<string, any> } } | undefined;
  let court: CourtKey | undefined;
  let htmlUrl: string | undefined;

  if (documentId) {
    court = (courtArg && VALID_COURTS.includes(courtArg) ? courtArg : inferCourtFromId(documentId)) ?? undefined;
    if (!court) {
      throw new Error(`Could not tell which court document_id "${documentId}" belongs to — pass court ("vfgh"|"vwgh"|"justiz") explicitly.`);
    }
    htmlUrl = `${DOC_BASE}/${FOLDER_BY_COURT[court]}/${encodeURIComponent(documentId)}/${encodeURIComponent(documentId)}.html`;
  } else if (ecli) {
    court = courtArg && VALID_COURTS.includes(courtArg) ? courtArg : inferCourtFromEcli(ecli);
    const params = new URLSearchParams({
      Applikation: APPLIKATION_BY_COURT[court],
      Suchworte: ecli,
      'Dokumenttyp.SucheInEntscheidungstexten': 'true',
    });
    const json = await fetchOgd('Judikatur', params);
    doc = docsOf(json)[0];
    if (!doc) {
      return { found: false, ecli, court, message: `No decision found with ECLI "${ecli}" under ${court}.`, source: SOURCE_CASELAW };
    }
  } else if (geschaeftszahl) {
    if (!courtArg || !VALID_COURTS.includes(courtArg)) {
      throw new Error('court is required with geschaeftszahl — one of "vfgh", "vwgh" or "justiz" (a Geschäftszahl alone does not reliably identify the court).');
    }
    court = courtArg;
    const params = new URLSearchParams({
      Applikation: APPLIKATION_BY_COURT[court],
      Geschaeftszahl: geschaeftszahl,
      'Dokumenttyp.SucheInEntscheidungstexten': 'true',
    });
    const json = await fetchOgd('Judikatur', params);
    doc = docsOf(json)[0];
    if (!doc) {
      return { found: false, geschaeftszahl, court, message: `No decision found with Geschäftszahl "${geschaeftszahl}" under ${court}.`, source: SOURCE_CASELAW };
    }
  } else {
    throw new Error('Pass one of document_id, ecli, or geschaeftszahl (with court).');
  }

  if (doc) htmlUrl = contentUrl(doc.Data, 'Html');
  if (!htmlUrl) {
    return { found: false, document_id: documentId || undefined, ecli: ecli || undefined, geschaeftszahl: geschaeftszahl || undefined, court, message: 'No document text URL in the response.', source: SOURCE_CASELAW };
  }

  const res = await pwFetch(htmlUrl);
  if (res.status === 404) {
    return { found: false, document_id: documentId || undefined, ecli: ecli || undefined, geschaeftszahl: geschaeftszahl || undefined, court, message: 'No decision document at that id.', source: SOURCE_CASELAW };
  }
  if (!res.ok) throw new Error(`${UPSTREAM_NAME} returned HTTP ${res.status} fetching the decision text.`);
  const full = extractRisText(await res.text());
  const page = pageText(full, args.text_offset);

  const n = doc ? normalizeJudikatur(doc, court) : undefined;
  return {
    found: true,
    document_id: n?.document_id ?? documentId,
    court,
    geschaeftszahl: n?.geschaeftszahl ?? (geschaeftszahl ? [geschaeftszahl] : []),
    ecli: n?.ecli ?? (ecli || undefined),
    decision_date: n?.decision_date,
    document_type: n?.document_type,
    decision_type: n?.decision_type,
    legal_areas: n?.legal_areas,
    subject_areas: n?.subject_areas,
    headnote: n?.headnote,
    norms: n?.norms,
    text: page.text,
    text_total_length: page.total_length,
    text_has_more: page.has_more,
    text_next_offset: page.next_offset,
    data_as_of: n?.data_as_of,
    source: SOURCE_CASELAW,
  };
}

// ── tool definitions ──────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'at_search_legislation',
    description:
      'Search Austria\'s consolidated federal law (Bundesrecht konsolidiert) by full-text words, by law title, or by law number (Gesetzesnummer). Returns matching provisions (§/Art/Anlage) with their law, citation, in-force dates (in_force_from/in_force_until kept separate from publication), subject index and the official RIS page URL. Pass in_force_on (YYYY-MM-DD) to search the version valid on that date (default: today). Source: Bundeskanzleramt (Austria), Rechtsinformationssystem (RIS), Bundesrecht konsolidiert. Pass gesetzesnummer + a provision number to at_get_provision for the actual text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Full-text search words, e.g. "Datenschutz", "Kündigungsfrist".' },
        titel: { type: 'string', description: 'Words to match in the law\'s title, e.g. "Datenschutzgesetz".' },
        gesetzesnummer: { type: 'string', description: 'Exact RIS law number, e.g. "10001622" (ABGB), if already known.' },
        in_force_on: { type: 'string', description: 'YYYY-MM-DD — restrict to the version in force on this date (default: today).' },
        limit: { type: 'number', description: 'Max results per page, 1-100 (default 20; snapped to RIS page sizes 10/20/50/100).' },
        offset: { type: 'number', description: 'Results to skip for paging (default 0).' },
      },
    },
  },
  {
    name: 'at_get_provision',
    description:
      'Get the original-language (German) text of one provision (§/Article/Annex) of an Austrian federal law, as of a given date. "law" accepts either a Gesetzesnummer (e.g. "10001622") or a title/abbreviation (e.g. "ABGB", "Datenschutzgesetz") — a title is resolved to its law number first. "paragraph" is the §/Art/Anlage number, e.g. "1328a". "as_of" (YYYY-MM-DD, default today) selects the Fassung (version) valid on that date; publication, in-force-from and in-force-until dates come back as separate fields, never folded together. Long provisions are paged via text_offset/text_has_more/text_next_offset, never silently truncated. Source: Bundeskanzleramt (Austria), Rechtsinformationssystem (RIS), Bundesrecht konsolidiert.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        law: { type: 'string', description: 'Gesetzesnummer (e.g. "10001622") or law title/abbreviation (e.g. "ABGB").' },
        paragraph: { type: 'string', description: 'The §/Art/Anlage number, e.g. "1328a", "1", "16".' },
        provision_type: { type: 'string', description: 'One of "Paragraph" (default), "Artikel" or "Anlage".' },
        as_of: { type: 'string', description: 'YYYY-MM-DD — the version in force on this date (default: today).' },
        text_offset: { type: 'number', description: 'Character offset for paging long provision text (default 0).' },
      },
      required: ['law', 'paragraph'],
    },
  },
  {
    name: 'at_get_legislation_document',
    description:
      'Fetch the original-language text of one Bundesrecht konsolidiert document directly by its RIS document id (e.g. "NOR40229402"), as returned by at_search_legislation or at_get_provision — use this to re-fetch a known document\'s text without re-resolving its citation. Paged via text_offset/text_has_more/text_next_offset. Source: Bundeskanzleramt (Austria), Rechtsinformationssystem (RIS), Bundesrecht konsolidiert.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'RIS document id, e.g. "NOR40229402".' },
        text_offset: { type: 'number', description: 'Character offset for paging long text (default 0).' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'at_search_case_law',
    description:
      'Search Austrian case law (Judikatur) by full-text words, Geschäftszahl, and/or decision date range, in exactly one court family: "vfgh" (Verfassungsgerichtshof, constitutional court), "vwgh" (Verwaltungsgerichtshof, supreme administrative court), or "justiz" (ordinary courts — OGH plus OLG/LG/BG). Defaults to decision texts (doc_type "entscheidungstext"); pass doc_type "rechtssatz" to search headnote summaries instead. Returns each decision\'s Geschäftszahl, ECLI, decision date, legal/subject area and headnote. Source: Bundeskanzleramt (Austria), Rechtsinformationssystem (RIS), Judikatur. Pass geschaeftszahl, ecli or document_id to at_get_decision for the full original-language text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        court: { type: 'string', description: 'Required: "vfgh", "vwgh" or "justiz".' },
        query: { type: 'string', description: 'Full-text search words.' },
        geschaeftszahl: { type: 'string', description: 'Case number to search for, e.g. "14Os62/04".' },
        date_from: { type: 'string', description: 'YYYY-MM-DD — earliest decision date.' },
        date_to: { type: 'string', description: 'YYYY-MM-DD — latest decision date.' },
        doc_type: { type: 'string', description: '"entscheidungstext" (default, full decisions) or "rechtssatz" (headnote summaries).' },
        limit: { type: 'number', description: 'Max results per page, 1-100 (default 20; snapped to RIS page sizes 10/20/50/100).' },
        offset: { type: 'number', description: 'Results to skip for paging (default 0).' },
      },
      required: ['court'],
    },
  },
  {
    name: 'at_get_decision',
    description:
      'Get the original-language (German) full text of one Austrian court decision, by Geschäftszahl (with court), by ECLI, or directly by a RIS document_id from at_search_case_law. ECLI and document_id carry the court (VfGH/VwGH/OGH) in their own format and resolve it automatically; a bare geschaeftszahl needs court passed explicitly. Returns decision date, legal/subject area, headnote and norms cited alongside the text, paged via text_offset/text_has_more/text_next_offset. Source: Bundeskanzleramt (Austria), Rechtsinformationssystem (RIS), Judikatur.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'RIS document id from at_search_case_law, e.g. "JJT_20040525_OGH0002_0140OS00062_0400000_000".' },
        ecli: { type: 'string', description: 'European Case Law Identifier, e.g. "ECLI:AT:OGH0002:2004:0140OS00062.04.0525.000".' },
        geschaeftszahl: { type: 'string', description: 'Case number, e.g. "14Os62/04" — requires court.' },
        court: { type: 'string', description: '"vfgh", "vwgh" or "justiz" — required with geschaeftszahl, optional override otherwise.' },
        text_offset: { type: 'number', description: 'Character offset for paging long decision text (default 0).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'at_search_legislation':
      return searchLegislation(args);
    case 'at_get_provision':
      return getProvision(args);
    case 'at_get_legislation_document':
      return getLegislationDocument(args);
    case 'at_search_case_law':
      return searchCaseLaw(args);
    case 'at_get_decision':
      return getDecision(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
