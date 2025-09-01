FROM node:24-slim

# --- MS Core Web Fonts (Arial, etc.) ---
# NOTE: You are accepting Microsoft's EULA by installing these fonts.
#       See the license in the freedesktop webfonts bundle.
ARG MS_FONTS_URL=https://www.freedesktop.org/software/fontconfig/webfonts/webfonts.tar.gz

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      firefox-esr \
      libvips-dev \
      cabextract fontconfig wget ca-certificates; \
    \
    # download + unpack the freedesktop webfonts bundle
    mkdir -p /tmp/msfonts && cd /tmp/msfonts; \
    wget -O webfonts.tar.gz "$MS_FONTS_URL"; \
    tar -xzf webfonts.tar.gz; \
    cd msfonts; \
    \
    # extract TTFs from the self-extracting EXEs
    cabextract -q *.exe; \
    \
    # install into a system fonts directory
    mkdir -p /usr/local/share/fonts/msttcore; \
    cp -v *.ttf *.TTF /usr/local/share/fonts/msttcore/; \
    \
    # refresh font cache (needed for headless browsers)
    fc-cache -f -v; \
    \
    # quick sanity check (should print "arial.ttf" path)
    fc-match Arial || true; \
    \
    # clean up
    rm -rf /var/lib/apt/lists/* /tmp/msfonts
    
WORKDIR /app
COPY package*.json ./

# Either let Puppeteer use system Firefox (recommended here)
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/firefox-esr

RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./

# Non-root user with HOME (Firefox cares about profile dirs)
RUN useradd -m -r -U nodejs && chown -R nodejs:nodejs /app
USER nodejs
ENV HOME=/home/nodejs

CMD ["node", "--import", "tsx", "src/run.ts"]
