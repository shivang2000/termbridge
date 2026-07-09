FROM debian:bookworm-slim
# termbridge control image: keep alive + tmux/bash for SessionManager pilot
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash tmux ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]
