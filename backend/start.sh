#!/bin/sh
# Start LiveKit agent worker in background
python agent/main.py start &
AGENT_PID=$!

# Start FastAPI server in foreground (Railway routes traffic here)
exec uvicorn api.main:app --host 0.0.0.0 --port "${PORT:-8000}"
