# GitOrange Actions runner image: what `runs-on: ubuntu-latest` jobs get.
# Debian trixie with Node.js 24 (the base of Cloudflare's managed debian-trixie image), plus git
# for checkout and the build tools most projects expect. Keep it lean: every MB here is paid
# once per host on the first job's cold start.
FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git git-lfs ca-certificates curl wget jq unzip zip xz-utils \
    python3 python3-pip build-essential openssh-client procps \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
