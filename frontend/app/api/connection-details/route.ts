import { AccessToken, AccessTokenOptions, VideoGrant } from "livekit-server-sdk";
import { NextResponse } from "next/server";

const API_KEY     = process.env.LIVEKIT_API_KEY!;
const API_SECRET  = process.env.LIVEKIT_API_SECRET!;
const LIVEKIT_URL = process.env.LIVEKIT_URL!;

export const revalidate = 0;

export type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
};

export async function GET() {
  return handleConnection({});
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return handleConnection(body);
}

async function handleConnection(config: {
  openclawUrl?: string;
  gatewayToken?: string;
  sessionKey?: string;
}) {
  try {
    if (!LIVEKIT_URL) throw new Error("LIVEKIT_URL is not defined");
    if (!API_KEY)     throw new Error("LIVEKIT_API_KEY is not defined");
    if (!API_SECRET)  throw new Error("LIVEKIT_API_SECRET is not defined");

    const participantIdentity = `user_${Math.floor(Math.random() * 10_000)}`;
    const roomName = `clawdface_room_${Math.floor(Math.random() * 10_000)}`;

    // Embed session config in participant token metadata so the agent can read it
    const metadata = JSON.stringify({
      openclawUrl:  config.openclawUrl  || "",
      gatewayToken: config.gatewayToken || "",
      sessionKey:   config.sessionKey   || "",
    });

    console.log(`[connection-details] Room: ${roomName}`);
    console.log(`[connection-details] Session Key: ${config.sessionKey || "(default)"}`);

    const participantToken = await createParticipantToken(
      { identity: participantIdentity, metadata },
      roomName
    );

    return NextResponse.json(
      {
        serverUrl: LIVEKIT_URL,
        roomName,
        participantToken,
        participantName: participantIdentity,
      } as ConnectionDetails,
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error("[connection-details]", error.message);
      return new NextResponse(error.message, { status: 500 });
    }
  }
}

function createParticipantToken(
  userInfo: AccessTokenOptions & { metadata?: string },
  roomName: string
) {
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: userInfo.identity,
    ttl: "15m",
  });
  at.metadata = userInfo.metadata || "";
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });
  return at.toJwt();
}
