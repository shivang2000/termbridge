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
		renderEvents(m.events ?? []);
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
