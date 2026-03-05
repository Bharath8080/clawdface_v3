import useCombinedTranscriptions from "@/hooks/useCombinedTranscriptions";
import * as React from "react";

export default function TranscriptionView() {
  const combinedTranscriptions = useCombinedTranscriptions();
  const containerRef = React.useRef<HTMLDivElement>(null);

  // scroll to bottom when new transcription is added
  React.useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [combinedTranscriptions]);

  return (
    <div className="flex flex-col h-full w-full bg-black/20 overflow-hidden">
      <div className="p-8 pb-4 shrink-0">
         <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">Streaming Flow</span>
      </div>

      <div 
        ref={containerRef} 
        className="flex-1 overflow-y-auto px-8 py-4 scroll-smooth flex flex-col gap-6"
      >
        {combinedTranscriptions.length === 0 && (
          <div className="flex-1 flex items-center justify-center opacity-20 italic text-sm">
            Waiting for conversation...
          </div>
        )}

        {combinedTranscriptions.map((segment) => (
          <div
            key={segment.id}
            className={`bubble-container ${
              segment.role === "assistant" ? "self-start" : "self-end items-end"
            }`}
          >
            <span className={`bubble-label ${segment.role === "assistant" ? "text-left" : "text-right"}`}>
              {segment.role === "assistant" ? "Agent" : "You"}
            </span>
            <div
              className={
                segment.role === "assistant"
                  ? "agent-bubble"
                  : "user-bubble"
              }
            >
              {segment.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
