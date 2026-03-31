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
    const { email, meetingUrl, startTime } = body;
 
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
 
    const roomId     = generateTimestampId('room');
    const sessionKey = generateTimestampId('session');
 
    const API_KEY     = process.env.LIVEKIT_API_KEY;
    const API_SECRET  = process.env.LIVEKIT_API_SECRET;
    const LIVEKIT_URL = process.env.LIVEKIT_URL;
 
    if (!LIVEKIT_URL || !API_KEY || !API_SECRET) {
      return NextResponse.json({ error: 'LiveKit configuration is missing' }, { status: 500 });
    }
 
    const roomService    = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);
    const dispatchClient = new AgentDispatchClient(LIVEKIT_URL, API_KEY, API_SECRET);
 
    await roomService.createRoom({
      name: roomId,
      emptyTimeout: 10 * 60,
      maxParticipants: 10,
    });
 
    let recallBotId: string | null = null;
 
    if (meetingUrl) {
      const recallApiUrl = process.env.EXTERNAL_MEETINGS_API_URL || 'https://us-west-2.recall.ai/api/v1/bot/';
      const recallToken  = process.env.EXTERNAL_MEETINGS_API_TOKEN;
 
      // Relay: Recall.ai POSTs here, relay forwards to agent WS by room_id
      // env EXTERNAL_MEETINGS_WEBHOOK_URL = https://recall.trugen.ai/webhook
      const relayBase = (process.env.EXTERNAL_MEETINGS_WEBHOOK_URL || 'https://recall.trugen.ai/webhook')
        .replace(/^wss?:\/\//, 'https://')
        .replace(/\/ws$/, '/webhook');
 
      const webhookUrl = `${relayBase}?room_id=${encodeURIComponent(roomId)}`;
      console.log(`[start-agent] Recall webhook: ${webhookUrl}`);
 
      if (!recallToken) {
        console.warn('[start-agent] EXTERNAL_MEETINGS_API_TOKEN not set');
      } else {
        try {
          const recallBody = {
            meeting_url: meetingUrl,
            bot_name: agent.name || 'AI Assistant',
            recording_config: {
              transcript: {
                provider: {
                  // "recallai" = Recall.ai native STT (correct key per docs)
                  recallai: {},
                },
              },
              // CRITICAL: correct field name is "real_time_endpoints" with underscore
              // Previous versions used "realtime_endpoints" (no underscore) — WRONG
              real_time_endpoints: [
                {
                  type: 'webhook',
                  url: webhookUrl,
                  // Only use officially documented event names.
                  // "transcript.partial_data" is NOT in the official list — omit it.
                  events: [
                    'transcript.data',
                    'participant_events.join',
                    'participant_events.leave',
                    'participant_events.speech_on',
                    'participant_events.speech_off',
                  ],
                },
              ],
            },
          };
 
          console.log('[start-agent] Bot payload:', JSON.stringify(recallBody, null, 2));
 
          const recallResp = await fetch(recallApiUrl, {
            method: 'POST',
            headers: {
              Authorization:  `Token ${recallToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(recallBody),
          });
 
          if (recallResp.ok) {
            const recallBot = await recallResp.json() as { id: string };
            recallBotId = recallBot.id;
            console.log(`[start-agent] ✓ Bot created: ${recallBotId}`);
          } else {
            const errText = await recallResp.text();
            console.error(`[start-agent] ✗ Bot creation FAILED (${recallResp.status}): ${errText}`);
          }
        } catch (err: unknown) {
          console.error('[start-agent] Recall request error:', err);
        }
      }
    }
 
    const metadata = JSON.stringify({
      openclawUrl:  agent.openclaw_url  || '',
      gatewayToken: agent.gateway_token || '',
      sessionKey:   sessionKey          || '',
      avatarId:     agent.avatar_id     || '',
      meetingUrl:   meetingUrl          || '',
      agentName:    agent.name          || 'AI Assistant',
      recallBotId:  recallBotId         || '',
    });
 
    await dispatchClient.createDispatch(roomId, 'clawdface', { metadata });
    console.log(`[start-agent] ✓ Dispatched → room=${roomId} bot=${recallBotId ?? 'none'}`);
 
    const baseAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!baseAppUrl) {
      return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL not configured' }, { status: 500 });
    }
 
    const videoUrl =
      `${baseAppUrl}/avatar` +
      `?room=${roomId}` +
      `&avatarId=${agent.avatar_id}` +
      `&openclawUrl=${encodeURIComponent(agent.openclaw_url)}` +
      `&gatewayToken=${agent.gateway_token}` +
      `&sessionKey=${sessionKey}`;
 
    return NextResponse.json({
      videoUrl,
      userEmail:   userEmail  || null,
      agentName:   agent.name,
      avatarId:    agent.avatar_id,
      roomId,
      sessionKey,
      recallBotId,
    });
 
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[start-agent] Unhandled error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}