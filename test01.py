import os

import httpx
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession, room_io
from livekit.plugins import elevenlabs, openai, trugen

load_dotenv()

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
    # LLM via OpenClaw Gateway (OpenAI-compatible endpoint)
    openclaw_llm = openai.LLM(
        model="openclaw:main",
        base_url="https://pertinacious-speechlessly-lidia.ngrok-free.dev/v1",
        api_key="d73dbe23610cf52243cc6119ad50155fcaa52ec7cc9e79f0"
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
