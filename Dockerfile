# CombsLLM platform image — Deno server + CombsEngine release binaries.
#
#   docker build -t combsllm .
#   docker run -p 8787:8787 -v combs-data:/data combsllm
#
# The engine binaries (combs CLI + FFI dylibs) come from the published
# GitHub Release assets — this image never builds Rust.
FROM denoland/deno:2.9.4

ARG COMBS_VERSION=0.2.0
ARG COMBS_PLATFORM=linux-x86_64

USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/asqrzk/CombsEngine/releases/download/v${COMBS_VERSION}/combs-${COMBS_VERSION}-${COMBS_PLATFORM}.tar.gz" -o /tmp/combs.tgz \
 && mkdir -p /opt/combs && tar -xzf /tmp/combs.tgz -C /opt/combs --strip-components=1 && rm /tmp/combs.tgz \
 && chmod +x /opt/combs/combs || true

WORKDIR /app
COPY . .
RUN deno cache server/main.ts

ENV PORT=8787 \
    HOST=0.0.0.0 \
    COMBSLLM_DATA=/data/app \
    COMBS_HOME=/data/home \
    COMBS_MESH_LIB=/opt/combs/libcombsmesh_ffi.so \
    COMBS_ENGINE_URL=http://engine:8080
VOLUME /data
EXPOSE 8787

# deno task serve = run --allow-net --allow-read --allow-write --allow-env --allow-ffi
CMD ["task", "serve"]
