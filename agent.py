import os
import re
import base64
import typing
import json
import requests
import threading
from flask import Flask, request, Response
from dotenv import load_dotenv
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession, cli, metrics
from livekit.agents.telemetry import set_tracer_provider
from livekit.agents.voice import MetricsCollectedEvent
from livekit.plugins import elevenlabs, openai, trugen, silero, deepgram

load_dotenv()

# --- OPENCLAW SESSION PROXY (Stateless / Mega-Token) ---
app = Flask(__name__)

@app.route('/v1/chat/completions', methods=['POST'])
def chat_proxy():
    try:
        data = request.get_json()
        messages = data.get('messages', [])

        auth_header = request.headers.get("Authorization", "")
        token_str = auth_header.replace("Bearer ", "")

        if "|" not in token_str:
            print("[PROXY] ✗ Invalid Mega-Token format")
            return {"error": "Missing x-openclaw-url. Check your Mega-Token."}, 400

        parts = token_str.split("|")
        target_url = parts[0]
        gate_token = parts[1]
        sess_key   = parts[2]

        print(f"\n[PROXY] → {target_url}  session={sess_key}")

        new_messages = []
        for msg in reversed(messages):
            if msg.get('role') == 'user':
                new_messages.insert(0, msg)
            else:
                break

        if not new_messages:
            return {"error": "No user message found"}, 400

        headers = {
            "Authorization": f"Bearer {gate_token}",
            "x-openclaw-session-key": sess_key,
            "x-openclaw-agent-id": "main",
            "ngrok-skip-browser-warning": "true"
        }

        resp = requests.post(
            f"{target_url}/v1/chat/completions",
            headers=headers,
            json={"model": "main", "messages": new_messages, "stream": data.get("stream", True)},
            stream=True,
            timeout=30
        )

        def generate():
            for chunk in resp.iter_content(chunk_size=1024):
                yield chunk

        return Response(generate(), resp.status_code, {"Content-Type": "text/event-stream"})

    except Exception as e:
        print(f"[PROXY] Error: {e}")
        return {"error": str(e)}, 500

def run_proxy():
    try:
        print("--- OpenClaw Proxy Active (port 4041) ---")
        app.run(host='0.0.0.0', port=4041, debug=False, use_reloader=False)
    except OSError as e:
        if "Address already in use" in str(e) or "already in use" in str(e).lower():
            # Another worker process already holds port 4041 — that's fine.
            # Requests to localhost:4041 will be served by that process.
            print("[PROXY] Port 4041 already bound by another worker — reusing.")
        else:
            raise

threading.Thread(target=run_proxy, daemon=True).start()


# ---------------------------------------------------------------------------
# CONFIG RESOLUTION — supports website, URL share, and email dispatch
# ---------------------------------------------------------------------------

# Bot-name prefix (from email addresses like "amansbot-...@agent.truhire.ai")
# Maps the local-part prefix → avatar ID
EMAIL_BOT_AVATAR_MAP: dict[str, str] = {
    "amansbot":    "0f160301",  # Aman  (male)
    "jasonbot":    "182b03e8",  # Jason (male)
    "sameerbot":   "05a001fc",  # Sameer (male)
    "mikebot":     "be5b2ce0",  # Mike  (male)
    "johnnybot":   "03ae0187",  # Johnny (male)
    "amanbot":     "0f160301",  # Aman  (male) alias
    "alexbot":     "13550375",  # Alex  (male)
    "amirbot":     "18c4043e",  # Amir  (male)
    "akbarsbot":   "48d778c9",  # Akbar (male)
    "akbarbot":    "48d778c9",  # Akbar (male) alias
    "jessicabot":  "1a640442",  # Jessica (female)
    "lisasbot":    "1a640442",  # Lisa  (female)
    "lisabot":     "1a640442",  # Lisa  (female) alias
    "cathybot":    "1a640442",  # Cathy (female)
    "sofiabot":    "1a640442",  # Sofia (female)
    "lucybot":     "1a640442",  # Lucy  (female)
    "kiarabot":    "1a640442",  # Kiara (female)
    "jenniferbot": "1a640442",  # Jennifer (female)
    "priyabot":    "1a640442",  # Priya (female)
    "chloebot":    "1a640442",  # Chloe (female)
    "mishabot":    "1a640442",  # Misha (female)
    "alliebot":    "1a640442",  # Allie (female)
}

