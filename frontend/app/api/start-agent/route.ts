import { NextResponse } from 'next/server';
import { db, agents, bots, profiles } from '@/drizzle';
import { eq } from 'drizzle-orm';

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

    // 3. URL-encode the openclawUrl
    const encodedUrl = encodeURIComponent(agent.openclaw_url);

    // 4. Construct the full video URL
    const baseAppUrl = process.env.APP_BASE_URL || 'https://clawdface-v2-3hfw.vercel.app';
    
    const videoUrl = `${baseAppUrl}/avatar` +
      `?room=${roomId}` +
      `&avatarId=${agent.avatar_id}` +
      `&openclawUrl=${encodedUrl}` +
      `&gatewayToken=${agent.gateway_token}` +
      `&sessionKey=${sessionKey}`;

    // 5. Optionally trigger Recall.ai automated joining
    const recallToken = process.env.RECALL_API_TOKEN;
    let recallStatus = 'skipped';
    let recallBotId = null;

    if (recallToken && meetingUrl) {
      try {
        const recallResponse = await fetch('https://api.recall.ai/api/v1/bot/', {
          method: 'POST',
          headers: {
            'Authorization': `Token ${recallToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            meeting_url: meetingUrl,
            bot_name: agent.name,
            video_url: videoUrl,
          }),
        });

        if (recallResponse.ok) {
          const recallData = await recallResponse.json();
          recallStatus = 'success';
          recallBotId = recallData.id;
        } else {
          const errorData = await recallResponse.text();
          console.error('Recall.ai Error:', errorData);
          recallStatus = 'failed';
        }
      } catch (err) {
        console.error('Failed to trigger Recall.ai:', err);
        recallStatus = 'error';
      }
    }

    return NextResponse.json({ 
      videoUrl, 
      recallStatus,
      recallBotId,
      userEmail: userEmail || null,
    });
  } catch (error: any) {
    console.error('Error starting agent:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
