import { fail, object } from "./model";

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
export type Wait = (ms: number) => Promise<void>;
export const wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
type Policy = "read" | "idempotent" | "create";
const MAX_BYTES = 8 * 1024 * 1024;

export class Http {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly sleep: Wait = wait,
  ) {}

  async json(url: string, init: RequestInit, policy: Policy): Promise<Record<string, unknown>> {
    if (
      url !== "https://api.linear.app/graphql" &&
      !/^https:\/\/slack\.com\/api\/[a-zA-Z.]+$/.test(url)
    ) {
      fail("DESTINATION", "Refused an unexpected API destination.");
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        if (policy === "create")
          fail(
            "UNCERTAIN_CREATE",
            "Creation response was lost. Inspect the pending binding before retrying.",
          );
        if (attempt === 3) fail("NETWORK", "API network request failed after bounded retries.");
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = header !== null && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : 1;
        await response.body?.cancel();
        if (seconds > 60 || attempt === 3) fail("RATE_LIMIT", "Rate limit exceeded; retry later.");
        await this.sleep(Math.max(100, seconds * 1000));
        continue;
      }
      if ([500, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        if (policy === "create")
          fail(
            "UNCERTAIN_CREATE",
            "Server error during creation; inspect the pending binding before retrying.",
          );
        if (attempt === 3) fail("HTTP", "API server failed after bounded retries.");
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok || response.redirected) {
        await response.body?.cancel();
        fail("HTTP", "API request was rejected; check permissions and connectivity.");
      }
      let raw: unknown;
      try {
        const reader = response.body?.getReader();
        if (!reader) fail("SCHEMA", "API response body is missing.");
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) {
            await reader.cancel();
            fail("SCHEMA", "API response exceeded size limit.");
          }
          chunks.push(value);
        }
        const buffer = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.length;
        }
        raw = JSON.parse(new TextDecoder().decode(buffer));
      } catch {
        fail(
          policy === "create" ? "UNCERTAIN_CREATE" : "SCHEMA",
          "Unreadable API response. Creation may have completed if requested.",
        );
      }
      const result = object(raw);
      const errors = result.errors;
      if (
        Array.isArray(errors) &&
        errors.some(
          (e) => object(e).extensions && object(object(e).extensions).code === "RATELIMITED",
        )
      ) {
        if (attempt === 3) fail("RATE_LIMIT", "Linear rate limit exceeded.");
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      return result;
    }
    return fail("RATE_LIMIT", "Retry budget exhausted.");
  }
}