MALE_AVATAR_IDS = {
    "182b03e8", "05a001fc", "be5b2ce0", "03ae0187",
    "1fa504ff", "0f160301", "13550375", "48d778c9", "18c4043e"
}

DEFAULT_AVATAR_ID = "1a640442"  # Lisa


def _fetch_config_from_backend(email: str) -> dict | None:
    """
    Fetches agent configuration dynamically from the Next.js backend.
    """
    try:
        # Use FRONTEND_URL from env strictly
        base_url = os.getenv("FRONTEND_URL", "").rstrip("/")
        if not base_url:
            print("[SESSION] ✗ FRONTEND_URL not set in .env. Skipping dynamic lookup.")
            return None
            
        api_url = f"{base_url}/api/agents/config?email={email}"
        
        print(f"[SESSION] Attempting dynamic config lookup for: {email}")
        response = requests.get(api_url, timeout=5)
        
        if response.status_code == 200:
            config = response.json()
            if isinstance(config, dict) and config.get("openclawUrl"):
                print(f"[SESSION] ✓ Dynamic config successfully fetched for: {email}")
                return config
        else:
            print(f"[SESSION] ✗ Backend lookup failed (status={response.status_code}) for: {email}")
    except Exception as e:
        print(f"[SESSION] ✗ Error during backend lookup: {e}")
    return None


def _parse_avatar_from_room_name(room_name: str) -> str | None:
    """
    Infers avatar ID from an email-dispatched room name.
    Example Room:  sofiasbot-2026-03-18-1734clawdfaceai
    """
    if not room_name:
        return None
    local = room_name.lower().split("@")[0]
    for prefix, avatar_id in EMAIL_BOT_AVATAR_MAP.items():
        if local.startswith(prefix):
            return avatar_id
    return None


def resolve_config(ctx: agents.JobContext) -> tuple[dict, str]:
    """
    Priority-based config resolution:
      1. ctx.job.metadata  → email dispatch / API dispatch
      2. ctx.room.metadata → room-level config
      3. participant metadata → website / URL share
      4. Room name parsing  → avatar inference only (logs warning if config missing)
    Returns (config_dict, connection_type)
    """
    # Priority 1: Job metadata (email dispatch / explicit API dispatch)
    try:
        if ctx.job and ctx.job.metadata:
            job_cfg = json.loads(ctx.job.metadata)
            if isinstance(job_cfg, dict) and job_cfg.get("openclawUrl"):
                print("[SESSION] ✓ Config from job metadata (email/API dispatch)")
                return job_cfg, "email_dispatch"
    except Exception:
        pass

    # Priority 2: Room metadata
    try:
        if ctx.room.metadata:
            room_cfg = json.loads(ctx.room.metadata)
            if isinstance(room_cfg, dict) and room_cfg.get("openclawUrl"):
                print("[SESSION] ✓ Config from room metadata")
                return room_cfg, "room_metadata"
    except Exception:
        pass

    # Priority 3: Participant metadata (website / URL share)
    for p in ctx.room.remote_participants.values():
        try:
            if p.metadata:
                p_cfg = json.loads(p.metadata)
                if isinstance(p_cfg, dict) and p_cfg.get("openclawUrl"):
                    session_key = p_cfg.get("sessionKey", "")
                    conn_type = "url_share" if session_key.startswith("session-") else "website"
                    print(f"[SESSION] ✓ Config from participant metadata ({conn_type})")
                    return p_cfg, conn_type
        except Exception:
            pass

    # Priority 4: Dynamic Backend Lookup (The "Zero-Config SIP" solution)
    # If no config is in metadata, we check if the room name identifies a specific bot.
    # Ex: room-name = "sofiasbot-2026-03-18-1734clawdfaceai"
    room_id = ctx.room.name
    if room_id and not room_id.startswith("room-"): # ignore generic IDs
        # Try full lookup first (assuming room name is the email or the local part)
        email = room_id
        if "@" not in email:
            email = f"{email}@agent.truhire.ai"
        
        backend_cfg = _fetch_config_from_backend(email)
        if backend_cfg:
            print(f"[SESSION] ✓ Config dynamically resolved from backend for: {email}")
            return backend_cfg, "email_dispatch"

    # Priority 5: Simple room name → avatar inference (legacy fallback)
    inferred_avatar = _parse_avatar_from_room_name(ctx.room.name)
    if inferred_avatar:
         print(f"[SESSION] ✗ Only avatar inferred for {ctx.room.name}, no OpenClaw config found.")

    print("[SESSION] ✗ No config found in any source (metadata or backend)")
    return {}, "unknown"


