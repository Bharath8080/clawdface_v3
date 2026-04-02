import os
import json
import asyncio
import base64
import requests
import typing
import logging
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession, cli, metrics, APIConnectOptions
from livekit.agents.telemetry import set_tracer_provider
from livekit.agents.voice import MetricsCollectedEvent
from livekit.agents.voice.agent_session import SessionConnectOptions
from livekit.plugins import elevenlabs, openai, trugen, silero, deepgram
 
# OTEL for Langfuse
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace.export import BatchSpanProcessor
 
import time
import websockets
from livekit.agents import stt
from livekit.agents.utils import AudioBuffer
from livekit.agents.types import NOT_GIVEN, NotGivenOr
from livekit.agents.voice.room_io import RoomOptions
 
load_dotenv()
logger = logging.getLogger("trugen-agent")
 

 
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
 
# ---------------------------------------------------------------------------
# RECALL.AI STT — connects to relay with room_id in URL
# ---------------------------------------------------------------------------
class RecallAIDirectSTT(stt.STT):
    def __init__(self, ctx: agents.JobContext, recall_bot_id: str = "", room_id: str = ""):
        super().__init__(capabilities=stt.STTCapabilities(streaming=True, interim_results=True))
        self._ctx = ctx
        self._recall_bot_id = recall_bot_id
        self._room_id = room_id  # ← LiveKit room name, used in relay URL
 
    @property
    def provider(self) -> str: return "recall-ai-direct"
 
    async def _recognize_impl(self, buffer: AudioBuffer, *, language: NotGivenOr[str] = NOT_GIVEN, conn_options: APIConnectOptions = APIConnectOptions()) -> stt.SpeechEvent:
        return stt.SpeechEvent(type=stt.SpeechEventType.START_OF_SPEECH, alternatives=[])
 
    def stream(self, *, language: NotGivenOr[str] = NOT_GIVEN, conn_options: APIConnectOptions = APIConnectOptions()) -> "RecallSpeechStream":
        logger.info(f"[STT] Creating new RecallSpeechStream... bot_id={self._recall_bot_id}")
        return RecallSpeechStream(
            stt=self,
            conn_options=conn_options,
            ctx=self._ctx,
            recall_bot_id=self._recall_bot_id,
            room_id=self._room_id,
        )
 
 
