# Use the latest Node.js 18 version
FROM node:18-alpine

# Install required dependencies, including Python and pip
RUN apk add --no-cache python3 py3-pip make g++ 

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Expose the necessary ports (adjust if needed)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]