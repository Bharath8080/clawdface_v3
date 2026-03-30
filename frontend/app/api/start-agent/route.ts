import { NextResponse } from 'next/server';
import { db, agents, bots, profiles } from '@/drizzle';
import { eq } from 'drizzle-orm';
import { RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateTimestampId(prefix: string): string {
  const now = new Date();
  const format = now.toISOString()
    .slice(0, 19) // YYYY-MM-DDTHH:mm:ss
    .replace(/:/g, '-');
  return `${prefix}-${format}`;
}

// ---------------------------------------------------------------------------
// POST /api/start-agent
//
// Called when an email-triggered meeting begins.
// 1. Fetches agent config from DB
// 2. Creates a LiveKit room and dispatches the agent
// 3. If a meetingUrl is provided, creates a Recall.ai bot to join that meeting
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, meetingUrl, startTime } = body;

    if (!email) {
      return NextResponse.json({ error: 'Missing email' }, { status: 400 });
    }

    // 1. Fetch agent config from DB
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

    // 2. Generate room + session identifiers
    const roomId     = generateTimestampId('room');
    const sessionKey = generateTimestampId('session');

    // 3. LiveKit credentials
    const API_KEY     = process.env.LIVEKIT_API_KEY;
    const API_SECRET  = process.env.LIVEKIT_API_SECRET;
    const LIVEKIT_URL = process.env.LIVEKIT_URL;

    if (!LIVEKIT_URL || !API_KEY || !API_SECRET) {
      return NextResponse.json({ error: 'LiveKit configuration is missing' }, { status: 500 });
    }

    const roomService    = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);
    const dispatchClient = new AgentDispatchClient(LIVEKIT_URL, API_KEY, API_SECRET);

    // 4. Create LiveKit room
    await roomService.createRoom({
      name: roomId,
      emptyTimeout: 10 * 60, // auto-close after 10 minutes of silence
      maxParticipants: 10,
    });

    // 6. Dispatch happens AFTER Recall bot creation so we can include recallBotId in metadata.
    //    See step 6b below.

    // 7. If a meetingUrl is provided, create a Recall.ai bot to join the external meeting
    let recallBotId: string | null = null;

    if (meetingUrl) {
      // Fallback to known Recall.ai endpoint if env var not set
      const recallApiUrl  = process.env.EXTERNAL_MEETINGS_API_URL || 'https://us-west-2.recall.ai/api/v1/bot/';
      const recallToken   = process.env.EXTERNAL_MEETINGS_API_TOKEN;
      const recallEndpoint = process.env.EXTERNAL_MEETINGS_WEBHOOK_URL; // may be wss:// or https://

      if (!recallToken) {
        console.warn('[start-agent] EXTERNAL_MEETINGS_API_TOKEN not set — skipping Recall.ai bot');
      } else {
        try {
          const recallBody: Record<string, unknown> = {
            meeting_url: meetingUrl,
            bot_name: agent.name || 'AI Assistant',
            metadata: { roomId },
            recording_config: {
              transcript: {
                provider: {
                  recallai_streaming: {
                    mode: 'prioritize_low_latency',
                    language_code: 'en',
                  },
                }
              },
            },
          };



          // Register the relay as a real-time endpoint on the bot.
          // Note: Recall.ai 'realtime' transcripts typically use the Webhook (POST) method.
          // Even if the agent connects via WSS, the Bot must push via HTTP.
          if (recallEndpoint) {
            // Map the relay URL to its HTTP webhook counterpart for ingestion.
            // e.g. wss://recall.trugen.ai/ws -> https://recall.trugen.ai/api/v1/webhook
            let endpointUrl = recallEndpoint
              .replace('wss://', 'https://')
              .replace('ws://', 'http://')
              .replace(/\/ws$/, '/api/v1/webhook');
            
            // Append the room_id so the relay knows where to route the events.
            endpointUrl = `${endpointUrl}${endpointUrl.includes('?') ? '&' : '?'}room_id=${encodeURIComponent(roomId)}`;

            recallBody.recording_config = {
              ...(recallBody.recording_config as object),
              realtime_endpoints: [
                {
                  type: 'webhook',
                  url: endpointUrl,
                  events: [
                    'transcript.data',
                    'transcript.partial_data',
                    'participant_events.join',
                    'participant_events.leave',
                  ],
                },
              ],
            };
            console.log(`[start-agent] Recall.ai realtime webhook endpoint: ${endpointUrl}`);
          }


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
            console.log(`[start-agent] Recall.ai bot created: ${recallBotId}`);
          } else {
            const errText = await recallResp.text();
            console.error(
              `[start-agent] Recall.ai bot creation failed (${recallResp.status}): ${errText}`
            );
          }
        } catch (recallErr: unknown) {
          console.error('[start-agent] Recall.ai request error:', recallErr);
        }
      }
    }

    // 6b. Dispatch the agent — NOW we include recallBotId so the relay can route by bot_id too
    const metadata = JSON.stringify({
      openclawUrl:    agent.openclaw_url  || '',
      gatewayToken:   agent.gateway_token || '',
      sessionKey:     sessionKey          || '',
      avatarId:       agent.avatar_id     || '',
      meetingUrl:     meetingUrl          || '',
      agentName:      agent.name          || 'AI Assistant',
      recallBotId:    recallBotId         || '',   // relay fallback routing key
    });

    await dispatchClient.createDispatch(roomId, 'clawdface', { metadata });
    console.log(`[start-agent] Agent dispatched to room ${roomId} (recallBotId=${recallBotId ?? 'none'})`);

    // 8. Build the video URL (used by the email / caller to display the avatar)
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
      recallBotId,   // null when no meetingUrl provided
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[start-agent] Unhandled error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
