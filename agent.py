import os
import typing
import json
import requests
import asyncio
import threading
import base64
import logging
from flask import Flask, request, Response
from dotenv import load_dotenv
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.util.types import AttributeValue
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession, cli, metrics
from livekit.agents.telemetry import set_tracer_provider
from livekit.plugins import elevenlabs, openai, trugen, groq, silero
from langfuse import Langfuse
 
load_dotenv()
 
# --- OPENCLAW SESSION PROXY (Stateless / Mega-Token) ---
app = Flask(__name__)
 
@app.route('/v1/chat/completions', methods=['POST'])
def chat_proxy():
    try:
        data = request.get_json()
        messages = data.get('messages', [])
 
        # 1. Unpack "Mega-Token" from Authorization header (URL|TOKEN|KEY)
        auth_header = request.headers.get("Authorization", "")
        token_str = auth_header.replace("Bearer ", "")
       
        if "|" not in token_str:
             print("[PROXY] ✗ Invalid Mega-Token format")
             return {"error": "Missing x-openclaw-url. Check your Mega-Token."}, 400
 
        # Unpack: URL | TOKEN | SESSION_KEY
        parts = token_str.split("|")
        target_url = parts[0]
        gate_token = parts[1]
        sess_key   = parts[2]
 
        print(f"\n[PROXY] → {target_url}  session={sess_key}")
 
        # Filter to only send user messages to OpenClaw (it manages history)
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
    print("--- OpenClaw Proxy Active (port 4041) ---")
    app.run(host='0.0.0.0', port=4041, debug=False, use_reloader=False)
 
threading.Thread(target=run_proxy, daemon=True).start()
 # --- TRACING SETUP (Langfuse) ---
def setup_langfuse(
    metadata: dict[str, AttributeValue] | None = None,
    *,
    host: str | None = None,
    public_key: str | None = None,
    secret_key: str | None = None,
) -> TracerProvider:
    public_key = public_key or os.getenv("LANGFUSE_PUBLIC_KEY")
    secret_key = secret_key or os.getenv("LANGFUSE_SECRET_KEY")
    host = host or os.getenv("LANGFUSE_HOST") or os.getenv("LANGFUSE_BASE_URL")

    if not public_key or not secret_key or not host:
        raise ValueError(
            "LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_HOST (or LANGFUSE_BASE_URL) must be set"
        )

    trace_provider = TracerProvider()
    set_tracer_provider(trace_provider, metadata=metadata)

    Langfuse(
        public_key=public_key,
        secret_key=secret_key,
        base_url=host,
        tracer_provider=trace_provider,
        should_export_span=lambda span: True,
    )

    return trace_provider

# --- LIVEKIT AGENT ---
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
    # Setup Tracing
    trace_provider = setup_langfuse(
        metadata={
            "langfuse.session.id": ctx.room.name,
        }
    )

    async def flush_trace():
        trace_provider.force_flush()

    ctx.add_shutdown_callback(flush_trace)

    await ctx.connect()

    # 1. Get Config (Strictly from metadata passed from frontend localStorage)
    config = None
    for p in ctx.room.remote_participants.values():
        if p.metadata:
            try:
                config = json.loads(p.metadata)
                print(f"[SESSION] ✓ Config from participant metadata")
                break
            except: pass
   
    if not config:
        print(f"[SESSION] ✗ No config found in participant metadata")
        return
 
    url    = config.get("openclawUrl", "")
    token  = config.get("gatewayToken", "")
    key    = config.get("sessionKey", "")
 
    if not url or not token or not key:
        print(f"[SESSION] ✗ Incomplete config: {config}")
        return
 
    # 2. Determine Voice ID based on Avatar Gender
    # Male: Kevin, Jason, Sameer, Mike, Johnny, Aman, Alex, Amir, Akbar
    # Female: Jessica, Cathy, Sofia, Lucy, Kiara, Jennifer, Priya, Chloe, Lisa, Allie, Misha
    avatar_id = config.get("avatarId") or os.getenv("TRUGEN_AVATAR_ID")
    if not avatar_id:
        avatar_id = "1a640442" # Default to Lisa

    male_ids = {
        "182b03e8", "05a001fc", "be5b2ce0", "03ae0187", 
        "1fa504ff", "0f160301", "13550375", "48d778c9", "18c4043e"
    }
    
    # Female: FGY2WhTYpPnrIDTdsKH5, Male: CwhRBWXzGAHq8TQ4Fs17
    voice_id = "CwhRBWXzGAHq8TQ4Fs17" if avatar_id in male_ids else "FGY2WhTYpPnrIDTdsKH5"
    print(f"[SESSION] Using Avatar ID: {avatar_id}, Voice ID: {voice_id}")

    # 3. MEGA-TOKEN: Pack everything into the api_key for the proxy
    mega_token = f"{url}|{token}|{key}"

    openclaw_llm = openai.LLM(
        model="main",
        base_url="http://localhost:4041/v1",
        api_key=mega_token,
    )

    # 4. AgentSession setup
    session = AgentSession(
        stt=groq.STT(model="whisper-large-v3-turbo"),
        vad=silero.VAD.load(),
        llm=openclaw_llm,
        tts=elevenlabs.TTS(
            voice_id=voice_id,
            model="eleven_flash_v2_5",
        ),
    )

    # 5. Enhanced Observability
    tracer = trace_provider.get_tracer(__name__)

    @session.on("user_input_transcribed")
    def on_user_speech(msg: agents.llm.ChatMessage):
        if msg.content and isinstance(msg.content, str):
            with tracer.start_as_current_span(
                "user_transcript",
                attributes={"langfuse.message.role": "user", "langfuse.message.content": msg.content}
            ):
                pass

    @session.on("agent_state_changed")
    def on_agent_state(state: typing.Any):
        # Optional: track state changes like 'speaking', 'listening'
        pass

    @session.on("metrics_collected")
    def on_metrics(m: typing.Any):
        # Already handled by OTel exporter, but good for custom spans if needed
        pass
   
    trugen_avatar = trugen.AvatarSession(avatar_id=avatar_id)
    await trugen_avatar.start(session, room=ctx.room)
 
    try:
        await session.start(room=ctx.room, agent=MyAgent())
        session.say("Hello! Let’s get started.")
    except Exception as e:
        with tracer.start_as_current_span(
            "agent_error",
            attributes={"error": str(e), "type": type(e).__name__}
        ):
            print(f"[SESSION] ✗ Error: {e}")
            raise e
 
if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "download-files":
        # This is used by the Dockerfile to pre-download models (e.g. Silero)
        print("Pre-downloading models...")
        silero.VAD.load()
        sys.exit(0)
    agents.cli.run_app(server)