import { NextResponse } from 'next/server';
import { db, agents, bots, profiles } from '@/drizzle';
import { eq } from 'drizzle-orm';
import { RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk';
 
function generateTimestampId(prefix: string): string {
  const now = new Date();
  const format = now.toISOString()
    .slice(0, 19)
    .replace(/:/g, '-');
  return `${prefix}-${format}`;
}
 
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, meetingUrl, startTime, roomId: requestedRoomId } = body;
 
    if (!email) {
      return NextResponse.json({ error: 'Missing email' }, { status: 400 });
    }
 
    const [result] = await db
      .select({ agent: agents, userEmail: profiles.email })
      .from(agents)
      .leftJoin(bots, eq(agents.bot_id, bots.id))
      .leftJoin(profiles, eq(bots.user_id, profiles.id))
      .where(eq(agents.email, email))
      .limit(1);
 
    if (!result || !result.agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
 
    const { agent, userEmail } = result;
 
    const roomId     = requestedRoomId || generateTimestampId('room');
    const sessionKey = generateTimestampId('session');
 
    const API_KEY     = process.env.LIVEKIT_API_KEY;
    const API_SECRET  = process.env.LIVEKIT_API_SECRET;
    const LIVEKIT_URL = process.env.LIVEKIT_URL;
 
    if (!LIVEKIT_URL || !API_KEY || !API_SECRET) {
      return NextResponse.json({ error: 'LiveKit configuration is missing' }, { status: 500 });
    }
 
    const roomService    = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);
    const dispatchClient = new AgentDispatchClient(LIVEKIT_URL, API_KEY, API_SECRET);
 
    const createdRoom = await roomService.createRoom({
      name: roomId,
      emptyTimeout: 10 * 60,
      maxParticipants: 10,
    });
    
    // Strictly rely on the LiveKit internal SID (RM_...) without fallback
    const lkRoomSid = createdRoom.sid;
 
    const metadata = JSON.stringify({
      openclawUrl:  agent.openclaw_url  || '',
      gatewayToken: agent.gateway_token || '',
      sessionKey:   sessionKey          || '',
      avatarId:     agent.avatar_id     || '',
      meetingUrl:   meetingUrl          || '',
      agentName:    agent.name          || 'AI Assistant',
      recallBotId:  '',
      roomId:       roomId, // Use room name for metadata alignment
    });
 
    await dispatchClient.createDispatch(roomId, 'clawdface', { metadata });
    console.log(`[start-agent] ✓ Dispatched → room=${roomId} bot=none`);
 
    const baseAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!baseAppUrl) {
      return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL not configured' }, { status: 500 });
    }
 
    const videoUrl =
      `${baseAppUrl}/avatar` +
      `?room=${roomId}` + // Use room name for avatar join
      `&avatarId=${agent.avatar_id}` +
      `&openclawUrl=${encodeURIComponent(agent.openclaw_url)}` +
      `&gatewayToken=${agent.gateway_token}` +
      `&sessionKey=${sessionKey}`;
 
    return NextResponse.json({
      videoUrl,
      userEmail:   userEmail  || null,
      agentName:   agent.name,
      avatarId:    agent.avatar_id,
      roomId:      roomId, // Return room name for Go relay key
      roomSid:     lkRoomSid, // Maintain SID for reference if needed
      roomName:    roomId,
      sessionKey,
    });
 
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[start-agent] Unhandled error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}