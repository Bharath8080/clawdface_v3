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

import websockets
from typing import AsyncGenerator, Dict

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
        # Check if port is already active via a quick socket check
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('localhost', 4041)) == 0:
                print("[PROXY] Port 4041 already active, skipping startup.")
                return

        print("--- OpenClaw Proxy Active (port 4041) ---")
        app.run(host='0.0.0.0', port=4041, debug=False, use_reloader=False)
    except Exception as e:
        print(f"[PROXY] Startup skipped or error: {e}")

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
# MEETING RELAY TASK (Direct Transcript Injection)
# ---------------------------------------------------------------------------
async def start_recall_relay(session: agents.voice.AgentSession, room_name: str):
    """
    Listens to the Recall.ai relay and injects transcripts directly into the session.
    Bypasses VAD/STT pipeline for multi-speaker meeting support.
    """
    client = RecallRelayClient(room_id=room_name)
    
    async for event in client.listen():
        if event["type"] == "final":
            text = event["text"]
            speaker = event["speaker"]
            print(f"[RECALL] {speaker}: {text}")
            
            # Simple noise filter to avoid constant interruptions
            if len(text.split()) < 2: 
                continue

            try:
                # Inject as a user turn
                # This will automatically trigger the LLM to generate a response
                session.run(user_input=f"{speaker}: {text}")
            except RuntimeError:
                # Nested runs not supported (agent is busy speaking or thinking)
                # In a meeting, we could queue these or just ignore them if the agent is already in a turn.
                print(f"[RECALL] Agent busy, skipping input: {text[:30]}...")
                pass
        
        elif event["type"] == "interim":
            # Optional: Display interim text in logs for debug
            pass

# ---------------------------------------------------------------------------
# RECALL.AI RELAY CLIENT (Merged from recall.py)
# ---------------------------------------------------------------------------
class RecallRelayClient:
    """
    A simple client for the Recall.ai WebSocket relay.
    """
    def __init__(self, room_id: str):
        self.room_id = room_id
        self.url = os.getenv("EXTERNAL_MEETINGS_WS_URL", "wss://recall.trugen.ai/ws").strip()
        self._ws = None

    def _extract_participant_name(self, msg: dict) -> str:
        participant = msg.get("data", {}).get("data", {}).get("participant", {})
        if isinstance(participant, dict):
            return participant.get("name") or "Participant"
        return "Participant"

    def _extract_transcript(self, msg: dict) -> str:
        words = msg.get("data", {}).get("data", {}).get("words", [])
        if not isinstance(words, list):
            return ""
        return " ".join(w.get("text", "") for w in words if isinstance(w, dict) and w.get("text")).strip()

    async def listen(self) -> AsyncGenerator[Dict, None]:
        if not self.url:
            print("[RECALL] Relay URL not configured")
            return

        while True:
            try:
                print(f"[RECALL] Connecting to relay: {self.url}")
                async with websockets.connect(self.url) as ws:
                    self._ws = ws
                    # Identify which room we are interested in
                    await ws.send(json.dumps({"type": "set_lk_room_id", "data": self.room_id}))
                    print(f"[RECALL] Bound to room: {self.room_id}")

                    while True:
                        raw = await ws.recv()
                        msg = json.loads(raw)
                        event = msg.get("event")

                        if event == "transcript.data":
                            text = self._extract_transcript(msg)
                            if text:
                                speaker = self._extract_participant_name(msg)
                                yield {"type": "final", "text": text, "speaker": speaker}

                        elif event == "transcript.partial_data":
                            text = self._extract_transcript(msg)
                            if text:
                                yield {"type": "interim", "text": text}

            except (websockets.ConnectionClosed, Exception) as e:
                print(f"[RECALL] Relay connection shared/error: {e}. Retrying in 5s...")
                await asyncio.sleep(5)

# ---------------------------------------------------------------------------
# TELEMETRY & TRACING (Langfuse)
# ---------------------------------------------------------------------------
class MyAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=(
            "You are a helpful AI assistant. Keep responses to 2-4 short spoken sentences. "
            "Be conversational. Never use markdown, bullet points, or formatting. "
            "If a transcript is prefixed with a name (e.g. 'John: ...'), that is a meeting participant. "
            "Address them by name if appropriate."
        ))

server = AgentServer()

@server.rtc_session(agent_name="clawdface")
async def my_agent(ctx: agents.JobContext):
    # For meetings, avoid closing the session when the trigger participant leaves
    await ctx.connect(room_input_options=agents.voice.RoomInputOptions(close_on_disconnect=False))

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

    print(f"[SESSION] Start: {connection_type} | Avatar: {avatar_id} | Room: {ctx.room.name}")

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
            return None # Explicit None to avoid bool await issue
        ctx.add_shutdown_callback(_flush)

    # LLM via local proxy
    import openai as _openai
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
    # DUAL PIPELINE STRATEGY
    # ---------------------------------------------------------------------------
    if connection_type in ("email_dispatch", "recall"):
        print(f"[PIPELINE] Meeting mode \u2192 Using Direct Injection + Silero VAD")
        # In meeting mode, we use Silero as a "backup" or just to satisfy the session.
        # The primary STT input will come from the start_recall_relay task.
        stt_provider = deepgram.STTv2(model="flux-general-en") # Fallback to DG for local participants
    else:
        print(f"[PIPELINE] Standard mode \u2192 Using Deepgram STTv2 (Flux)")
        stt_provider = deepgram.STTv2(
            model="flux-general-en",
            eager_eot_threshold=0.4,
        )

    session = AgentSession(
        stt=stt_provider,
        vad=silero.VAD.load(),
        llm=llm,
        tts=elevenlabs.TTS(voice_id=voice_id, model="eleven_flash_v2_5"),
        allow_interruptions=True,
        min_endpointing_delay=1.0 if connection_type == "email_dispatch" else 0.5,
        conn_options=SessionConnectOptions(
            llm_conn_options=APIConnectOptions(timeout=300.0, max_retry=0)
        )
    )

    @session.on("user_input_transcribed")
    def on_user_speech(ev: agents.UserInputTranscribedEvent):
        if ev.transcript:
            print(f"[STT] Local: {ev.transcript}")

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
        
        # Start Relay in background if in meeting
        if connection_type in ("email_dispatch", "recall"):
            ctx.create_task(start_recall_relay(session, ctx.room.name))
            session.say("Hello everyone! I'm here to assist.")
        else:
            session.say("Hello! Let's get started.")
            
    except Exception as e:
        print(f"[SESSION] \u2717 Fatal error: {e}")
        raise

if __name__ == "__main__":
    cli.run_app(server)