# ---------------------------------------------------------------------------
# TRACING SETUP (Langfuse via OTLP — official LiveKit pattern)
# ---------------------------------------------------------------------------
# Per the official LiveKit example (github.com/livekit/agents/examples/voice_agents/langfuse_trace.py)
# setup_langfuse() is called INSIDE the session entrypoint, once per session.
# Per-session metadata (session.id, user.id, tags) is passed via the metadata dict
# to set_tracer_provider() — this tags ALL LiveKit OTel spans for that session.

def setup_langfuse(
    metadata: dict | None = None,
    *,
    host: str | None = None,
    public_key: str | None = None,
    secret_key: str | None = None,
) -> TracerProvider:
    """
    Initializes a TracerProvider with Langfuse as the OTLP exporter.
    Called once per agent session. LiveKit's built-in OTel instrumentation
    auto-traces all STT, LLM, TTS, VAD spans through this provider.
    """
    public_key = public_key or os.getenv("LANGFUSE_PUBLIC_KEY")
    secret_key = secret_key or os.getenv("LANGFUSE_SECRET_KEY")
    host = host or os.getenv("LANGFUSE_HOST") or os.getenv("LANGFUSE_BASE_URL")

    if not public_key or not secret_key or not host:
        raise ValueError(
            "LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_HOST must be set"
        )

    # Build OTLP auth header for Langfuse (Basic auth = base64(pk:sk))
    langfuse_auth = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
    os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"{host.rstrip('/')}/api/public/otel"
    os.environ["OTEL_EXPORTER_OTLP_HEADERS"]  = f"Authorization=Basic {langfuse_auth}"

    trace_provider = TracerProvider()
    trace_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    # Register with LiveKit — this tags all spans with session metadata
    set_tracer_provider(trace_provider, metadata=metadata)

    return trace_provider


# ---------------------------------------------------------------------------
# LIVEKIT AGENT
# ---------------------------------------------------------------------------
AGENT_INSTRUCTIONS = (
    "You are a helpful AI assistant. Keep responses to 2-4 short spoken sentences. "
    "Be conversational. Never use markdown, bullet points, or formatting."
)

class MyAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=AGENT_INSTRUCTIONS)


server = AgentServer()