class RecallSpeechStream(stt.SpeechStream):
    def __init__(self, *, stt: RecallAIDirectSTT, conn_options: APIConnectOptions,
                 ctx: agents.JobContext, recall_bot_id: str = "", room_id: str = "") -> None:
        super().__init__(stt=stt, conn_options=conn_options)
        self._ctx = ctx
        self._recall_bot_id = recall_bot_id
        self._room_id = room_id
        self._speaking = False
 
    def _emit_final(self, text: str):
        if not text: return
        if not self._speaking:
            self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.START_OF_SPEECH, alternatives=[]))
            self._speaking = True
        self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.END_OF_SPEECH, alternatives=[stt.SpeechData(text=text, language="en")]))  # type: ignore
        self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives=[stt.SpeechData(text=text, language="en")]))  # type: ignore
        self._speaking = False
 
    def _emit_interim(self, text: str):
        if not text: return
        if not self._speaking:
            self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.START_OF_SPEECH, alternatives=[]))
            self._speaking = True
        self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.INTERIM_TRANSCRIPT, alternatives=[stt.SpeechData(text=text, language="en")]))  # type: ignore
 
    async def _run(self) -> None:
        base_url = os.getenv("EXTERNAL_MEETINGS_WS_URL", "").strip()
        if not base_url:
            logger.warning("[RECALL] EXTERNAL_MEETINGS_WS_URL is not set!")
        retry_delay = 2
 
        # -----------------------------------------------------------------------
        # RELAY ROUTING: Include room_id (and bot_id) as query params so the relay
        # can match this agent WS connection to incoming Recall.ai events.
        # Recall.ai connects to the relay with ?room_id=... in its endpoint URL;
        # the relay routes by matching the same param on the agent side.
        # We also send message-based registration as a secondary/fallback protocol.
        # -----------------------------------------------------------------------
        room_id = self._room_id or self._ctx.room.name
        logger.info(f"[RECALL] Base URL: {base_url}")
 
        while True:
            try:
                logger.info(f"[RECALL] Initializing WebSocket connection to {base_url}...")
                async with websockets.connect(
                    base_url,
                    ping_interval=20,
                    ping_timeout=20,
                    open_timeout=15,
                ) as ws:
                    logger.info("[RECALL] Handshake successful. Sending registration messages...")
                    
                    # 1. Register Room ID
                    reg_room = {"type": "set_lk_room_id", "data": room_id}
                    logger.info(f"[RECALL] Sending Room Registration \u2192 {reg_room}")
                    await ws.send(json.dumps(reg_room))
                    
                    # 2. Register Bot ID (optional)
                    if self._recall_bot_id:
                        reg_bot = {"type": "set_bot_id", "data": self._recall_bot_id}
                        logger.info(f"[RECALL] Sending Bot Registration \u2192 {reg_bot}")
                        await ws.send(json.dumps(reg_bot))
                    else:
                        logger.warning("[RECALL] No bot_id provided for registration. Routing might depend solely on room_id.")
 
                    logger.info(f"[RECALL] \u2713 Handshake and registration successful. Room: {room_id}")
                    retry_delay = 2
 
                    while True:
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=30.0)
                        except asyncio.TimeoutError:
                            logger.debug("[RECALL] keepalive ping")
                            await ws.ping()
                            continue
 
                        msg = json.loads(raw)
                        event = msg.get("event")
                        logger.info(f"[RECALL] Incoming event: {event} | Payload: {raw}")

                        if event in ("transcript.data", "transcript.partial_data"):
                            # Robust parsing: try nested 'data.data' then fall back to 'data'
                            inner_data = msg.get("data", {})
                            if isinstance(inner_data, dict) and "data" in inner_data:
                                inner_data = inner_data.get("data", {})
                            
                            words = inner_data.get("words", []) if isinstance(inner_data, dict) else []
                            text = " ".join(
                                w.get("text", "") for w in words
                                if isinstance(w, dict) and w.get("text")
                            ).strip()

                            if text:
                                if event == "transcript.data":
                                    participant = inner_data.get("participant", {})
                                    speaker = participant.get("name", "Unknown") if isinstance(participant, dict) else "Unknown"
                                    logger.info(f"[RECALL] FINAL | {speaker}: {text}")
                                    self._emit_final(f"{speaker}: {text}")
                                else:
                                    logger.debug(f"[RECALL] PARTIAL: {text}")
                                    self._emit_interim(text)
 
                        elif event == "participant_events.join":
                            participant = msg.get("data", {}).get("data", {}).get("participant", {})
                            name = participant.get("name", "Unknown") if isinstance(participant, dict) else "Unknown"
                            logger.info(f"[RECALL] ✓ Participant joined: {name}")
 
                        elif event == "participant_events.leave":
                            participant = msg.get("data", {}).get("data", {}).get("participant", {})
                            name = participant.get("name", "Unknown") if isinstance(participant, dict) else "Unknown"
                            logger.info(f"[RECALL] Participant left: {name}")
 
                        else:
                            # Log ANY unrecognised event so we can debug relay message format
                            logger.info(f"[RECALL] Unknown event type: {event} | raw: {raw[:200]}")
 
            except websockets.InvalidHandshake as e:
                logger.error(f"[RECALL] \u2717 Protocol error during handshake: {e}. Check if the URL is a valid WS/WSS endpoint. Retrying...")
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 30)
            except websockets.ConnectionClosed as e:
                logger.warning(f"[RECALL] ! Connection closed unexpectedly: {e} (code={e.code}). Attempting reconnect in {retry_delay}s...")
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 30)
            except Exception as e:
                logger.error(f"[RECALL] \u2717 Unexpected error in relay loop: {e}. Full context follows:", exc_info=True)
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 30)
 
  
def resolve_config(ctx: agents.JobContext) -> tuple[dict, str]:
    # 1. Job Metadata (Highest Priority for Dispatches)
    try:
        if ctx.job and ctx.job.metadata:
            cfg = json.loads(ctx.job.metadata)
            if cfg.get("recallBotId"):
                return cfg, "recall"
            if cfg.get("openclawUrl"):
                return cfg, "email_dispatch"
    except Exception as e:
        logger.debug(f"[CONFIG] Failed to parse job metadata: {e}")

    # 2. Room Metadata
    try:
        if ctx.room.metadata:
            cfg = json.loads(ctx.room.metadata)
            if cfg.get("recallBotId"):
                 return cfg, "recall"
            if cfg.get("openclawUrl"):
                return cfg, "room_metadata"
    except Exception as e:
        logger.debug(f"[CONFIG] Failed to parse room metadata: {e}")

    # 3. Participant Metadata
    for p in ctx.room.remote_participants.values():
        try:
            if p.metadata:
                cfg = json.loads(p.metadata)
                if cfg.get("openclawUrl"):
                    type = "url_share" if str(cfg.get("sessionKey", "")).startswith("session-") else "website"
                    if cfg.get("recallBotId"): type = "recall"
                    return cfg, type
        except: pass

    # 4. Backend Dynamic Lookup (by Room Name/Email)
    room_id = ctx.room.name
    if room_id and not room_id.startswith("room-"):
        email = room_id if "@" in room_id else f"{room_id}@agent.truhire.ai"
        try:
            base_url = os.getenv("FRONTEND_URL", "").rstrip("/")
            if base_url:
                logger.info(f"[CONFIG] Fetching sync config for {email}...")
                resp = requests.get(f"{base_url}/api/agents/config?email={email}", timeout=5)
                if resp.status_code == 200:
                    cfg = resp.json()
                    if cfg.get("openclawUrl"):
                        mode = "recall" if cfg.get("recallBotId") else "email_dispatch"
                        return cfg, mode
        except Exception as e:
            logger.debug(f"[CONFIG] Lookup error for {email}: {e}")

    return {}, "unknown"
 
 
