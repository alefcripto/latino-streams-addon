FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY index.js ./
ENV PORT=7000
EXPOSE 7000
CMD ["node", "index.js"]
