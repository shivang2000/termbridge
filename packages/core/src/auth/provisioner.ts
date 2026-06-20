// AuthProvisioner — makes the shared subscription credentials available to a
// session by pointing HOME at a persistent credentials volume (spec §7).
//
// The real why: one logged-in `claude` TUI's credentials
// (`~/.claude/.credentials.json`) are persisted on a volume; every session
// reuses them by setting HOME to that volume, so usage bills against the
// subscription plan rather than the metered API.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AuthProvisionerOptions {
	homeDir: string;
}

export class AuthProvisioner {
	readonly homeDir: string;

	constructor(opts: AuthProvisionerOptions) {
		this.homeDir = opts.homeDir;
	}

	/** Ensure `homeDir/.claude` exists so the CLI has somewhere to write/read creds. */
	ensureReady(): void {
		mkdirSync(join(this.homeDir, ".claude"), { recursive: true });
	}

	/**
	 * True iff `homeDir/.claude/.credentials.json` exists, is a regular file,
	 * and is non-empty. Never throws: a missing file (or any stat error)
	 * reports false.
	 */
	isLoggedIn(): boolean {
		const credsPath = join(this.homeDir, ".claude", ".credentials.json");
		try {
			const st = statSync(credsPath);
			return st.isFile() && st.size > 0;
		} catch {
			return false;
		}
	}

	/** Env fragment merged into a session's env so `claude` reads creds from here. */
	homeEnv(): { HOME: string } {
		return { HOME: this.homeDir };
	}
}