def setup_langfuse(metadata: dict):
    pub = os.getenv("LANGFUSE_PUBLIC_KEY")
    sec = os.getenv("LANGFUSE_SECRET_KEY")
    host = os.getenv("LANGFUSE_HOST") or os.getenv("LANGFUSE_BASE_URL")
 
    if not all([pub, sec, host]):
        print("[LANGFUSE] Missing credentials, tracing disabled.")
        return None
 
    auth = base64.b64encode(f"{pub}:{sec}".encode()).decode()
    safe_host = str(host).rstrip("/")
    os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"{safe_host}/api/public/otel"
    os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = f"Authorization=Basic {auth}"
 
    tp = TracerProvider()
    tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    set_tracer_provider(tp, metadata=metadata)
    return tp
 
 
# ---------------------------------------------------------------------------
# AGENT
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
 
    config, connection_type = {}, "unknown"
    for _ in range(30):
        config, connection_type = resolve_config(ctx)
        if config: break
        await asyncio.sleep(0.5)

    logger.info(f"[METADATA] Resolution Completed | Mode: {connection_type.upper()}")
    logger.info(f"[METADATA] Room Metadata: {ctx.room.metadata[:300]}")
    logger.info(f"[METADATA] Job Metadata: {ctx.job.metadata[:300]}")

    if not config:
        logger.error(f"[SESSION] \u2717 Failed to resolve config for room {ctx.room.name}")
        return

    url = config.get("openclawUrl", "").strip()
    token = config.get("gatewayToken", "")
    key = config.get("sessionKey", "")
    avatar_id = config.get("avatarId") or os.getenv("TRUGEN_AVATAR_ID") or DEFAULT_AVATAR_ID
    voice_id = "CwhRBWXzGAHq8TQ4Fs17" if avatar_id in MALE_AVATAR_IDS else "FGY2WhTYpPnrIDTdsKH5"

    tp = setup_langfuse({
        "langfuse.session.id": ctx.room.name,
        "langfuse.user.id": key,
        "langfuse.tags": json.dumps(["production", f"source:{connection_type}", f"avatar:{avatar_id}"]),
        "connection.type": connection_type,
        "avatar.id": avatar_id,
        "room.name": ctx.room.name
    })

    if tp:
        async def _flush_sync() -> None:
            tp.force_flush()
        ctx.add_shutdown_callback(_flush_sync)

    import openai as _openai
    llm = openai.LLM(
        model="openclaw",
        client=_openai.AsyncOpenAI(
            base_url=f"{url}/v1",
            api_key=token,
            default_headers={
                "x-openclaw-session-key": key,
                "x-openclaw-agent-id": "main",
                "ngrok-skip-browser-warning": "true"
            },
            timeout=None,
            max_retries=0
        )
    )

    vad_provider = silero.VAD.load()
    if connection_type in ("email_dispatch", "recall") or config.get("recallBotId"):
        recall_bot_id = config.get("recallBotId", "") or ""
        livekit_room_id = config.get("roomId") or ctx.room.name
        logger.info(f"[SESSION] Start: {connection_type} | Mode: RECALL | Bot: {recall_bot_id or 'none'}")
        logger.info(f"[STT] Meeting mode \u2192 RecallAIDirectSTT | room_sid={livekit_room_id}")
        stt_provider = RecallAIDirectSTT(ctx=ctx, recall_bot_id=recall_bot_id, room_id=livekit_room_id)
    else:
        logger.info(f"[SESSION] Start: {connection_type} | Mode: STANDARD")
        logger.info(f"[STT] Standard mode \u2192 Deepgram STTv2 (Flux)")
        stt_provider = deepgram.STTv2(
            model="flux-general-en",
            eager_eot_threshold=0.4,
        )

    session = AgentSession(
        stt=stt_provider,
        vad=vad_provider,
        llm=llm,
        tts=elevenlabs.TTS(voice_id=voice_id, model="eleven_flash_v2_5"),
        conn_options=SessionConnectOptions(
            llm_conn_options=APIConnectOptions(timeout=300.0, max_retry=0)
        )
    )

    @session.on("user_input_transcribed")
    def on_user_speech(ev: agents.UserInputTranscribedEvent):
        if ev.transcript:
            logger.info(f"[STT] \u2713 Transcribed: {ev.transcript}")

    @session.on("conversation_item_added")
    def on_item_added(ev: agents.ConversationItemAddedEvent):
        if getattr(ev.item, "role", None) == "assistant":
            content = getattr(ev.item, "content", None)
            if content: logger.info(f"[TTS] Avatar: {content}")

    if connection_type in ("email_dispatch", "recall") or config.get("recallBotId"):
        room_opts = RoomOptions(close_on_disconnect=False)
        logger.info("[SESSION] Meeting mode active: close_on_disconnect=False")
    else:
        room_opts = NOT_GIVEN

    try:
        trugen_avatar = trugen.AvatarSession(avatar_id=avatar_id)
        await trugen_avatar.start(session, room=ctx.room)
        await session.start(MyAgent(), room=ctx.room, room_options=room_opts)
        session.say("Hello! Let's get started.")
    except Exception as e:
        logger.error(f"[SESSION] ✗ Fatal error: {e}")
        raise


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "download-files":
        silero.VAD.load()
        sys.exit(0)
    
    cli.run_app(server)