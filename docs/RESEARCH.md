# termbridge — Research

Findings from a deep-research pass (110 sub-agents; 6 angles; 27 sources fetched → 133 claims extracted →
25 verified with 3-vote adversarial verification → **23 confirmed, 2 refuted**). All surviving claims are
sourced to **primary** repositories (READMEs + source). Treat as descriptive/architectural, not
benchmarked.

## TL;DR

> The canonical agent-driveable web terminal is **`xterm.js` (browser) ↔ a PTY backend (`node-pty`) ↔
> WebSocket**. To share **one** session between a human and an automated agent, the field's verified
> answer is **tmux as a shared substrate**: the agent issues tmux CLI commands (`send-keys` /
> `capture-pane`) while a human `tmux attach`es to the same session. In-process command **blocklists are
> bypassable** — real safety requires **container/VM isolation**.

## Verified findings

### Web-terminal stack
- **xterm.js** is the de-facto browser terminal component (VS Code, Hyper, Tabby). Docs show the canonical
  wiring `pty.onData(d => term.write(d)); term.onData(d => pty.write(d))`. — github.com/xtermjs/xterm.js
- **node-pty** (Microsoft) provides `forkpty(3)` bindings; programs behave as if on a real terminal
  (emit ANSI/control sequences). Powers VS Code's terminal. — github.com/microsoft/node-pty
- **ttyd** = turnkey "share your terminal over the web" (C, libwebsockets/libuv, xterm.js, WebGL2). — github.com/tsl0922/ttyd
- **GoTTY** = Go CLI turning a command into a web terminal over WebSocket; **read-only by default**, write
  needs the explicit `-w` flag. yudai/gotty is archived → use forks `sorenisanerd/gotty` / `tty2web`.

### tmux as the shared substrate (the key pattern)
- **GoTTY spawns a separate process per client** → multi-viewer sharing requires wrapping in tmux:
  `gotty tmux new -A -s gotty top`. Establishes: web-terminal server is stateless-per-client; **tmux is the
  shared, persistent substrate**. — github.com/yudai/gotty
- **tmux-mcp** drives tmux purely via `child_process` (`tmux send-keys`, `capture-pane -p`) and **never
  attaches**, so a human `tmux attach` reaches the identical session. Persistence/attach-detach is tmux's,
  not the server's. Command status read via echo-marker-wrapped `$?`. — github.com/nickgnd/tmux-mcp

### MCP terminal-server taxonomy (what to copy)
- **DesktopCommanderMCP**: session-based `start_process` / `interact_with_process` / `read_process_output`
  (with **offset/length pagination** to avoid context overflow) / `force_terminate` / `list_sessions`.
  Supports interactive REPLs/SSH/DBs and in-memory code exec. — github.com/wonderwhy-er/DesktopCommanderMCP
- **iterm-mcp**: minimal 3 tools — `write_to_terminal` / `read_terminal_output` / `send_control_character`
  — over a single shared visible iTerm session (human+agent co-presence; manual interrupt for contention).
  — github.com/ferrislucas/iterm-mcp
- **persistent-shell-mcp**: tmux-based, "Dual-Window Architecture" (exec window vs ui window); distinguishes
  one-shot `execute_command` from long-running `start_process`. (Self-flagged experimental.) — github.com/TNTisdial/persistent-shell-mcp

### Interactive PTY proxies & execution modes
- **pi-interactive-shell**: full PTY via `zigpty` prebuilt binaries (no node-gyp, no tmux); single shared
  session with **human takeover** keybindings (Ctrl+T transfer, Ctrl+B background, Ctrl+G return to agent).
  Four execution modes: **Interactive** (block) / **Hands-free** (poll) / **Dispatch** (wake-on-done) /
  **Monitor** (wake-on-event). — github.com/nicobailon/pi-interactive-shell, npm `zigpty`
- **interminai**: PTY proxy wrapping any interactive CLI; `output` reads the screen as ASCII, `input`
  sends keystrokes/control seqs (`\e`,`\n`). Linux-tested. — github.com/mstsirkin/interminai

### Security (most important)
- **In-process blocklists are bypassable** — DesktopCommander self-documents bypass via symlinks, command
  substitution, absolute paths, code execution (validated by its issue #217). It recommends **Docker for
  complete isolation**. ⇒ Do **not** rely on blocklists; isolate at the container/VM level.

## Refuted claims (do NOT repeat)
1. ttyd's exact `-W/--writable` multiplexing-to-multiple-clients semantics (vote 1-2) — do not assume they
   mirror GoTTY's model.
2. interminai being distributed via the MCP Registry with daemon mode (vote 0-3) — no such distribution.

## Scope gaps / open questions from research
- **Sandboxing detail** (E2B/Firecracker/gVisor/Daytona) was under-covered as standalone verified claims.
  Mitigation: **paperclip already implements E2B/Daytona/Cloudflare providers**, so we port rather than
  re-research. A dedicated follow-up pass is warranted before building `SandboxEnvironment` (M6).
- **No tool implements true multiplexing arbitration** (command queue + write-lock + observer roles).
  Practical answer = tmux co-presence + manual interrupt; we add an *optional* advisory lock.
- **Bridging both halves** (MCP agent-control ↔ browser xterm on the *same* PTY) is exactly the unfilled
  gap termbridge targets — reviewed tools do one half or the other.

## Maturity notes
- Foundational layer (**xterm.js, node-pty, tmux, ttyd**) is mature/stable.
- Young/fast-moving (2024–2026): tmux-mcp, persistent-shell-mcp (experimental), interminai (small),
  pi-interactive-shell. Validate APIs at integration time.

## Source list (primary unless noted)
xtermjs/xterm.js · microsoft/node-pty · tsl0922/ttyd · yudai/gotty · wonderwhy-er/DesktopCommanderMCP ·
ferrislucas/iterm-mcp · nickgnd/tmux-mcp · TNTisdial/persistent-shell-mcp · nicobailon/pi-interactive-shell
· npm/zigpty · mstsirkin/interminai · howardpen9/tmux-bridge-mcp · lox/tmux-mcp-server · (blogs/secondary:
northflank firecracker-vs-gvisor, e2b/daytona/firecracker comparisons, "why your AI agent's shell access is
a security nightmare", tmux-as-runtime-for-ai-agents).
