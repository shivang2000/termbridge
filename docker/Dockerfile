# termbridge reference image.
#
# Doubles as: (a) the M1 test sandbox — runs unit tests + the real-tmux smoke in
# full isolation from the host tmux; (b) the base for M2's DockerEnvironment
# (per-session tmux via `docker exec`); (c) the fleet runtime that pilots a real
# `claude` TUI on the shared subscription (M4+). node + build tools are present so
# M5's node-pty `tmux attach` bridge can run here too.
FROM oven/bun:1.3.5

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		tmux \
		nodejs \
		npm \
		git \
		curl \
		gnupg \
		ca-certificates \
		procps \
	&& rm -rf /var/lib/apt/lists/*

# GitHub CLI (`gh`) — lets a session push + open a PR itself (M8 delivery) when a
# GH_TOKEN is forwarded in. Installed from the official apt source.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

# Claude Code CLI — sessions pilot this TUI so usage bills against the plan, not
# the API. Credentials are NOT baked in; they arrive via the mounted HOME volume.
RUN npm install -g @anthropic-ai/claude-code

# Default git identity + trust the bind-mounted (host-owned) repo, so in-container
# commits succeed without per-run config. safe.directory '*' avoids git's
# "dubious ownership" refusal on the host-mounted working tree.
RUN git config --global user.name "termbridge-bot" \
	&& git config --global user.email "termbridge-bot@users.noreply.github.com" \
	&& git config --global init.defaultBranch main \
	&& git config --global --add safe.directory '*'

WORKDIR /work

# tmux inside a container has its own server; termbridge additionally pins a
# dedicated `-L termbridge` socket (see core withTmuxSocket) for defence in depth.
CMD ["bash"]
