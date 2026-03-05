"use client";

import { CloseIcon } from "@/components/CloseIcon";
import { NoAgentNotification } from "@/components/NoAgentNotification";
import TranscriptionView from "@/components/TranscriptionView";
import {
  BarVisualizer,
  DisconnectButton,
  RoomAudioRenderer,
  RoomContext,
  VideoTrack,
  VoiceAssistantControlBar,
  useVoiceAssistant,
  useRoomContext,
} from "@livekit/components-react";
import { AnimatePresence, motion } from "framer-motion";
import { Room, RoomEvent } from "livekit-client";
import { useCallback, useEffect, useState } from "react";
import type { ConnectionDetails } from "./api/connection-details/route";
import { useRouter } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";

import { Sidebar } from "@/components/Sidebar";
import Image from "next/image";

export default function Page() {
  const router = useRouter();
  const [room] = useState(new Room());
  const [activeSession, setActiveSession] = useState("My Bot");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
    } else {
      setAuthChecked(true);
    }
  }, [router]);

  const onConnectButtonClicked = useCallback(async () => {
    const url = new URL(
      process.env.NEXT_PUBLIC_CONN_DETAILS_ENDPOINT ?? "/api/connection-details",
      window.location.origin
    );
    const response = await fetch(url.toString());
    const connectionDetailsData: ConnectionDetails = await response.json();

    await room.connect(connectionDetailsData.serverUrl, connectionDetailsData.participantToken);
    await room.localParticipant.setMicrophoneEnabled(true);
  }, [room]);

  useEffect(() => {
    room.on(RoomEvent.MediaDevicesError, onDeviceFailure);

    return () => {
      room.off(RoomEvent.MediaDevicesError, onDeviceFailure);
    };
  }, [room]);

  if (!authChecked) {
    return (
      <div className="h-screen w-screen bg-[#0A0A0A] flex items-center justify-center">
        <svg className="animate-spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00E3AA" strokeWidth="2">
          <circle cx="12" cy="12" r="10" opacity="0.25"/>
          <path d="M22 12a10 10 0 0 1-10 10" opacity="0.9"/>
        </svg>
      </div>
    );
  }

  return (
    <main data-lk-theme="default" className="h-[100dvh] w-screen bg-[#050505] flex overflow-hidden font-[Inter] text-white">
      <Sidebar 
         activeSession={activeSession} 
         setActiveSession={setActiveSession} 
         isMobileMenuOpen={isMobileMenuOpen}
         setIsMobileMenuOpen={setIsMobileMenuOpen}
      />
      
      <div className="flex-1 h-full w-full overflow-hidden flex flex-col relative z-0">
        {/* Mobile Header */}
        <div className="md:hidden flex items-center justify-between px-4 h-14 border-b border-white/5 bg-[#0A0A0A] shrink-0 z-10 shadow-sm">
           <div className="flex items-center gap-3">
              <div className="w-7 h-7 shrink-0 relative flex items-center justify-center rounded-lg bg-[#00E3AA]/10 text-[#00E3AA]">
                <Image src="/openclaw.png" alt="Logo" width={18} height={18} className="object-contain drop-shadow-[0_0_4px_rgba(0,227,170,0.5)]" />
              </div>
              <span className="text-white font-[SpaceGrotesk] font-bold text-lg leading-none tracking-tight mt-1">ClawdFace</span>
           </div>
           
           <button 
             onClick={() => setIsMobileMenuOpen(true)}
             className="text-white/70 hover:text-white p-2 rounded-md transition-colors"
           >
             <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="18" y2="18"/></svg>
           </button>
        </div>

        <div className="flex-1 overflow-hidden relative">
          <RoomContext.Provider value={room}>
            {activeSession === "My Bot" ? (
               <SimpleVoiceAssistant onConnectButtonClicked={onConnectButtonClicked} />
            ) : (
               <div className="flex flex-col items-center justify-center h-full text-neutral-400 bg-[#050505] p-6">
                  <div className="text-center space-y-4 max-w-md p-8 border border-white/5 rounded-2xl bg-[#0A0A0A] shadow-2xl relative overflow-hidden">
                    {/* Subtle glow effect behind card */}
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-32 bg-[#00E3AA]/5 rounded-full blur-3xl mix-blend-screen pointer-events-none"></div>

                    <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-6 text-[#00E3AA] relative z-10">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
                    </div>
                    <h2 className="text-2xl font-[SpaceGrotesk] font-bold text-white tracking-tight relative z-10">Session Empty</h2>
                    <p className="text-[15px] leading-relaxed relative z-10">The <span className="text-white font-medium">"{activeSession}"</span> session is currently under development.</p>
                    <button 
                       onClick={() => setActiveSession("My Bot")}
                       className="relative z-10 mt-6 px-5 py-2.5 bg-[#00E3AA]/10 hover:bg-[#00E3AA]/20 text-[#00E3AA] rounded-lg font-medium transition-all duration-300 text-sm border border-[#00E3AA]/20 shadow-[0_0_12px_rgba(0,227,170,0.05)] hover:shadow-[0_0_20px_rgba(0,227,170,0.15)]"
                    >
                       Return to My Bot
                    </button>
                  </div>
               </div>
            )}
          </RoomContext.Provider>
        </div>
      </div>
    </main>
  );
}


function SimpleVoiceAssistant(props: { onConnectButtonClicked: () => void }) {
  const { state: agentState } = useVoiceAssistant();
  const [isChatVisible, setIsChatVisible] = useState(false);
  const [chatWidth, setChatWidth] = useState(450);
  const [isDragging, setIsDragging] = useState(false);
  
  const MIN_WIDTH = 300;
  const MAX_WIDTH = 800;

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      // Calculate width from the right edge of the screen
      const newWidth = document.documentElement.clientWidth - moveEvent.clientX;
      setChatWidth(Math.min(Math.max(newWidth, MIN_WIDTH), MAX_WIDTH));
    };

    const handlePointerUp = () => {
      setIsDragging(false);
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
  };

  return (
    <div className={`h-screen w-full overflow-hidden bg-[#050505] ${isDragging ? 'select-none' : ''}`}>

      <AnimatePresence mode="wait">
        {agentState === "disconnected" ? (
          <motion.div
            key="disconnected"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.3, ease: [0.09, 1.04, 0.245, 1.055] }}
            className="flex items-center justify-center h-full"
          >
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="uppercase px-8 py-4 bg-white text-black rounded-2xl font-bold shadow-2xl transition-all"
              onClick={() => props.onConnectButtonClicked()}
            >
              Start a conversation
            </motion.button>
          </motion.div>
        ) : (
          <motion.div
            key="connected"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex h-full w-full"
          >
            {/* Left Main Area: Agent and Controls */}
            <main className="flex-1 h-full flex flex-col relative bg-[#000000]">
              <div className="flex-1 flex items-center justify-center p-12">
                <AgentVisualizer />
              </div>
              
              <div className="absolute bottom-12 left-0 right-0 flex justify-center">
                 <ControlBar 
                    onConnectButtonClicked={props.onConnectButtonClicked} 
                    isChatVisible={isChatVisible}
                    setIsChatVisible={setIsChatVisible}
                 />
              </div>
            </main>

            {/* Right Sidebar: Chat */}
            <motion.aside 
                initial={false}
                animate={{ 
                    width: isChatVisible ? chatWidth : 0, 
                    opacity: isChatVisible ? 1 : 0 
                }}
                transition={{ 
                   duration: isDragging ? 0 : 0.3, 
                   ease: "easeInOut" 
                }}
                className="relative min-w-0 h-full border-l border-white/5 bg-black/10 backdrop-blur-md overflow-hidden flex-shrink-0"
            >
                {/* Drag Handle */}
                {isChatVisible && (
                  <div 
                    onPointerDown={handlePointerDown}
                    className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-white/10 active:bg-white/20 transition-colors"
                  />
                )}
                <div style={{ width: chatWidth }} className="h-full">
                  <TranscriptionView />
                </div>
            </motion.aside>

            <RoomAudioRenderer />
            <NoAgentNotification state={agentState} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AgentVisualizer() {
  const { state: agentState, videoTrack, audioTrack } = useVoiceAssistant();

  if (videoTrack) {
    return (
      <div className="w-full max-w-5xl mx-auto aspect-video rounded-2xl overflow-hidden border border-white/10 shadow-2xl bg-black/50 transition-all duration-300">
        <VideoTrack trackRef={videoTrack} className="w-full h-full object-cover" />
      </div>
    );
  }
  return (
    <div className="h-[300px] w-full max-w-2xl mx-auto flex items-center justify-center">
      <BarVisualizer
        state={agentState}
        barCount={5}
        trackRef={audioTrack}
        className="agent-visualizer"
        options={{ minHeight: 24 }}
      />
    </div>
  );
}

const MicIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
);

const MicOffIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
);

const CameraIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>
);

const MessageIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
);

const ChevronDownIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
);

const CrossIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
);

function ControlBar(props: { 
  onConnectButtonClicked: () => void,
  isChatVisible: boolean,
  setIsChatVisible: (visible: boolean) => void
}) {
  const { state: agentState } = useVoiceAssistant();
  const room = useRoomContext();
  const [isMicEnabled, setIsMicEnabled] = useState(true);

  const toggleMic = async () => {
    const enabled = !isMicEnabled;
    setIsMicEnabled(enabled);
    await room.localParticipant.setMicrophoneEnabled(enabled);
  };

  if (agentState === "disconnected" || agentState === "connecting") {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.4, ease: [0.09, 1.04, 0.245, 1.055] }}
      className="flex items-center gap-4"
    >
      {/* Mic Pill */}
      <div className="control-pill">
        <button onClick={toggleMic} className="control-button-white">
          {isMicEnabled ? <MicIcon /> : <MicOffIcon />}
        </button>
        <div className="control-dropdown-part">
          <ChevronDownIcon />
        </div>
      </div>

      {/* Chat Toggle Circle */}
      <button 
        onClick={() => props.setIsChatVisible(!props.isChatVisible)}
        className={`control-circle ${props.isChatVisible ? 'active' : ''}`}
      >
        <MessageIcon />
      </button>

      {/* Disconnect Circle */}
      <DisconnectButton className="disconnect-circle">
        <CrossIcon />
      </DisconnectButton>
    </motion.div>
  );
}

function onDeviceFailure(error: Error) {
  console.error(error);
  alert(
    "Error acquiring camera or microphone permissions. Please make sure you grant the necessary permissions in your browser and reload the tab"
  );
}
