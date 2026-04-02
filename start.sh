#!/bin/bash

# STL2TechDraw Startup Script
# This script starts the development server for the application

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting STL2TechDraw Services...${NC}"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Error: Node.js is not installed. Please install Node.js first.${NC}"
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo -e "${YELLOW}Error: npm is not installed. Please install npm first.${NC}"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Dependencies not found. Installing...${NC}"
    npm install
    echo -e "${GREEN}Dependencies installed successfully!${NC}"
    echo ""
fi

# Start the Vite development server
echo -e "${GREEN}Starting Vite development server...${NC}"
echo -e "${GREEN}The application will be available at http://localhost:5173${NC}"
echo ""

npm run dev
