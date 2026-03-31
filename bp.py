
import os
import sys
import time
import json
import threading
import difflib
import re
import statistics
from datetime import datetime
from typing import Dict, Any, List

import requests
import uvicorn
from fastapi import FastAPI, Request
from dotenv import load_dotenv

# ─── Configuration ───────────────────────────────────────────────────────────

load_dotenv()
RECALL_API_KEY = os.getenv("EXTERNAL_MEETINGS_API_TOKEN") or os.getenv("RECALL_API_KEY")
RECALL_BASE_URL = os.getenv("EXTERNAL_MEETINGS_API_URL", "https://us-west-2.recall.ai/api/v1/bot/").rstrip("/").removesuffix("/bot")

PORT = 8000  # Benchmark server port (must match ngrok)

# Test Cases (Matching generate_test_audio.py)
TEST_CASES = {
    "1": {
        "label": "Standard (The Quick Brown Fox)",
        "audio_file": "audio_cases/test_case_1_standard.mp3",
        "text": """The quick brown fox jumps over the lazy dog. Tonight, I say, we must move forward, not backward; upward, not forward; and always twirling, twirling, twirling towards freedom!""" 
    },
    "2": {
        "label": "Medical (Anatomy & Pharmacology)",
        "audio_file": "audio_cases/test_case_2_medical.mp3",
        "text": """The patient presented with acute myocardial infarction and was administered tissue plasminogen activator. Differential diagnosis includes pulmonary embolism, aortic dissection, and pericarditis. Initialize telemetry and monitor for arrhythmias."""
    },
    "3": {
        "label": "Technical (Coding & Infrastructure)",
        "audio_file": "audio_cases/test_case_3_technical.mp3",
        "text": """We need to cherry-pick the commit from the feature branch into main before deploying to Kubernetes. The latency on the load balancer is spiking because of the asynchronous non-blocking I/O operations in the Node.js microservice."""
    },
    "4": {
        "label": "Tongue Twister & Fast Speech",
        "audio_file": "audio_cases/test_case_4_tongue_twister.mp3",
        "text": """Pad kid poured curd pulled cod. The sixth sick sheik's sixth sheep's sick. How much wood would a woodchuck chuck if a woodchuck could chuck wood? He would chuck, he would, as much as he could, and chuck as much wood as a woodchuck would if a woodchuck could chuck wood."""
    }
}

