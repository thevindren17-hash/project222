#!/bin/sh

# The voice/LiveKit agent runs as its own separate service (see the
# YourReceptionist/VoiceAI repo) -- this backend only serves WhatsApp/HTTP.
# (A `python agent/main.py start &` branch used to live here gated on
# LIVEKIT_* env vars, but backend/ has no agent/ directory at all, so it
# would have crashed this container's startup the moment those vars were
# ever set here by mistake. Removed rather than left as a footgun.)

# Start FastAPI server — Railway sets $PORT automatically
echo "Starting uvicorn on port ${PORT:-8000}..."
exec uvicorn api.main:app --host 0.0.0.0 --port "${PORT:-8000}"
