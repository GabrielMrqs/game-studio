FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /project
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY AGENTS.md AUDIT.md VISION.md README.md OPEN_ISSUES.md OPERATIONS.md ./
COPY .ai/cezar/workflows/ .ai/cezar/workflows/
COPY studio/ studio/
COPY game/ game/
RUN printf 'node_modules/\n.godot/\n.ai/cezar/runs/\n.ai/cezar/worktrees/\n.ai/cezar/runs.json\n' > .gitignore \
    && git init -b main && git config user.name 'Studio Fixture' \
    && git config user.email 'studio@example.invalid' && git add . \
    && git commit -m 'Initialize isolated studio fixture' \
    && mkdir -p /data /ideas /home/node/.cezar \
    && chown -R node:node /project /data /ideas /home/node/.cezar
USER node
ENV HOME=/home/node CEZ_HOME=/home/node/.cezar CEZ_DRY_RUN=1 CEZ_TELEMETRY=0 CEZ_RELAY=0
CMD ["sh", "-c", "node studio/startup-guard.mjs && exec ./node_modules/.bin/cezar --no-open --bind-host 127.0.0.1 --port 14321"]
