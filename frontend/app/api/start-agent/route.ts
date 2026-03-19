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
