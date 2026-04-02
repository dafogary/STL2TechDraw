#!/bin/bash

# STL2TechDraw Stop Script
# This script stops the development server for the application

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Stopping STL2TechDraw Services...${NC}"
echo ""

STOPPED=0

# Kill any process listening on port 5173 (Vite default)
if command -v lsof &> /dev/null; then
    PIDS=$(lsof -ti tcp:5173 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo -e "${GREEN}Stopping Vite development server (port 5173)...${NC}"
        kill $PIDS 2>/dev/null && STOPPED=1
    fi
elif command -v fuser &> /dev/null; then
    fuser -k 5173/tcp 2>/dev/null && STOPPED=1
fi

# Also kill any vite processes by name as a fallback
VITE_PIDS=$(pgrep -f "vite" 2>/dev/null)
if [ -n "$VITE_PIDS" ]; then
    echo -e "${GREEN}Stopping Vite process(es)...${NC}"
    kill $VITE_PIDS 2>/dev/null && STOPPED=1
fi

if [ "$STOPPED" -eq 1 ]; then
    echo -e "${GREEN}Services stopped successfully.${NC}"
else
    echo -e "${YELLOW}No running STL2TechDraw services found.${NC}"
fi
