#!/bin/sh

# Only start LiveKit agent worker if credentials are configured
if [ -n "$LIVEKIT_URL" ] && [ -n "$LIVEKIT_API_KEY" ] && [ -n "$LIVEKIT_API_SECRET" ]; then
  echo "Starting LiveKit agent worker..."
  python agent/main.py start &
  echo "LiveKit worker started (PID $!)"
else
  echo "LiveKit credentials not set — skipping agent worker (WhatsApp still works)"
fi

# Start FastAPI server — Railway sets $PORT automatically
echo "Starting uvicorn on port ${PORT:-8000}..."
exec uvicorn api.main:app --host 0.0.0.0 --port "${PORT:-8000}"
