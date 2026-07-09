// Lean termbridge web client: an xterm.js terminal wired to the session WS, plus
// a small EventCard area for recognizer events (OAuth URL, permission, login).
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

interface RecognizedEvent {
	kind: string;
	data: Record<string, unknown>;
	suggestedKeys: string[];
}

const sessionId = new URLSearchParams(window.location.search).get("session") ?? "";
const termEl = document.getElementById("term");
const eventsEl = document.getElementById("events");
const activityEl = document.getElementById("activity");

const term = new Terminal({ convertEol: false, fontSize: 13, cursorBlink: true, scrollback: 5000 });
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());
if (termEl) {
	term.open(termEl);
}
const tryFit = () => {
	try {
		fit.fit();
	} catch {
		/* layout not ready */
	}
};
tryFit();

const proto = window.location.protocol === "https:" ? "wss" : "ws";
// Forward the bearer token to the WS upgrade (the server token-gates /ws).
const token = new URLSearchParams(window.location.search).get("token") ?? "";
const tokenQs = token ? `?token=${encodeURIComponent(token)}` : "";
const ws = new WebSocket(`${proto}://${window.location.host}/ws/${sessionId}${tokenQs}`);

function send(data: string): void {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "stdin", data }));
	}
}

ws.addEventListener("message", (e) => {
	let m: {
		type?: string;
		screen?: string;
		data?: string;
		message?: string;
		events?: RecognizedEvent[];
	};
	try {
		m = JSON.parse(String(e.data));
	} catch {
		return;
	}
	if (m.type === "init") {
		term.write(String(m.screen ?? ""));
	} else if (m.type === "stdout") {
		term.write(String(m.data ?? ""));
	} else if (m.type === "event") {
		// Route live claude-activity to the status bar; actionable prompts to cards
		// (so a progress tick never clobbers a pending permission/login card).
		const evs = m.events ?? [];
		const activity = evs.filter((ev) => ev.kind === "claude-activity");
		const prompts = evs.filter((ev) => ev.kind !== "claude-activity");
		const latest = activity[activity.length - 1];
		if (latest) {
			renderActivity(latest);
		}
		if (prompts.length > 0) {
			renderEvents(prompts);
		}
	} else if (m.type === "error") {
		term.write(`\r\n[termbridge] ${String(m.message ?? "")}\r\n`);
	}
});

term.onData(send);

function sendResize(): void {
	tryFit();
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
	}
}

// On connect, fit to the browser and resize the tmux window to match so the
// pane redraws at the viewport width (avoids ragged wrapping from the open size).
ws.addEventListener("open", () => setTimeout(sendResize, 50));
window.addEventListener("resize", sendResize);

const PHASE_META: Record<string, { icon: string; cls: string; label: string }> = {
	tool: { icon: "🔧", cls: "live", label: "running tool" },
	editing: { icon: "✏️", cls: "live", label: "editing" },
	thinking: { icon: "…", cls: "live", label: "thinking" },
	awaiting_input: { icon: "⏳", cls: "wait", label: "awaiting input" },
	idle: { icon: "✓", cls: "", label: "idle" },
};

/** Render the latest claude-activity phase into the live status bar. */
function renderActivity(ev: RecognizedEvent): void {
	if (!activityEl) {
		return;
	}
	const phase = typeof ev.data.phase === "string" ? ev.data.phase : "working";
	const tool = typeof ev.data.tool === "string" ? ev.data.tool : "";
	const file = typeof ev.data.file === "string" ? ev.data.file : "";
	const meta = PHASE_META[phase] ?? { icon: "·", cls: "", label: phase };
	const what = tool ? ` ${tool}${file ? `(${file})` : ""}` : "";
	const span = document.createElement("span");
	if (meta.cls) {
		span.className = meta.cls;
	}
	span.textContent = `${meta.icon} ${meta.label}${what}`;
	activityEl.replaceChildren(span);
}

function renderEvents(events: RecognizedEvent[]): void {
	if (!eventsEl) {
		return;
	}
	eventsEl.replaceChildren();
	for (const ev of events) {
		const card = document.createElement("div");
		card.className = "card";
		const url = typeof ev.data.url === "string" ? ev.data.url : null;
		if (ev.kind === "oauth-url" && url) {
			const a = document.createElement("a");
			a.href = url;
			a.target = "_blank";
			a.rel = "noreferrer";
			a.textContent = `Sign in: ${url}`;
			const input = document.createElement("input");
			input.placeholder = "paste the code, press Enter";
			input.addEventListener("keydown", (k) => {
				if (k.key === "Enter" && input.value.trim().length > 0) {
					send(`${input.value.trim()}\r`);
					input.value = "";
				}
			});
			card.append(a, input);
		} else if (ev.kind === "needs_login") {
			card.textContent = "Not logged in — run `claude` in the terminal to start the login flow.";
		} else {
			const question = ev.data.question ?? ev.data.prompt ?? ev.kind;
			card.textContent = `${ev.kind}: ${String(question)}`;
			for (const key of ev.suggestedKeys) {
				const b = document.createElement("button");
				b.textContent = key;
				b.addEventListener("click", () => send(key));
				card.append(b);
			}
		}
		eventsEl.append(card);
	}
}

// --- fleet session inventory (P2.3) -----------------------------------------

interface SessionRow {
	id: string;
	name: string;
	env: string;
	state: string;
	holder: string;
	status: string;
	lastActivityAt: number;
}

interface SessionsResponse {
	ok: boolean;
	maxSessions: number;
	count: number;
	sessions: SessionRow[];
}

const sessionsListEl = document.getElementById("sessions-list");
const sessionsCapEl = document.getElementById("sessions-cap");

function statusBadgeClass(status: string): string {
	if (status === "human-takeover") return "human";
	if (status === "driving") return "driving";
	return "idle";
}

function renderSessionList(data: SessionsResponse): void {
	if (sessionsCapEl) {
		sessionsCapEl.textContent = `${data.count}/${data.maxSessions}`;
	}
	if (!sessionsListEl) return;
	if (data.sessions.length === 0) {
		sessionsListEl.replaceChildren();
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = "no sessions";
		sessionsListEl.append(empty);
		return;
	}
	sessionsListEl.replaceChildren();
	for (const s of data.sessions) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = `row${s.id === sessionId ? " active" : ""}`;
		const title = document.createElement("div");
		title.textContent = s.name || s.id;
		const meta = document.createElement("div");
		meta.className = "meta";
		const st = document.createElement("span");
		st.className = `badge ${statusBadgeClass(s.status)}`;
		st.textContent = s.status;
		const env = document.createElement("span");
		env.className = "badge";
		env.textContent = s.env;
		const holder = document.createElement("span");
		holder.className = `badge${s.holder === "human" ? " human" : ""}`;
		holder.textContent = s.holder;
		meta.append(st, env, holder);
		btn.append(title, meta);
		btn.addEventListener("click", () => {
			if (s.id === sessionId) return;
			const u = new URL(window.location.href);
			u.searchParams.set("session", s.id);
			if (token) u.searchParams.set("token", token);
			window.location.href = u.toString();
		});
		sessionsListEl.append(btn);
	}
}

async function refreshSessions(): Promise<void> {
	try {
		const headers: HeadersInit = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const qs = token ? `?token=${encodeURIComponent(token)}` : "";
		const res = await fetch(`/api/sessions${qs}`, { headers });
		if (!res.ok) return;
		const data = (await res.json()) as SessionsResponse;
		if (data.ok) renderSessionList(data);
	} catch {
		/* offline / unauthorized — leave last paint */
	}
}

void refreshSessions();
setInterval(() => void refreshSessions(), 2000);
