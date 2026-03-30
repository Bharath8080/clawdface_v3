import os
import json
import asyncio
import base64
import requests
import threading
import typing
import logging
from flask import Flask, request, Response
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession, cli, metrics, APIConnectOptions
from livekit.agents.telemetry import set_tracer_provider
from livekit.agents.voice import MetricsCollectedEvent
from livekit.agents.voice.agent_session import SessionConnectOptions
from livekit.plugins import elevenlabs, openai, trugen, silero, deepgram

# Import Recall.ai STT from local recall.py
from recall import RecallAIDirectSTT

# OTEL for Langfuse
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace.export import BatchSpanProcessor

load_dotenv()
logger = logging.getLogger("trugen-agent")

# ---------------------------------------------------------------------------
# OPENCLAW SESSION PROXY (Port 4041)
# ---------------------------------------------------------------------------
app = Flask(__name__)

@app.route('/v1/chat/completions', methods=['POST'])
def chat_proxy():
    try:
        data = request.get_json()
        messages = data.get('messages', [])

        auth_header = request.headers.get("Authorization", "")
        token_str = auth_header.replace("Bearer ", "")
       
        if "|" not in token_str:
             print("[PROXY] \u2717 Invalid Mega-Token format")
             return {"error": "Invalid token format. URL|TOKEN|KEY expected."}, 400

        parts = token_str.split("|")
        target_url = parts[0]
        gate_token = parts[1]
        sess_key   = parts[2]

        print(f"[PROXY] \u2192 {target_url} session={sess_key}")

        # Filter out system messages and limit history
        new_messages = [m for m in messages if m.get("role") != "system"][-10:]

        if not new_messages:
            return {"error": "No messages to forward"}, 400

        headers = {
            "Authorization": f"Bearer {gate_token}",
            "x-openclaw-session-key": sess_key,
            "x-openclaw-agent-id": "main",
            "ngrok-skip-browser-warning": "true"
        }

        resp = requests.post(
            f"{target_url}/v1/chat/completions",
            headers=headers,
            json={"model": "openclaw", "messages": new_messages, "stream": data.get("stream", True)},
            stream=True,
            timeout=None
        )

        def generate():
            for chunk in resp.iter_content(chunk_size=None):
                if chunk:
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
        if "already in use" in str(e).lower():
            print("[PROXY] Port 4041 already bound - reusing instance.")
        else:
            raise

threading.Thread(target=run_proxy, daemon=True).start()

# ---------------------------------------------------------------------------
# CONFIG RESOLUTION
# ---------------------------------------------------------------------------
EMAIL_BOT_AVATAR_MAP = {
    "amansbot": "0f160301", "jasonbot": "182b03e8", "sameerbot": "05a001fc",
    "mikebot": "be5b2ce0", "johnnybot": "03ae0187", "amanbot": "0f160301",
    "alexbot": "13550375", "amirbot": "18c4043e", "akbarsbot": "48d778c9",
    "akbarbot": "48d778c9", "jessicabot": "1a640442", "lisasbot": "1a640442",
    "lisabot": "1a640442", "cathybot": "1a640442", "sofiabot": "1a640442",
    "lucybot": "1a640442", "kiarabot": "1a640442", "jenniferbot": "1a640442",
    "priyabot": "1a640442", "chloebot": "1a640442", "mishabot": "1a640442",
    "alliebot": "1a640442"
}

MALE_AVATAR_IDS = {
    "182b03e8", "05a001fc", "be5b2ce0", "03ae0187",
    "1fa504ff", "0f160301", "13550375", "48d778c9", "18c4043e"
}

DEFAULT_AVATAR_ID = "1a640442"

def resolve_config(ctx: agents.JobContext) -> tuple[dict, str]:
    # 1. Job Metadata
    try:
        if ctx.job and ctx.job.metadata:
            cfg = json.loads(ctx.job.metadata)
            if cfg.get("openclawUrl"):
                return cfg, "email_dispatch"
    except: pass

    # 2. Room Metadata
    try:
        if ctx.room.metadata:
            cfg = json.loads(ctx.room.metadata)
            if cfg.get("openclawUrl"):
                return cfg, "room_metadata"
    except: pass

    # 3. Participant Metadata
    for p in ctx.room.remote_participants.values():
        try:
            if p.metadata:
                cfg = json.loads(p.metadata)
                if cfg.get("openclawUrl"):
                    type = "url_share" if str(cfg.get("sessionKey", "")).startswith("session-") else "website"
                    return cfg, type
        except: pass

    # 4. Backend Dynamic Lookup (by Room Name/Email)
    room_id = ctx.room.name
    if room_id and not room_id.startswith("room-"):
        email = room_id if "@" in room_id else f"{room_id}@agent.truhire.ai"
        try:
            base_url = os.getenv("FRONTEND_URL", "").rstrip("/")
            if base_url:
                resp = requests.get(f"{base_url}/api/agents/config?email={email}", timeout=5)
                if resp.status_code == 200:
                    cfg = resp.json()
                    if cfg.get("openclawUrl"):
                        return cfg, "email_dispatch"
        except: pass

    return {}, "unknown"