# Transcription Providers Config
PROVIDERS: Dict[str, Dict] = {
    "assembly_ai_v3_streaming": {
        "label": "AssemblyAI v3 Streaming",
        "badge": "Best accuracy",
        "payload": {"assembly_ai_v3_streaming": {"speech_models": ["universal-3-pro"]}},
    },
    "deepgram_nova3": {
        "label": "Deepgram Nova-3",
        "badge": "Lowest latency",
        "payload": {"deepgram_streaming": {"model": "nova-3"}},
    },
    "deepgram_nova2": {
        "label": "Deepgram Nova-2",
        "badge": "Stable",
        "payload": {"deepgram_streaming": {"model": "nova-2-general"}},
    },
    "gladia": {
        "label": "Gladia",
        "badge": "Multilingual",
        "payload": {"gladia_v2_streaming": {"model": "solaria-1"}},
    },
    "recallai_native": {
        "label": "Recall.ai Native",
        "badge": "No key needed",
        "payload": {"recallai_streaming": {"mode": "prioritize_low_latency", "language_code": "en"}},
    },
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

def detect_ngrok_port(default: int = 8000) -> tuple[str, int]:
    """Read the public URL + local port from the running ngrok process."""
    try:
        r = requests.get("http://127.0.0.1:4040/api/tunnels", timeout=3)
        tunnels = r.json().get("tunnels", [])
        if not tunnels:
            return "", default
        chosen = next((t for t in tunnels if t.get("public_url", "").startswith("https://")), tunnels[0])
        public_url = chosen["public_url"]
        if public_url.startswith("http://"):
            public_url = public_url.replace("http://", "https://")
        local_addr = chosen.get("config", {}).get("addr", "")
        port = int(local_addr.rsplit(":", 1)[-1]) if ":" in local_addr else default
        return public_url, port
    except Exception:
        return "", default

def preprocess_text(text: str) -> str:
    """Normalize text for fair WER calculation."""
    # Lowercase
    text = text.lower()
    # Remove punctuation/special characters
    text = re.sub(r'[^\w\s]', '', text)
    # Normalize whitespace
    text = " ".join(text.split())
    return text.strip()

def calculate_wer(reference: str, hypothesis: str) -> float:
    """Calculate Word Error Rate (WER) after preprocessing."""
    ref_clean = preprocess_text(reference)
    hyp_clean = preprocess_text(hypothesis)
    
    try:
        import jiwer
        return jiwer.wer(ref_clean, hyp_clean)
    except ImportError:
        # Fallback: simple Levenshtein ratio
        ref_words = ref_clean.split()
        hyp_words = hyp_clean.split()
        if not ref_words: return 0.0
        s = difflib.SequenceMatcher(None, ref_words, hyp_words)
        matches = sum(n for _, _, n in s.get_matching_blocks())
        return 1.0 - (matches / len(ref_words))

# ─── Benchmark Engine ────────────────────────────────────────────────────────

app = FastAPI()

# Session data for the CURRENT active bot
session_data: Dict[str, Any] = {
    "provider": "",
    "transcripts": [],
    "last_partial_time": 0,
    "commit_latencies": [],
    "bot_join_time": 0
}

@app.post("/webhook")
async def benchmark_webhook(request: Request):
    try:
        body = await request.json()
        event_type = body.get("event")
        data = body.get("data", {}).get("data", {})
        
        timestamp = time.time()
        
        if event_type == "transcript.data":
            # Final transcript (Commit)
            text = " ".join(w.get("text", "") for w in data.get("words", [])).strip()
            if text:
                arrival = time.time()
                # Calculate Commit Latency: Final - Last Partial
                if session_data["last_partial_time"] > 0:
                    latency = arrival - session_data["last_partial_time"]
                    session_data["commit_latencies"].append(latency)
                    print(f"   [COMMIT LATENCY]: {latency*1000:.0f}ms")
                
                session_data["transcripts"].append({
                    "text": text,
                    "arrival_time": arrival
                })

        elif event_type == "transcript.partial_data":
            # Partial token update
            words = data.get("words", [])
            text = " ".join(w.get("text", "") for w in words).strip()
            if text:
                session_data["last_partial_time"] = time.time()
    
    except Exception:
        pass
    return {"status": "ok"}

def get_bot_status(bot_id: str) -> str:
    headers = {"Authorization": f"Token {RECALL_API_KEY}"}
    try:
        r = requests.get(f"{RECALL_BASE_URL}/bot/{bot_id}/", headers=headers, timeout=10)
        r.raise_for_status()
        changes = r.json().get("status_changes", [])
        return changes[-1].get("code", "unknown") if changes else "unknown"
    except Exception:
        return "unknown"

def run_provider_test(key: str, meeting_url: str, public_url: str, reference_text: str, audio_file: str) -> Dict | None:
    provider = PROVIDERS[key]
    print(f"\n─────────────────────────────────────────────────────────────")
    print(f"Testing Provider: {provider['label']}")
    print(f"─────────────────────────────────────────────────────────────")
    
    # Reset Session
    session_data.clear()
    session_data.update({
        "provider": provider['label'],
        "transcripts": [],
        "last_partial_time": 0,
        "commit_latencies": [],
        "bot_join_time": 0
    })

    # Create Bot
    headers = {
        "Authorization": f"Token {RECALL_API_KEY}",
        "Content-Type": "application/json"
    }
    
    bot_name = f"Bench-{provider['label'][:10]}"
    payload = {
        "meeting_url": meeting_url,
        "bot_name": bot_name,
        "recording_config": {
            "transcript": { "provider": provider["payload"] },
            "realtime_endpoints": [{
                "type": "webhook",
                "url": f"{public_url}/webhook",
                "events": ["transcript.data", "transcript.partial_data"]
            }]
        }
    }
    
    print("   [ACTION]: Creating bot...")
    try:
        r = requests.post(f"{RECALL_BASE_URL}/bot/", json=payload, headers=headers)
        r.raise_for_status()
        bot_id = r.json()["id"]
    except Exception as e:
        print(f"   [ERROR]: Failed to create bot: {e}")
        return None

    # Wait for Ready
    print("   [WAIT]: Waiting for bot to join...")
    start_wait = time.time()
    bot_ready = False
    
    while (time.time() - start_wait) < 60:
        status = get_bot_status(bot_id)
        if status == "in_call_recording":
            session_data["bot_join_time"] = time.time()
            bot_ready = True
            print(f"   [READY]: Bot is live! Prepare to play audio.")
            break
        elif status in ["call_ended", "done", "fatal"]:
            print(f"   [FAIL]: Bot ended prematurely.")
            break
        time.sleep(2)
        
    if not bot_ready:
        print("   [ERROR]: Bot failed to join.")
        requests.delete(f"{RECALL_BASE_URL}/bot/{bot_id}/", headers=headers)
        return None

    # Audio Prompt & Auto-Detect
    print(f"\n   >>> PLEASE PLAY AUDIO FILE: {audio_file} <<<")
    print("   [MONITOR]: Waiting for playback and transcripts...")
    
    monitor_start = time.time()
    silence_threshold = 8.0  # Seconds of silence before moving on
    absolute_timeout = 90.0   # Safety cutoff
    has_started = False
    
    while (time.time() - monitor_start) < absolute_timeout:
        transcripts = session_data.get("transcripts", [])
        
        if transcripts:
            if not has_started:
                print("   [FLOW]: Transcripts arriving. Monitoring for silence...")
                has_started = True
            
            last_arrival = transcripts[-1]["arrival_time"]
            silence_time = time.time() - last_arrival
            
            if silence_time >= silence_threshold:
                print(f"   [AUTO]: Detected {silence_threshold}s of silence. Proceeding...")
                break
        
        # Periodic update if waiting too long to start
        if not has_started and (time.time() - monitor_start) > 20 and int(time.time()) % 15 == 0:
            print("   [STILL WAITING]: No transcripts received yet. Please play the audio.")

        time.sleep(1)

    if not has_started:
        print("   [WARN]: Timeout reached with no transcripts detected.")
    
    print("   [WAIT]: Cool-down (2s)...")
    time.sleep(2)
    
    # Cleanup
    print("   [ACTION]: Removing bot...")
    requests.delete(f"{RECALL_BASE_URL}/bot/{bot_id}/", headers=headers)
    
    # Metrics
    full_transcript = " ".join([t["text"] for t in session_data["transcripts"]])
    
    if not full_transcript:
        print("   [WARN]: No transcripts received.")
        return {
            "provider": provider['label'],
            "wer": "N/A",
            "accuracy": "0.0%",
            "startup_latency": "No Data"
        }

    accuracy_score = 1.0 - calculate_wer(reference_text, full_transcript)
    
    avg_commit = 0
    p95_commit = 0
    if session_data["commit_latencies"]:
        lats = [l * 1000 for l in session_data["commit_latencies"]] # to ms
        avg_commit = sum(lats) / len(lats)
        lats.sort()
        idx = int(len(lats) * 0.95)
        p95_commit = lats[idx] if idx < len(lats) else lats[-1]
        
    return {
        "provider": provider['label'],
        "wer": f"{(1-accuracy_score)*100:.1f}%",
        "accuracy": f"{accuracy_score*100:.1f}%",
        "avg_commit": f"{avg_commit:.0f}ms",
        "p95_commit": f"{p95_commit:.0f}ms"
    }

def main():
    print(f"\n--- Recall.ai Serial ASR Benchmark ---")
    if not RECALL_API_KEY:
        print("Error: RECALL_API_KEY not found in .env")
        return

    # Start ngrok detection
    try:
        public_url, port = detect_ngrok_port(default=PORT)
        if not public_url:
            print(f"Error: ngrok not detected on port {PORT}. Run: ngrok http {PORT}")
            return
        print(f"Listening on: {public_url}")
    except Exception:
        return

    # Start Server
    server_thread = threading.Thread(
        target=uvicorn.run, 
        args=(app,), 
        kwargs={"host": "127.0.0.1", "port": port, "log_level": "error"},
        daemon=True
    )
    server_thread.start()
    time.sleep(1.5)

    # User Input - Meeting URL
    meeting_url = input("\nEnter Meeting URL (Google Meet/Zoom): ").strip()
    if not meeting_url: return

    # User Input - Text Selection
    print("\nSelect Test Case (Reference Text):")
    for k, v in TEST_CASES.items():
        print(f"{k}. {v['label']}")
    
    text_choice = input("Enter choice (1-4): ").strip()
    case = TEST_CASES.get(text_choice, TEST_CASES["1"])
    reference_text = case["text"]
    audio_file_name = case.get("audio_file", "audio file")

    # User Input - Providers
    print("\nAvailable Providers:")
    keys = list(PROVIDERS.keys())
    for i, key in enumerate(keys):
        print(f"{i+1}. {PROVIDERS[key]['label']}")
    
    selection = input("\nEnter numbers (e.g. '1,3') or 'all': ").strip()
    
    selected_keys = []
    if selection.lower() == 'all':
        selected_keys = keys
    else:
        try:
            indices = [int(s.strip()) - 1 for s in selection.split(',')]
            selected_keys = [keys[i] for i in indices if 0 <= i < len(keys)]
        except:
            print("Invalid selection.")
            return

    # Run Tests Serial
    results = []
    for key in selected_keys:
        res = run_provider_test(key, meeting_url, public_url, reference_text, audio_file_name)
        if res: results.append(res)
        print("\n   [INFO]: Proceeding to next provider...\n")
        time.sleep(2)

    # Final Report
    print("\n\n═════════════════════════════════════════════════════════════")
    print("BENCHMARK REPORT")
    print("═════════════════════════════════════════════════════════════")
    print(f"{'Provider':<25} | {'Accuracy':<10} | {'WER':<10} | {'Avg Commit':<12} | {'P95 Commit':<12}")
    print("-" * 85)
    for r in results:
        print(f"{r['provider']:<25} | {r['accuracy']:<10} | {r['wer']:<10} | {r['avg_commit']:<12} | {r['p95_commit']:<12}")
    print("═════════════════════════════════════════════════════════════")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)