@server.rtc_session()
async def my_agent(ctx: agents.JobContext):
    await ctx.connect()

    # --- Participant metadata retry loop ---
    # IMPORTANT: In a deployed environment, the agent may join the room before the
    # participant's metadata has propagated. We poll for up to 15 seconds so the
    # frontend has time to send participant metadata (contains openclawUrl etc.).
    # This fixes the "No config found" / Loading spinner issue on LiveKit Cloud.
    import asyncio
    config: dict = {}
    connection_type = "unknown"
    POLL_INTERVAL = 0.5   # seconds between retries
    MAX_WAIT    = 15.0    # maximum seconds to wait for participant metadata

    deadline = asyncio.get_event_loop().time() + MAX_WAIT
    while asyncio.get_event_loop().time() < deadline:
        config, connection_type = resolve_config(ctx)
        if config:  # non-empty → we have a valid config
            break
        print(f"[SESSION] Waiting for participant metadata... ({connection_type})")
        await asyncio.sleep(POLL_INTERVAL)

    url   = config.get("openclawUrl", "").strip()
    token = config.get("gatewayToken", "")
    key   = config.get("sessionKey", "")

    if not url or not token or not key:
        print(f"[SESSION] ✗ Incomplete config (type={connection_type}): {config}")
        return

    # 2. Determine avatar and voice
    avatar_id = (
        config.get("avatarId")
        or _parse_avatar_from_room_name(ctx.room.name)
        or os.getenv("TRUGEN_AVATAR_ID")
        or DEFAULT_AVATAR_ID
    )
    voice_id = "CwhRBWXzGAHq8TQ4Fs17" if avatar_id in MALE_AVATAR_IDS else "FGY2WhTYpPnrIDTdsKH5"
    print(f"[SESSION] Avatar: {avatar_id} | Voice: {voice_id} | Source: {connection_type}")

    # 3. Setup Langfuse tracing (per-session, per official LiveKit pattern)
    # All session metadata is attached via set_tracer_provider() → tags every span
    # for this session with the right session.id, user.id, and tags.
    trace_provider = setup_langfuse(
        metadata={
            # Core Langfuse fields (recognised by Langfuse dashboard)
            "langfuse.session.id": ctx.room.name,
            "langfuse.user.id":    key,
            "langfuse.tags":       json.dumps([
                "production",
                "voice-agent",
                f"source:{connection_type}",   # website | url_share | email_dispatch
                f"avatar:{avatar_id}",
            ]),
            "langfuse.version": "2.0.0",
            # Custom metadata (visible in trace detail panel)
            "connection.type": connection_type,
            "avatar.id":       avatar_id,
            "room.name":       ctx.room.name,
        }
    )

    # Flush all pending spans when session ends (disconnect, crash, or normal exit)
    async def flush_trace():
        try:
            trace_provider.force_flush(timeout_millis=10_000)
        except Exception as e:
            print(f"[TRACE] Flush error (non-fatal): {e}")

    ctx.add_shutdown_callback(flush_trace)

    # 4. Build LLM via Mega-Token (URL | gateway token | session key)
    mega_token = f"{url}|{token}|{key}"
    openclaw_llm = openai.LLM(
        model="main",
        base_url="http://localhost:4041/v1",
        api_key=mega_token,
    )

    # 5. AgentSession — STT/LLM/TTS/VAD spans auto-traced via LiveKit OTel → Langfuse
    session = AgentSession(
        stt=deepgram.STTv2(
            model="flux-general-en",
            eager_eot_threshold=0.4,
        ),
        vad=silero.VAD.load(),
        llm=openclaw_llm,
        tts=elevenlabs.TTS(
            voice_id=voice_id,
            model="eleven_flash_v2_5",
        ),
    )

    # 6. Metrics hook — surfaces STT/LLM/TTS latency numbers in Langfuse
    @session.on("metrics_collected")
    def on_metrics(ev: MetricsCollectedEvent):
        metrics.log_metrics(ev.metrics)

    # 7. Transcript + state logging
    @session.on("user_input_transcribed")
    def on_user_speech(ev: agents.UserInputTranscribedEvent):
        if ev.transcript:
            print(f"[STT] {ev.transcript}")

    @session.on("agent_state_changed")
    def on_agent_state(state: typing.Any):
        print(f"[AGENT] State → {state}")

    # 8. Start avatar + agent session
    try:
        trugen_avatar = trugen.AvatarSession(avatar_id=avatar_id)
        await trugen_avatar.start(session, room=ctx.room)
        await session.start(room=ctx.room, agent=MyAgent())
        session.say("Hello! Let's get started.")
    except Exception as e:
        print(f"[SESSION] ✗ Fatal error: {e}")
        raise


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "download-files":
        print("Pre-downloading models...")
        silero.VAD.load()
        sys.exit(0)
    agents.cli.run_app(server)