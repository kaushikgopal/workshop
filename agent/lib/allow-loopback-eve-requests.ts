import type { AuthFn } from "eve/channels/auth";

/**
 * Allows local clients on the built loopback service without opening deployed
 * Eve channels to unauthenticated requests.
 */
export function allowLoopbackEveRequests(
  enabled = process.env.WORKSHOP_LOCAL_EVE_AUTH === "1",
): AuthFn<Request> {
  return (request) => {
    if (!enabled) return null;

    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      return null;
    }
    if (!isLoopbackHostname(target.hostname)) return null;

    const origin = request.headers.get("origin");
    if (origin !== null) {
      let source: URL;
      try {
        source = new URL(origin);
      } catch {
        return null;
      }
      if (source.origin !== target.origin) return null;
    }

    return {
      authenticator: "workshop-loopback",
      attributes: {},
      principalId: "workshop:local",
      principalType: "service",
    };
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}
