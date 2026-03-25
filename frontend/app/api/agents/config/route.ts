import { NextResponse } from 'next/server';
import { db, agents } from '@/drizzle';
import { eq } from 'drizzle-orm';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');

    if (!email) {
      return NextResponse.json({ error: 'Missing email' }, { status: 400 });
    }

    console.log(`[API] Agent config lookup for: ${email}`);

    // Query the agents table for an exact match on email
    // This supports timestamped emails like sofiasbot-2026-03-18-1734clawdfaceai@agent.truhire.ai
    const [agent] = await db
      .select({
        openclawUrl: agents.openclaw_url,
        gatewayToken: agents.gateway_token,
        avatarId: agents.avatar_id,
        name: agents.name,
      })
      .from(agents)
      .where(eq(agents.email, email))
      .limit(1);

    if (!agent) {
      console.warn(`[API] Agent not found for email: [${email}]`);
      return NextResponse.json({ 
        error: 'Agent not found', 
        receivedEmail: email,
        suggestion: "Ensure the email matches EXACTLY including casing and dashes"
      }, { status: 404 });
    }

    console.log(`[API] Found config for agent: ${agent.name}`);

    return NextResponse.json(agent);
  } catch (error: any) {
    console.error('Error fetching agent config:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
