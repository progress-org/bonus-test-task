FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY tests ./tests
COPY jest.config.cjs .

EXPOSE 5000

CMD ["npm", "run", "dev"]
