import os
import requests
import threading
from flask import Flask, request, Response
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession
from livekit.plugins import elevenlabs, openai, trugen

load_dotenv()

# --- CONFIGURATION ---
OPENCLAW_URL = os.getenv("OPENCLAW_URL", "http://localhost:18789")
GATEWAY_TOKEN = os.getenv("OPENCLAW_GATEWAY_TOKEN", "d73dbe23610cf52243cc6119ad50155fcaa52ec7cc9e79f0")
SESSION_KEY = os.getenv("OPENCLAW_SESSION_KEY", "agent:main:bharath-bot")

# --- OPENCLAW SESSION PROXY (INTERNAL) ---
# Integrated proxy logic from main.py
app = Flask(__name__)

@app.route('/v1/chat/completions', methods=['POST'])
def chat_proxy():
    print(f"\n[INFO] New message from TruGenAI...")
    try:
        data = request.get_json()
        messages = data.get('messages', [])
        
        # 1. FIND ALL USER MESSAGES AT THE TAIL
        # TruGenAI/LiveKit sends full history, but OpenClaw saves it too.
        # We collect all consecutive user messages from the end to capture the full turn.
        new_messages = []
        for msg in reversed(messages):
            if msg.get('role') == 'user':
                new_messages.insert(0, msg)
            else:
                # Stop as soon as we hit an assistant or system message
                break
        
        if not new_messages:
            return {"error": "No user message found"}, 400

        # 2. PREPARE HEADERS
        headers = {
            "Authorization": f"Bearer {GATEWAY_TOKEN}",
            "x-openclaw-session-key": SESSION_KEY,
            "x-openclaw-agent-id": "main"
        }

        # 3. FORWARD TO OPENCLAW
        combined_text = " ".join([m.get("content", "") for m in new_messages])
        print(f"[DEBUG] Proxy: SendingTurn ({len(new_messages)} msgs): {combined_text[:50]}...")
        resp = requests.post(
            f"{OPENCLAW_URL}/v1/chat/completions",
            headers=headers,
            json={
                "model": "main",
                "messages": new_messages,
                "stream": data.get("stream", True)
            },
            stream=True
        )

        # 4. STREAM RESPONSE BACK
        def generate():
            for chunk in resp.iter_content(chunk_size=1024):
                yield chunk

        return Response(generate(), resp.status_code, {"Content-Type": "text/event-stream"})

    except Exception as e:
        print(f"[ERROR] Proxy failed: {e}")
        return {"error": str(e)}, 500

def run_proxy():
    print(f"--- OpenClaw Session Proxy Active (Agent Internal) ---")
    print(f"Targeting Session: {SESSION_KEY}")
    # Using port 8081 if 8080 is often taken, but matching main.py's 8080 for consistency
    app.run(host='0.0.0.0', port=8080, debug=False, use_reloader=False)

# Start Proxy Thread
proxy_thread = threading.Thread(target=run_proxy, daemon=True)
proxy_thread.start()

# --- LIVEKIT AGENT ---
AGENT_INSTRUCTIONS = (
    "You are a helpful AI assistant with a live video avatar. "
    "Keep responses to 2-4 short spoken sentences. "
    "Be conversational and natural. "
    "Never use markdown, bullet points, or any formatting — "
    "your words are spoken aloud via TTS."
)

class MyAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=AGENT_INSTRUCTIONS)

server = AgentServer()

@server.rtc_session()
async def my_agent(ctx: agents.JobContext):
    # LLM via our internal proxy endpoint (localhost:8080)
    openclaw_llm = openai.LLM(
        model="main",
        base_url="http://localhost:8080/v1",
        api_key=GATEWAY_TOKEN
    )

    session = AgentSession(
        stt="deepgram/nova-3",
        llm=openclaw_llm,
        tts=elevenlabs.TTS(
            voice_id="FGY2WhTYpPnrIDTdsKH5",
            model="eleven_flash_v2_5",
        ),
    )

    avatar_id = os.getenv("TRUGEN_AVATAR_ID") or "1a640442"
    trugen_avatar = trugen.AvatarSession(avatar_id=avatar_id)
    await trugen_avatar.start(session, room=ctx.room)

    # Start the voice session
    await session.start(
        room=ctx.room,
        agent=MyAgent()
    )

    # Agent speaks first
    session.say("Hello! I'm ready to chat.")

if __name__ == "__main__":
    agents.cli.run_app(server)