def setup_langfuse(metadata: dict):
    pub = os.getenv("LANGFUSE_PUBLIC_KEY")
    sec = os.getenv("LANGFUSE_SECRET_KEY")
    host = os.getenv("LANGFUSE_HOST") or os.getenv("LANGFUSE_BASE_URL")

    if not all([pub, sec, host]):
        print("[LANGFUSE] Missing credentials, tracing disabled.")
        return None

    auth = base64.b64encode(f"{pub}:{sec}".encode()).decode()
    os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"{host.rstrip('/')}/api/public/otel"
    os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = f"Authorization=Basic {auth}"

    tp = TracerProvider()
    tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    set_tracer_provider(tp, metadata=metadata)
    return tp

# ---------------------------------------------------------------------------
# AGENT DEFINITION
# ---------------------------------------------------------------------------
class MyAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=(
            "You are a helpful AI assistant. Keep responses to 2-4 short spoken sentences. "
            "Be conversational. Never use markdown, bullet points, or formatting."
        ))

server = AgentServer()

@server.rtc_session(agent_name="clawdface")
async def my_agent(ctx: agents.JobContext):
    await ctx.connect()

    # Resolve config with retry
    config, connection_type = {}, "unknown"
    for _ in range(30):
        config, connection_type = resolve_config(ctx)
        if config: break
        await asyncio.sleep(0.5)

    if not config:
        print(f"[SESSION] \u2717 Failed to resolve config for room {ctx.room.name}")
        return

    # Extract config
    url = config.get("openclawUrl", "").strip()
    token = config.get("gatewayToken", "")
    key = config.get("sessionKey", "")
    avatar_id = config.get("avatarId") or os.getenv("TRUGEN_AVATAR_ID") or DEFAULT_AVATAR_ID
    voice_id = "CwhRBWXzGAHq8TQ4Fs17" if avatar_id in MALE_AVATAR_IDS else "FGY2WhTYpPnrIDTdsKH5"

    print(f"[SESSION] Start: {connection_type} | Avatar: {avatar_id} | Voice: {voice_id}")

    # Telemetry
    tp = setup_langfuse({
        "langfuse.session.id": ctx.room.name,
        "langfuse.user.id": key,
        "langfuse.tags": json.dumps(["production", f"source:{connection_type}", f"avatar:{avatar_id}"]),
        "connection.type": connection_type,
        "avatar.id": avatar_id,
        "room.name": ctx.room.name
    })

    if tp:
        async def _flush():
            tp.force_flush()
        ctx.add_shutdown_callback(_flush)

    # LLM via local proxy
    import openai as _openai
    import httpx
    mega_token = f"{url}|{token}|{key}"
    llm = openai.LLM(
        model="openclaw",
        base_url="http://localhost:4041/v1",
        api_key=mega_token,
        client=_openai.AsyncOpenAI(
            base_url="http://localhost:4041/v1",
            api_key=mega_token,
            timeout=None,
            max_retries=0
        )
    )

    # ---------------------------------------------------------------------------
    # DUAL STT STRATEGY
    # ---------------------------------------------------------------------------
    # For meetings (email_dispatch/recall), we use Recall.ai's Direct STT relay.
    # For others (website/url), we use high-performance Deepgram Flux.
    # ---------------------------------------------------------------------------
    if connection_type in ("email_dispatch", "recall"):
        print(f"[STT] Meeting mode \u2192 Using RecallAIDirectSTT")
        stt_provider = RecallAIDirectSTT(ctx=ctx)
    else:
        print(f"[STT] Standard mode \u2192 Using Deepgram STTv2 (Flux)")
        stt_provider = deepgram.STTv2(
            model="flux-general-en",
            eager_eot_threshold=0.4,
        )

    session = AgentSession(
        stt=stt_provider,
        vad=silero.VAD.load(),
        llm=llm,
        tts=elevenlabs.TTS(voice_id=voice_id, model="eleven_flash_v2_5"),
        conn_options=SessionConnectOptions(
            llm_conn_options=APIConnectOptions(timeout=300.0, max_retry=0)
        )
    )

    @session.on("user_input_transcribed")
    def on_user_speech(ev: agents.UserInputTranscribedEvent):
        if ev.transcript:
            print(f"[STT] {ev.transcript}")

    @session.on("conversation_item_added")
    def on_item_added(ev: agents.ConversationItemAddedEvent):
        if getattr(ev.item, "role", None) == "assistant":
            content = getattr(ev.item, "content", None)
            if content: print(f"[TTS] Avatar: {content}")

    # Start Session
    try:
        trugen_avatar = trugen.AvatarSession(avatar_id=avatar_id)
        await trugen_avatar.start(session, room=ctx.room)
        await session.start(room=ctx.room, agent=MyAgent())
        
        # Initial Greeting
        session.say("Hello! Let's get started.")
        
    except Exception as e:
        print(f"[SESSION] \u2717 Fatal error: {e}")
        raise

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "download-files":
        silero.VAD.load()
        sys.exit(0)
    cli.run_app(server)