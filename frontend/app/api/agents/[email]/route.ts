import { NextResponse } from 'next/server';
import { db, agents, bots, profiles } from '@/drizzle';
import { eq } from 'drizzle-orm';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ email: string }> }
) {
  try {
    const { email } = await params;

    if (!email) {
      return NextResponse.json({ error: 'Missing email parameter' }, { status: 400 });
    }

    // Join agents -> bots -> profiles to get the owner email
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

    return NextResponse.json({
      id: agent.id,
      email: agent.email,
      name: agent.name,
      avatarId: agent.avatar_id,
      openclawUrl: agent.openclaw_url,
      gatewayToken: agent.gateway_token,
      agentType: agent.agent_type,
      config: agent.config,
      userEmail: userEmail || null, // The owner's email
      created_at: agent.created_at,
      updated_at: agent.updated_at,
    });
  } catch (error: any) {
    console.error('Error fetching agent:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
