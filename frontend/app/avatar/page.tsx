"use client";

import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  useTracks,
  useParticipants,
  useRoomContext,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ConnectionDetails } from "../api/connection-details/route";

function AvatarContent() {
  const participants = useParticipants();

  // Get all camera tracks (subscribed only — the default)
  const subscribedTracks = useTracks([Track.Source.Camera]);

  // Also check screen share tracks in case Trugen uses a different source
  const screenShareTracks = useTracks([Track.Source.ScreenShare]);

  // Find any video track from any REMOTE participant
  const agentVideoTrack = 
    subscribedTracks.find((t) => !t.participant.isLocal) ||
    screenShareTracks.find((t) => !t.participant.isLocal);

  const room = useRoomContext();
  
  // Explicitly enable microphone on mount
  useEffect(() => {
    if (room) {
      console.log("[Avatar] Enabling microphone...");
      room.localParticipant.setMicrophoneEnabled(true).catch((err: Error) => {
        console.error("[Avatar] Mic permission error:", err);
      });
    }
  }, [room]);

  // Debug info in console
  useEffect(() => {
    const remotes = participants.filter(p => !p.isLocal);
    if (remotes.length > 0) {
      console.log("[Avatar] Remote participant(s) in room:", remotes.map(p => ({
        identity: p.identity,
        numTracks: p.trackPublications.size,
        tracks: Array.from(p.trackPublications.values() as any).map((t: any) => ({
          source: t.source,
          subscribed: t.isSubscribed,
          muted: t.isMuted,
        })),
      })));
    } else {
      console.log("[Avatar] No remote participants yet.");
    }
  }, [participants]);

  const remoteParticipants = participants.filter(p => !p.isLocal);

  if (!agentVideoTrack) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-black text-white gap-4">
        <div className="w-12 h-12 border-4 border-[#00E3AA] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xl font-medium text-[#00E3AA]">Waiting for Avatar...</p>
        <p className="text-sm text-gray-500">
          {remoteParticipants.length === 0
            ? "Agent hasn't joined this room yet. Please start a session from the main app first."
            : `Agent joined (${remoteParticipants[0].identity}), loading avatar video...`
          }
        </p>
        {remoteParticipants.length > 0 && (
          <p className="text-xs text-gray-600 max-w-sm text-center">
            Open browser DevTools (F12) → Console to see track details.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden">
      <VideoTrack 
        trackRef={agentVideoTrack} 
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
      <RoomAudioRenderer />
    </div>
  );
}

function AvatarPageInner() {
  const searchParams = useSearchParams();
  const room = searchParams.get("room");
  const avatarId = searchParams.get("avatarId");
  const openclawUrl = searchParams.get("openclawUrl");
  const gatewayToken = searchParams.get("gatewayToken");
  const sessionKey = searchParams.get("sessionKey");
  const meetingUrl = searchParams.get("meetingUrl");
  const connectionType = searchParams.get("connection_type");

  const [connectionDetails, setConnectionDetails] = useState<ConnectionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!room) {
      setError("No room specified in URL parameters.");
      return;
    }

    async function fetchToken() {
      try {
        const resp = await fetch("/api/connection-details", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomName: room,
            avatarId: avatarId || "",
            openclawUrl: openclawUrl || "",
            gatewayToken: gatewayToken || "",
            sessionKey: sessionKey || "",
            meetingUrl: meetingUrl || "",
            connection_type: connectionType || "",
          }),
        });
        
        if (!resp.ok) {
          const errText = await resp.text();
          console.error("[Avatar] API error:", errText);
          throw new Error(errText);
        }
        const data = await resp.json();
        console.log("[Avatar] Connected to room:", data.roomName, "via", data.serverUrl);
        setConnectionDetails(data);
      } catch (err: any) {
        console.error("[Avatar] Failed to fetch connection details:", err);
        setError(err.message || "Failed to connect to server.");
      }
    }

    fetchToken();
  }, [room, avatarId, openclawUrl, gatewayToken, sessionKey, connectionType, meetingUrl]);


  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-black text-red-500 p-8 text-center font-mono">
        <div>
          <h1 className="text-2xl mb-4">⚠ Connection Error</h1>
          <p className="text-base">{error}</p>
          <p className="text-xs text-red-700 mt-4 max-w-md">
            Make sure LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are set in <code>frontend/.env.local</code> and restart the dev server.
          </p>
        </div>
      </div>
    );
  }

  if (!connectionDetails) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-black text-white gap-4">
        <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin"></div>
        <p className="text-xl font-medium">Initializing Connection...</p>
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={connectionDetails.participantToken}
      serverUrl={connectionDetails.serverUrl}
      connect={true}
      audio={true}
      video={false}
      className="h-screen w-screen"
    >
      <AvatarContent />
    </LiveKitRoom>
  );
}

export default function AvatarPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen bg-black text-white">
        <p>Loading...</p>
      </div>
    }>
      <AvatarPageInner />
    </Suspense>
  );
}
