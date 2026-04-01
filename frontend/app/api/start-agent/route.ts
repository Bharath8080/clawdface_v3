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
 
    const livekitRoom = await roomService.createRoom({
      name: roomId,
      emptyTimeout: 10 * 60,
      maxParticipants: 10,
    });
 
    let recallBotId: string | null = null;
 
    if (meetingUrl) {
      const recallApiUrl = (process.env.EXTERNAL_MEETINGS_API_URL || 'https://us-west-2.recall.ai/api/v1/bot').replace(/\/$/, '');
      const recallToken  = process.env.EXTERNAL_MEETINGS_API_TOKEN;
 
      const relayBase = process.env.EXTERNAL_MEETINGS_WEBHOOK_URL || '';
 
      const webhookUrl = `${relayBase}?room_id=${encodeURIComponent(roomId)}`;
      if (!relayBase) {
        throw new Error('EXTERNAL_MEETINGS_WEBHOOK_URL is missing. If you just added it to .env.local, please restart the Next.js dev server!');
      }
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
                  recallai_streaming: {
                    mode: 'prioritize_low_latency',
                    language_code: 'en',
                  },
                },
              },
              realtime_endpoints: [
                {
                  type: 'webhook',
                  url: webhookUrl,
                  events: [
                    'transcript.data',
                    'transcript.partial_data',
                    'participant_events.join',
                    'participant_events.leave',
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
            console.log(`[start-agent] \u2713 Recall.ai bot created successfully: ${recallBotId}`);
          } else {
            let errDetail = '';
            try {
              errDetail = await recallResp.text();
            } catch {
              errDetail = 'Could not read error response body';
            }
            console.error(`[start-agent] \u2717 Recall.ai API Failure | Status: ${recallResp.status} ${recallResp.statusText} | Detail: ${errDetail}`);
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[start-agent] \u2717 Network error contacting Recall.ai: ${errMsg}`);
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
      roomId:      roomId,
      sessionKey,
      recallBotId,
    });
 
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[start-agent] Unhandled error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}