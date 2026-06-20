// Access guards for the unified server. The server is a session-piloting control
// plane (send_text == remote command execution), so the WS and tool API are
// gated by a bearer token + an Origin allowlist (CSWSH defence), and the server
// binds loopback by default (see index.ts). These are pure + unit-tested here.

/** Constant-time string compare (length difference folded in, no early return). */
export function safeEqual(a: string, b: string): boolean {
	const len = Math.max(a.length, b.length);
	let r = a.length ^ b.length;
	for (let i = 0; i < len; i++) {
		r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return r === 0;
}

/** Pull a token from `?token=` or an `Authorization: Bearer …` header. */
export function extractToken(url: string, authHeader?: string | null): string {
	try {
		const q = new URL(url).searchParams.get("token");
		if (q) {
			return q;
		}
	} catch {
		// non-absolute URL — fall through to the header
	}
	if (authHeader) {
		const m = /^Bearer\s+(.+)$/i.exec(authHeader);
		if (m?.[1]) {
			return m[1];
		}
	}
	return "";
}

/**
 * Authorized when no token is configured (caller opted out — e.g. unit tests) or
 * the presented token matches in constant time.
 */
export function isAuthorized(args: {
	token?: string;
	url: string;
	authHeader?: string | null;
}): boolean {
	if (!args.token) {
		return true;
	}
	return safeEqual(extractToken(args.url, args.authHeader), args.token);
}

/**
 * Origin allowlist for the WS upgrade. A request with no Origin (a native client,
 * not a browser) is allowed; a browser Origin must be explicitly allowlisted so a
 * malicious off-origin page cannot hijack the socket.
 */
export function isOriginAllowed(origin: string | null | undefined, allowed: string[]): boolean {
	if (!origin) {
		return true;
	}
	return allowed.includes(origin);
}
