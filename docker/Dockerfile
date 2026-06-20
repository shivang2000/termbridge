# termbridge reference image.
#
# Doubles as: (a) the M1 test sandbox — runs unit tests + the real-tmux smoke in
# full isolation from the host tmux; (b) the base for M2's DockerEnvironment
# (per-session tmux via `docker exec`). node + build tools are present so M5's
# node-pty `tmux attach` bridge can run here too.
FROM oven/bun:1.3.5

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		tmux \
		nodejs \
		ca-certificates \
		procps \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /work

# tmux inside a container has its own server; termbridge additionally pins a
# dedicated `-L termbridge` socket (see core withTmuxSocket) for defence in depth.
CMD ["bash"]
