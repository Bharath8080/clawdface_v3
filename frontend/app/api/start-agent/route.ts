import { NextResponse } from 'next/server';
// This API handles generating meeting URLs for an agent and explicitly dispatching the agent to the LiveKit room.
import { db, agents, bots, profiles } from '@/drizzle';
import { eq } from 'drizzle-orm';
import { RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk';

// Helper for timestamp-based IDs
function generateTimestampId(prefix: string): string {
  const now = new Date();
  const format = now.toISOString()
    .slice(0, 19) // YYYY-MM-DDTHH:mm:ss
    .replace(/:/g, '-');
  return `${prefix}-${format}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, meetingUrl, startTime } = body;

    if (!email) {
      return NextResponse.json({ error: 'Missing email' }, { status: 400 });
    }

    // 1. Fetch agent config AND owner email from DB using email
    const [result] = await db
      .select({
        agent: agents,
        userEmail: profiles.email,
      })
      .from(agents)
      .leftJoin(bots, eq(agents.bot_id, bots.id))
      .leftJoin(profiles, eq(bots.user_id, profiles.id))
      .where(eq(agents.email, email))
      .limit(1);

    if (!result || !result.agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const { agent, userEmail } = result;

    // 2. Auto-generate roomId and sessionKey
    const roomId = generateTimestampId('room');
    const sessionKey = generateTimestampId('session');

    // 3. Explicitly create room and dispatch agent
    const API_KEY     = process.env.LIVEKIT_API_KEY;
    const API_SECRET  = process.env.LIVEKIT_API_SECRET;
    const LIVEKIT_URL = process.env.LIVEKIT_URL;

    if (!LIVEKIT_URL || !API_KEY || !API_SECRET) {
      return NextResponse.json({ error: 'LiveKit configuration is missing' }, { status: 500 });
    }

    const roomService = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);
    const dispatchClient = new AgentDispatchClient(LIVEKIT_URL, API_KEY, API_SECRET);

    try {
      await roomService.createRoom({
        name: roomId,
        emptyTimeout: 10 * 60, // 10 minutes
        maxParticipants: 10,
      });

      const metadata = JSON.stringify({
        openclawUrl: agent.openclaw_url || "",
        gatewayToken: agent.gateway_token || "",
        sessionKey: sessionKey || "",
        avatarId: agent.avatar_id || "",
      });

      await dispatchClient.createDispatch(roomId, "clawdface", { metadata });
      console.log(`[start-agent] Explicitly dispatched 'clawdface' to room ${roomId}`);
    } catch (err: any) {
      console.error("[start-agent] Failed to create room or dispatch agent:", err);
      // It's critical the agent is dispatched, fail the request if it doesn't work.
      return NextResponse.json({ error: 'Failed to deploy agent to room: ' + err.message }, { status: 500 });
    }

    // 4. URL-encode the openclawUrl
    const encodedUrl = encodeURIComponent(agent.openclaw_url);

    // 5. Construct the full video URL
    const baseAppUrl = process.env.NEXT_PUBLIC_APP_URL;

    if (!baseAppUrl) {
      return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL configuration is missing' }, { status: 500 });
    }
    
    const videoUrl = `${baseAppUrl}/avatar` +
      `?room=${roomId}` +
      `&avatarId=${agent.avatar_id}` +
      `&openclawUrl=${encodedUrl}` +
      `&gatewayToken=${agent.gateway_token}` +
      `&sessionKey=${sessionKey}`;

    // 5. Return metadata to the caller (external system handles Recall.ai)
    return NextResponse.json({ 
      videoUrl, 
      userEmail: userEmail || null,
      agentName: agent.name,
      avatarId: agent.avatar_id,
      roomId,
      sessionKey
    });
  } catch (error: any) {
    console.error('Error starting agent:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
