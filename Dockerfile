FROM node:18-slim

# Install latest chrome dev package, fonts, and FFMPEG for 15-sec screen recording
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 ffmpeg \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

# ==========================================
# FIX: SYSTEM ENVIRONMENT VARIABLES
# ==========================================
# Puppeteer ko bata rahe hain ke apni default downloading skip kare
ENV PUPPETEER_SKIP_DOWNLOAD=true
# Puppeteer ko installed Chrome ka path de rahe hain
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

RUN npm install
COPY . .

# Railway port
EXPOSE 3000

CMD ["npm", "start"]
