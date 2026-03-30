import weakref
import re
import os
import time
import json
import asyncio
import logging
from datetime import datetime, timezone
from livekit.agents import stt, DEFAULT_API_CONNECT_OPTIONS, APIConnectOptions
from livekit.agents.stt import RecognizeStream
from livekit.agents.types import NOT_GIVEN, NotGivenOr
from livekit.agents.utils import AudioBuffer
import websockets

logger = logging.getLogger("recallai-stt")

class RecallAIDirectSTT(stt.STT):
    """
    Standalone Recall.ai STT implementation.
    Receives real-time transcripts from Recall.ai via a WebSocket relay.
    """
    def __init__(self, ctx: any, meeting_url: str = ""):
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=True, interim_results=True)
        )
        self._ctx = ctx
        self._meeting_url = meeting_url

    @property
    def provider(self) -> str:
        return "recall-ai-direct"

    async def _recognize_impl(
        self,
        buffer: AudioBuffer,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> stt.SpeechEvent:
        # Required by interface but not used in streaming sessions
        return stt.SpeechEvent(type=stt.SpeechEventType.START_OF_SPEECH, alternatives=[])

    def stream(
        self,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> "RecallSpeechStream":
        return RecallSpeechStream(
            stt=self,
            conn_options=APIConnectOptions(),
            ctx=self._ctx,
        )

class RecallSpeechStream(stt.SpeechStream):
    def __init__(
        self,
        *,
        stt: RecallAIDirectSTT,
        conn_options: APIConnectOptions,
        ctx: any,
    ) -> None:
        super().__init__(stt=stt, conn_options=conn_options)
        self._stt = stt
        self._ctx = ctx
        self._last_final_text = ""

    def _extract_participant_name(self, msg: dict) -> str:
        participant = msg.get("data", {}).get("data", {}).get("participant", {})
        if isinstance(participant, dict):
            return participant.get("name") or "Unknown"
        return "Unknown"

    def _extract_transcript(self, msg: dict) -> str:
        words = msg.get("data", {}).get("data", {}).get("words", [])
        if not isinstance(words, list):
            return ""
        return " ".join(w.get("text", "") for w in words if isinstance(w, dict) and w.get("text")).strip()

    def _emit_final(self, text: str):
        if not text: return
        self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.END_OF_SPEECH, alternatives=[stt.SpeechData(text=text, language="en")]))
        self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives=[stt.SpeechData(text=text, language="en")]))

    def _emit_interim(self, text: str):
        if not text: return
        self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.START_OF_SPEECH, alternatives=[]))
        self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.INTERIM_TRANSCRIPT, alternatives=[stt.SpeechData(text=text, language="en")]))

    async def _run(self) -> None:
        relay_url = os.getenv("EXTERNAL_MEETINGS_WS_URL", "").strip()
        if not relay_url:
            logger.error("Recall.ai relay URL not configured")
            return

        try:
            async with websockets.connect(relay_url) as ws:
                # Identify which room we are interested in
                await ws.send(json.dumps({"type": "set_lk_room_id", "data": self._ctx.room.name}))
                logger.info(f"Recall STT connected for room: {self._ctx.room.name}")

                while True:
                    try:
                        raw = await ws.recv()
                        msg = json.loads(raw)
                        event = msg.get("event")

                        if event == "transcript.data":
                            text = self._extract_transcript(msg)
                            if text:
                                speaker = self._extract_participant_name(msg)
                                print(f"[RECALL] {speaker}: {text}")
                                self._emit_final(f"{speaker}: {text}")

                        elif event == "transcript.partial_data":
                            text = self._extract_transcript(msg)
                            if text:
                                self._emit_interim(text)
                        
                        elif event == "participant_events.leave":
                            # If the bot itself leaves, we might want to shut down
                            pass

                    except websockets.ConnectionClosed:
                        break
        except Exception as e:
            logger.error(f"Recall STT error: {e}")
